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

from clc_print_station import StationError, checked_id, recipe_fingerprint, clearance_id
from clc_station_alerts import (DISCORD_SETTING, DISCORD_TEST_SETTING, validate_alert_config,
                                effective_alert_config, discord_status, discord_test_payload,
                                discord_queued_payload)


CONTROL_TYPES = {"pause", "unpause", "resume", "recover_print", "clear_paper", "check_update", "update", "rollback", "configure_discord", "test_discord"}
QUEUE_NOTIFICATION_ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z", re.I)


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


class StationControl:
    def __init__(self, station, version, manager=None):
        self.station, self.config, self.ledger = station, station.config, station.ledger
        self.version, self.restart_needed = version, False
        self.health = {"ok": False, "known": False, "message": "Printer check pending", "advisories": []}
        self.last_doctor = None
        self.printer_read_failures = 0
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
        # A webhook may have succeeded immediately before a crash. Preserve the
        # attempt boundary; uncertainty must never send that message a second time.
        self.queue_notifications_available = True
        try:
            self.ledger.write("""CREATE TABLE IF NOT EXISTS queue_notification_receipts (
                id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
                at TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)""")
            self.ledger.write("UPDATE queue_notification_receipts SET status='failed' WHERE status='attempting'")
        except Exception:
            # Optional alert storage must not become a new dependency for printing.
            self.queue_notifications_available = False
        self.refresh_update()
        # A manager operation may have selected a version just before a crash.
        # Reconcile its durable target instead of executing the command again.
        for row in self.ledger.db.execute("SELECT * FROM control_receipts WHERE state='processing'").fetchall():
            request = json.loads(row["payload"])
            if request.get("type") == "test_discord":
                self.complete_discord_test(row["id"], request.get("revision"), False)
                continue
            if request.get("type") == "recover_print":
                saved = self.ledger.db.execute("SELECT payload FROM jobs WHERE id=?", (request.get("jobId"),)).fetchone()
                value = json.loads(saved["payload"]) if saved else {}
                accepted = next((step for step in value.get("steps", []) if step.get("attemptId") == row["id"]
                                 and step.get("artifactId") == request.get("artifactId") and step.get("phase") == request.get("phase")), None)
                if accepted:
                    self.station.sync_steps(value)
                self.finish(row["id"], "applied" if accepted else "rejected",
                            "Saved recovery authorization reconciled; its physical attempt will not be duplicated" if accepted else
                            "Print recovery was interrupted. Check the current pass before requesting recovery again.")
                continue
            if request.get("type") == "clear_paper":
                # Local/network acknowledgements can be lost. Do not replay a
                # physical confirmation after a restart or another sheet load.
                self.finish(row["id"], "rejected", "Paper clearance was interrupted. Check the current batch before confirming again.")
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
        job, pending = None, None
        observed = {"ok": False, "known": False, "reasons": [], "message": "Printer status is unavailable", "advisories": []}
        stage = "status"
        try:
            current = self.ledger.current()
            if current:
                job = json.loads(current["payload"])
                selected = self.ledger.pending(job)
                pending = dict(selected) if selected is not None else None
            observed = self.station.cups.status(pending.get("spooler_id") if pending else None)
            if observed["ok"]:
                # A healthy device must still pass the original local driver checks.
                stage = "driver"
                self.station.cups.doctor()
            self.health = {"ok": observed["ok"], "known": observed.get("known") is True,
                           "message": self.safe_message(observed["message"]),
                           "advisories": [self.safe_message(value) for value in observed.get("advisories", [])[:8]]}
            self.printer_read_failures = 0
        except (StationError, OSError, ValueError, subprocess.TimeoutExpired):
            self.printer_read_failures += 1
            message = ("Cannot verify the Epson driver setup. Check the Mac printer queue." if stage == "driver" else
                       "Cannot read local printer status. Check the Mac printer queue.")
            observed = {"ok": False, "known": False, "reasons": [], "message": message, "advisories": []}
            self.health = {"ok": False, "known": False, "message": message, "advisories": []}
        self.last_doctor = time.monotonic()
        if previous != self.health:
            self.event("info" if self.health["ok"] else "error" if self.health["known"] else "warning", self.health["message"])
        # Notification failures never change pause, spool or paper-handling state.
        try:
            alert_health = observed
            if self.printer_read_failures >= 2 and pending and pending.get("spooler_id"):
                # A confirmed monitoring outage is distinct from a device fault.
                # Idle status loss stays in telemetry; physical work needs help
                # because its completion cannot currently be verified.
                alert_health = {**observed, "known": True, "reasons": ["status-unavailable"], "category": "monitoring"}
            alert = self.station.alerts.printer_error(alert_health, job, pending)
            if alert.get("message"):
                self.event(alert.get("level") or "warning", alert["message"])
        except Exception:
            self.event("warning", "Printer-error alerts are unavailable. Check Printer in CLC.")

    def snapshot(self):
        current = self.ledger.current()
        if current:
            active = {"id": current["id"], "state": current["state"]}
            job = json.loads(current["payload"])
            if current["state"] in {"awaiting_clearance", "awaiting_paper_reset"}:
                active["clearanceId"] = clearance_id(job)
            pending = self.ledger.pending(job)
            if pending:
                active.update(artifactId=pending["artifact_id"], phase=pending["phase"])
                try:
                    active["recovery"] = self.station.recovery_summary(job, pending)
                except (StationError, OSError, ValueError, subprocess.TimeoutExpired):
                    active["recovery"] = None
            elif (job.get("backRequest") or {}).get("artifactId"):
                active.update(artifactId=job["backRequest"]["artifactId"], phase="backs")
            if pending and pending["state"] in {"intent", "submitted", "uncertain"} and current["state"] not in {"awaiting_clearance", "awaiting_paper_reset"}:
                active["state"] = {"intent": "submitting"}.get(pending["state"], pending["state"])
        else:
            active = None
        queue_receipts = self.queue_notification_receipts()
        return {"version": self.version, "paused": self.ledger.paused(), "queue": self.config["queue"],
                "deferredBacks": True,
                "printRecovery": True,
                "recipeVerified": bool(self.config.get("recipe_verified")),
                "duplexVerified": bool(self.config.get("duplex_verified")),
                "testPrintingEnabled": self.config.get("allow_unverified_printing") is True,
                "recipeFingerprint": recipe_fingerprint(self.config), "activeJob": active,
                "health": self.health, "update": self.update,
                "discord": discord_status(self.ledger, self.config),
                "queueNotifications": self.queue_notifications_available,
                "queueNotificationReceipts": queue_receipts,
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
        payload_keys = ("type", "jobId", "artifactId", "paperReloaded", "targetVersion")
        if kind == "clear_paper":
            payload_keys += ("paperCleared", "clearanceId")
        if kind == "recover_print":
            payload_keys += ("phase", "spoolerId", "recoveryId", "paperReady", "firstUnprintedSheet", "paperReloaded")
        payload = json.dumps({key: request.get(key) for key in payload_keys}, sort_keys=True)
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
                        pending = self.ledger.pending(json.loads(current["payload"]))
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
        if not rejection and kind == "clear_paper":
            try:
                if request.get("paperCleared") is not True:
                    raise StationError("Explicit confirmation that printed paper was removed and blank paper loaded is required")
                self.station.clear_paper(request.get("jobId"), request.get("clearanceId"))
                self.finish(command_id, "applied", "Paper clearance confirmed; the station may continue")
            except (StationError, OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                rejection = self.safe_message(error)
                self.finish(command_id, "rejected", rejection)
        if not rejection and kind == "recover_print":
            try:
                summary = self.station.recover_print(request)
                self.finish(command_id, "applied", summary)
            except (StationError, OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                rejection = self.safe_message(error)
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

    def queue_notification_receipts(self):
        if not self.queue_notifications_available:
            return []
        try:
            return [dict(row) for row in self.ledger.db.execute(
                "SELECT id,status FROM queue_notification_receipts WHERE acknowledged=0 AND status!='attempting' ORDER BY rowid LIMIT 20")]
        except Exception:
            self.queue_notifications_available = False
            try:
                self.event("warning", "Queued-job notification receipts are unavailable. Printer work continues.")
            except Exception:
                pass
            return []

    def queued_notification(self, notice):
        """Persist once, then attempt once. No local print history is consulted."""
        if not isinstance(notice, dict):
            raise ValueError("Invalid queued-job notification")
        notice_id = checked_id(notice.get("id"), "queue notification ID")
        if not QUEUE_NOTIFICATION_ID.fullmatch(notice_id):
            raise ValueError("Invalid queued-job notification ID")
        digest = hashlib.sha256(json.dumps(notice, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        prior = self.ledger.db.execute("SELECT * FROM queue_notification_receipts WHERE id=?", (notice_id,)).fetchone()
        if prior:
            if prior["payload_hash"] != digest:
                raise ValueError("Previously seen queued-job notification changed its content")
            return
        status, effective, outgoing = "ignored", None, None
        try:
            if set(notice) != {"id", "jobId", "deckName", "requesterName", "totalCopies", "queuedAt"}:
                raise ValueError("Invalid queued-job notification fields")
            checked_id(notice["jobId"], "queue notification job ID")
            if not QUEUE_NOTIFICATION_ID.fullmatch(notice["jobId"]):
                raise ValueError("Invalid queued-job notification job ID")
            for field, limit in (("deckName", 200), ("requesterName", 120), ("queuedAt", 40)):
                value = notice[field]
                if not isinstance(value, str) or not value.strip() or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
                    raise ValueError("Invalid queued-job notification text")
            if type(notice["totalCopies"]) is not int or not 1 <= notice["totalCopies"] <= 1_000_000:
                raise ValueError("Invalid queued-job copy count")
            queued_at = datetime.datetime.fromisoformat(notice["queuedAt"].replace("Z", "+00:00"))
            if queued_at.tzinfo is None:
                raise ValueError("Queued-job notification time needs a timezone")
            status = "failed"
            effective, _managed = effective_alert_config(self.ledger, self.config)
            if effective.get("refeed_discord_webhook_url"):
                outgoing = discord_queued_payload(notice, effective)
                status = "attempting"
            else:
                status = "disabled"
        except (ValueError, TypeError, KeyError, StationError):
            pass
        # Durable before the only external effect. Keep the digest even when
        # disconnected or invalid so reconnect/restart cannot replay a backlog.
        with self.ledger.db:
            reserved = self.ledger.db.execute("INSERT OR IGNORE INTO queue_notification_receipts(id,payload_hash,status,at) VALUES(?,?,?,?)",
                                              (notice_id, digest, status, timestamp()))
        if reserved.rowcount != 1 or status != "attempting":
            return
        try:
            self.station.alerts.discord_transport(effective["refeed_discord_webhook_url"], outgoing, timeout=5)
            status = "attempted"
        except Exception:
            status = "failed"
        self.ledger.write("UPDATE queue_notification_receipts SET status=? WHERE id=?", (status, notice_id))
        self.event("info" if status == "attempted" else "warning",
                   "Queued-job Discord notification requested without a mention." if status == "attempted" else
                   "Queued-job Discord notification was not confirmed; no automatic resend will be attempted.")

    def queue_notifications(self, result, sent_payload, process):
        """Optional notification protocol errors must never block printer work."""
        try:
            sent = {entry["id"] for entry in sent_payload.get("queueNotificationReceipts", [])}
            acknowledgements = result.get("acknowledgedQueueNotificationIds", [])
            if (not isinstance(acknowledgements, list) or len(acknowledgements) > 20
                    or any(not isinstance(key, str) or key not in sent for key in acknowledgements)):
                raise ValueError("Unexpected queued-job notification acknowledgement")
            with self.ledger.db:
                for key in acknowledgements:
                    self.ledger.db.execute("UPDATE queue_notification_receipts SET acknowledged=1 WHERE id=?", (key,))
            if process and not self.restart_needed and self.queue_notifications_available:
                notices = result.get("queueNotifications", [])
                if not isinstance(notices, list) or len(notices) > 1:
                    raise ValueError("Invalid queued-job notification response")
                for notice in notices:
                    self.queued_notification(notice)
        except Exception:
            try:
                self.event("warning", "Queued-job Discord notification could not be processed safely. Printer work continues.")
            except Exception:
                pass  # Even a failed diagnostic must not become a print control.

    def exchange(self, payload, process=True):
        # Extra progress exchanges during updates must not deliver notifications.
        sent_payload = {**payload, "queueNotifications": bool(process and not self.restart_needed and self.queue_notifications_available)}
        if not sent_payload["queueNotifications"]:
            sent_payload["queueNotificationReceipts"] = []
        result = self.station.client.management_heartbeat(sent_payload)
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
        self.queue_notifications(result, sent_payload, process)
        return result

    def sync(self, check_printer=True):
        if check_printer:
            self.check_printer()
        return self.exchange(self.snapshot())
