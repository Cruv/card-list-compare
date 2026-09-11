"""Bounded station telemetry and durable, idempotent operator controls.

The server can request fixed actions; it cannot supply printer options, paths,
scripts or update URLs. All printing remains in clc_print_station.Station.
"""
import datetime
import hashlib
import json
import re
import subprocess
import time
import uuid

from clc_print_station import StationError, checked_id, recipe_fingerprint
from clc_station_alerts import (DISCORD_SETTING, DISCORD_TEST_SETTING, validate_alert_config,
                                effective_alert_config, discord_status, discord_test_payload)


CONTROL_TYPES = {"pause", "unpause", "resume", "check_update", "update", "rollback", "configure_discord", "test_discord"}


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


class StationControl:
    def __init__(self, station, version, manager=None):
        self.station, self.config, self.ledger = station, station.config, station.ledger
        self.version, self.restart_needed = version, False
        self.health = {"ok": False, "message": "Printer check pending"}
        self.last_doctor = None
        self.update = {"supported": False, "currentVersion": version, "previousVersion": None,
                       "availableVersion": None, "status": "unsupported", "error": None}
        if manager is None:
            try:
                import clc_station_manager
                manager = clc_station_manager
            except ImportError:
                pass  # A source checkout can report/control without a managed install.
        self.manager = manager
        self.ledger.db.executescript("""
          CREATE TABLE IF NOT EXISTS control_receipts (
            id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
            message TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS station_log (
            id TEXT PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
        """)
        self.refresh_update()
        # A manager operation may have selected a version just before a crash.
        # Reconcile its durable target instead of executing the command again.
        for row in self.ledger.db.execute("SELECT * FROM control_receipts WHERE state='processing'").fetchall():
            request = json.loads(row["payload"])
            if request.get("type") == "test_discord":
                self.complete_discord_test(row["id"], request.get("revision"), False)
                continue
            applied = request.get("type") in {"update", "rollback"} and request.get("targetVersion") == self.update.get("currentVersion")
            self.finish(row["id"], "applied" if applied else "rejected",
                        "Requested version is installed; station remains paused" if applied
                        else "Update was interrupted. Check the installed version before requesting another update.")
        self.event("info", "Print station started (" + version + ")")

    def safe_message(self, value):
        text = str(value).replace(str(self.config.get("token", "")), "[credential]") if self.config.get("token") else str(value)
        text = re.sub(r"https://discord(?:app)?\.com/api/webhooks/[^\s]+", "[Discord webhook]", text)
        text = re.sub(r"(?i)bearer\s+\S+", "Bearer [credential]", text)
        return re.sub(r"[\x00-\x1f\x7f]", " ", text)[:500]

    def event(self, level, message):
        message = self.safe_message(message)
        latest = self.ledger.db.execute("SELECT level,message FROM station_log ORDER BY rowid DESC LIMIT 1").fetchone()
        if latest and latest["level"] == level and latest["message"] == message:
            return
        with self.ledger.db:
            self.ledger.db.execute("INSERT INTO station_log VALUES(?,?,?,?)", (uuid.uuid4().hex, timestamp(), level, message))
            self.ledger.db.execute("DELETE FROM station_log WHERE rowid NOT IN (SELECT rowid FROM station_log ORDER BY rowid DESC LIMIT 200)")

    def refresh_update(self):
        if self.manager:
            try:
                value = self.manager.managed_status(self.config)
                if value.get("supported"):
                    self.update.update({key: value.get(key) for key in self.update if key in value})
            except (OSError, ValueError, RuntimeError) as error:
                self.update.update(status="failed", error=self.safe_message(error))
        return self.update

    def check_printer(self):
        if self.last_doctor is not None and time.monotonic() - self.last_doctor < 60:
            return
        previous = self.health
        try:
            self.station.cups.doctor()
            self.health = {"ok": True, "message": "Printer queue and configured options are available"}
        except (StationError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            self.health = {"ok": False, "message": self.safe_message(error)}
        self.last_doctor = time.monotonic()
        if previous != self.health:
            self.event("info" if self.health["ok"] else "error", self.health["message"])

    def snapshot(self):
        current = self.ledger.current()
        if current:
            active = {"id": current["id"], "state": current["state"]}
            pending = next((row for row in self.ledger.passes(current["id"]) if row["state"] != "completed"), None)
            if pending:
                active.update(artifactId=pending["artifact_id"], phase=pending["phase"])
            if pending and pending["state"] in {"intent", "submitted", "uncertain"}:
                active["state"] = {"intent": "submitting"}.get(pending["state"], pending["state"])
        else:
            active = None
        return {"version": self.version, "paused": self.ledger.paused(), "queue": self.config["queue"],
                "recipeVerified": bool(self.config.get("recipe_verified")),
                "duplexVerified": bool(self.config.get("duplex_verified")),
                "testPrintingEnabled": self.config.get("allow_unverified_printing") is True,
                "recipeFingerprint": recipe_fingerprint(self.config), "activeJob": active,
                "health": self.health, "update": self.update,
                "discord": discord_status(self.ledger, self.config),
                "events": [dict(row) for row in self.ledger.db.execute("SELECT * FROM station_log ORDER BY rowid DESC LIMIT 20")],
                "receipts": [{"commandId": row["id"], "status": row["state"], "message": row["message"]}
                             for row in self.ledger.db.execute("SELECT * FROM control_receipts WHERE acknowledged=0 AND state!='processing' ORDER BY rowid LIMIT 20")]}

    def finish(self, command_id, state, message):
        self.ledger.write("UPDATE control_receipts SET state=?,message=? WHERE id=?",
                          (state, self.safe_message(message), command_id))

    def apply(self, request):
        if not isinstance(request, dict):
            raise StationError("Invalid station control")
        command_id = checked_id(request.get("id"), "control ID")
        kind = request.get("type")
        if kind in {"configure_discord", "test_discord"}:
            return self.apply_discord(request, command_id)
        payload = json.dumps({key: request.get(key) for key in ("type", "jobId", "artifactId", "paperReloaded", "targetVersion")}, sort_keys=True)
        prior = self.ledger.db.execute("SELECT * FROM control_receipts WHERE id=?", (command_id,)).fetchone()
        if prior:
            if prior["payload"] != payload:
                raise StationError("Previously seen control changed its requested action")
            return  # Durable receipt is sent again, never replay the side effect.
        rejection = None
        try:
            expires = datetime.datetime.fromisoformat(request["expiresAt"].replace("Z", "+00:00"))
            if expires.tzinfo is None or expires.timestamp() <= time.time():
                rejection = "Control expired before this Mac could apply it"
        except (KeyError, ValueError, TypeError, AttributeError):
            rejection = "Control has no valid expiry"
        if kind not in CONTROL_TYPES:
            rejection = "Unsupported station control"
        with self.ledger.db:
            self.ledger.db.execute("INSERT INTO control_receipts(id,payload,state,message) VALUES(?,?,?,?)",
                                   (command_id, payload, "rejected" if rejection else "processing", rejection or "Applying control"))
            if not rejection and kind in {"pause", "unpause", "resume"}:
                try:
                    if kind == "resume":
                        if request.get("paperReloaded") is not True:
                            raise StationError("Explicit confirmation that this batch was flipped and reloaded is required")
                        current = self.ledger.current()
                        if not current or current["id"] != request.get("jobId") or current["state"] != "awaiting_refeed":
                            raise StationError("This batch is no longer waiting for paper reload")
                        pending = next((row for row in self.ledger.passes(current["id"]) if row["state"] != "completed"), None)
                        if (not pending or pending["phase"] != "backs" or pending["state"] != "pending"
                                or pending["artifact_id"] != request.get("artifactId")):
                            raise StationError("The paper reload request belongs to a different back pass")
                        self.ledger.db.execute("UPDATE passes SET resume_requested=1 WHERE job_id=? AND artifact_id=? AND phase='backs'",
                                               (current["id"], pending["artifact_id"]))
                        message = "Paper reload confirmed for this back pass"
                    else:
                        self.ledger.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('paused',?)", ("1" if kind == "pause" else "0",))
                        message = "Station paused; pages already queued continue" if kind == "pause" else "Station unpaused; local proof requirements still apply"
                    self.ledger.db.execute("UPDATE control_receipts SET state='applied',message=? WHERE id=?", (message, command_id))
                except StationError as error:
                    rejection = str(error)
                    self.ledger.db.execute("UPDATE control_receipts SET state='rejected',message=? WHERE id=?", (rejection, command_id))
        if not rejection and kind in {"check_update", "update", "rollback"}:
            try:
                if not self.manager or not self.refresh_update().get("supported"):
                    raise StationError("Managed updates require an installed companion bundle")
                if kind != "check_update" and self.ledger.current():
                    raise StationError("Finish or reconcile the active batch before changing versions")
                if kind == "check_update":
                    self.update.update(status="checking", error=None)
                else:
                    if not isinstance(request.get("targetVersion"), str) or not re.fullmatch(r"\d+\.\d+\.\d+", request["targetVersion"]):
                        raise StationError("An explicit version is required")
                    self.ledger.write("INSERT OR REPLACE INTO settings(key,value) VALUES('paused','1')")
                    self.update.update(status="updating" if kind == "update" else "rollback", error=None)
                # Publish progress before a bounded package download. Do not process
                # commands returned by this extra heartbeat recursively.
                self.exchange(self.snapshot(), process=False)
                result = (self.manager.check_update(self.config) if kind == "check_update"
                          else self.manager.apply_update(self.config, action=kind, target_version=request["targetVersion"]))
                self.update.update({key: result[key] for key in self.update if key in result})
                self.restart_needed = bool(result.get("restartNeeded"))
                self.finish(command_id, "applied", "Update check completed" if kind == "check_update" else "Version selected; station remains paused")
            except (StationError, OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                rejection = self.safe_message(error)
                self.update.update(status="failed", error=rejection)
                self.finish(command_id, "rejected", rejection)
        self.event("error" if rejection else "info", ("Control rejected: " + rejection) if rejection else "Control applied: " + str(kind))

    def complete_discord_test(self, command_id, revision, confirmed):
        message = ("Discord confirmed the test message" if confirmed else
                   "Discord test was not confirmed and will not be retried automatically. Check Discord before requesting another test.")
        with self.ledger.db:
            self.ledger.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (DISCORD_TEST_SETTING, json.dumps(
                {"commandId": command_id, "revision": revision, "status": "confirmed" if confirmed else "unconfirmed", "at": timestamp()})))
            self.ledger.db.execute("UPDATE control_receipts SET state=?,message=? WHERE id=?",
                                   ("applied" if confirmed else "rejected", message, command_id))
        return message

    def apply_discord(self, request, command_id):
        """Fixed destination settings, with no secret in receipts or telemetry."""
        kind = request["type"]
        settings = request.get("discord") if kind == "configure_discord" else None
        rejection = None
        try:
            revision = "local" if kind == "test_discord" and request.get("revision") == "local" else checked_id(request.get("revision"), "Discord settings revision")
            if kind == "configure_discord":
                if revision != command_id or not isinstance(settings, dict) or set(settings) != {"enabled", "webhookUrl", "userId"}:
                    raise ValueError("Invalid Discord configuration")
                if type(settings["enabled"]) is not bool:
                    raise ValueError("Invalid Discord enabled flag")
                validate_alert_config({"refeed_discord_webhook_url": settings["webhookUrl"],
                                       "refeed_discord_user_id": settings["userId"]})
                if (settings["enabled"] and not settings["webhookUrl"]) or (not settings["enabled"] and (settings["webhookUrl"] or settings["userId"])):
                    raise ValueError("Incomplete Discord configuration")
            elif revision == "local":
                pass
        except (ValueError, StationError, KeyError, TypeError):
            # Never echo untrusted configuration or URL-bearing validation errors.
            rejection, revision = "Invalid Discord notification settings", None
        # Store only a digest for immutable payload matching, never a webhook in receipts.
        digest = hashlib.sha256(json.dumps({"revision": request.get("revision"), "discord": settings}, sort_keys=True).encode()).hexdigest()
        payload = json.dumps({"type": kind, "revision": revision, "settingsHash": digest}, sort_keys=True)
        prior = self.ledger.db.execute("SELECT * FROM control_receipts WHERE id=?", (command_id,)).fetchone()
        if prior:
            if prior["payload"] != payload:
                raise StationError("Previously seen Discord control changed its requested action")
            return
        try:
            expires = datetime.datetime.fromisoformat(request["expiresAt"].replace("Z", "+00:00"))
            if expires.tzinfo is None or expires.timestamp() <= time.time():
                rejection = "Discord control expired before this Mac could apply it"
        except (KeyError, ValueError, TypeError, AttributeError):
            rejection = "Discord control has no valid expiry"
        effective = None
        if kind == "test_discord" and not rejection:
            try:
                effective, _managed = effective_alert_config(self.ledger, self.config)
                status = discord_status(self.ledger, self.config)
                if not status["configured"] or status["revision"] != revision:
                    rejection = "Discord settings changed; refresh before requesting a test"
            except Exception:
                rejection = "Discord settings are unavailable"
        with self.ledger.db:
            self.ledger.db.execute("INSERT INTO control_receipts(id,payload,state,message) VALUES(?,?,?,?)",
                                   (command_id, payload, "rejected" if rejection else "processing", rejection or "Applying Discord control"))
            if kind == "configure_discord" and not rejection:
                self.ledger.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                                       (DISCORD_SETTING, json.dumps({**settings, "revision": revision})))
                self.ledger.db.execute("DELETE FROM settings WHERE key=?", (DISCORD_TEST_SETTING,))
                self.ledger.db.execute("UPDATE control_receipts SET state='applied',message=? WHERE id=?",
                                       ("Discord notifications connected" if settings["enabled"] else "Discord notifications disconnected", command_id))
        if kind == "test_discord" and not rejection:
            # The processing receipt is committed before the only external attempt.
            confirmed = False
            try:
                self.station.alerts.discord_transport(effective["refeed_discord_webhook_url"], discord_test_payload(effective), timeout=5)
                confirmed = True
            except Exception:
                pass
            message = self.complete_discord_test(command_id, revision, confirmed)
            self.event("info" if confirmed else "warning", message)
        else:
            self.event("warning" if rejection else "info", rejection or
                       ("Discord notifications connected" if settings["enabled"] else "Discord notifications disconnected"))

    def exchange(self, payload, process=True):
        result = self.station.client.management_heartbeat(payload)
        if not isinstance(result, dict) or not isinstance(result.get("commands"), list) or len(result["commands"]) > 20:
            raise StationError("Invalid station management response")
        sent = {entry["commandId"] for entry in payload["receipts"]}
        acknowledgements = result.get("acknowledgedCommandIds", [])
        if not isinstance(acknowledgements, list) or any(not isinstance(key, str) or key not in sent for key in acknowledgements):
            raise StationError("Unexpected station control acknowledgement")
        with self.ledger.db:
            for key in acknowledgements:
                self.ledger.db.execute("UPDATE control_receipts SET acknowledged=1 WHERE id=?", (key,))
        if process:
            for request in result["commands"]:
                self.apply(request)
                if self.restart_needed:
                    break
        return result

    def sync(self, check_printer=True):
        if check_printer:
            self.check_printer()
        return self.exchange(self.snapshot())
