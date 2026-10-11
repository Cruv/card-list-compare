"""Best-effort print alerts; never authorize or submit a print pass."""

import hashlib
import json
import re
import subprocess
import time
import urllib.parse
import urllib.request
import uuid


APPLE_SCRIPT = '''on run argv
    set alertTitle to item 1 of argv
    set alertSubtitle to item 2 of argv
    set alertBody to item 3 of argv
    if item 4 of argv is "true" then
        display notification alertBody with title alertTitle subtitle alertSubtitle sound name "Glass"
    else
        display notification alertBody with title alertTitle subtitle alertSubtitle
    end if
end run
'''
SNOWFLAKE = re.compile(r"[1-9][0-9]{0,19}\Z")
WEBHOOK_PATH = re.compile(r"/api/webhooks/([1-9][0-9]{0,19})/[A-Za-z0-9_-]{1,256}\Z")
CHANNEL_TABLES = {"mac": "refeed_alerts", "discord": "refeed_discord_alerts"}
DISCORD_USERNAME = "Proxy Balboa"

# Film excerpts and their provenance live together. The factual message below,
# never a movie line, is authoritative about print progress and operator actions.
BALBOA_FILMS = {
    "rocky": ("Rocky (1976)", "https://www.springfieldspringfield.co.uk/movie_script.php?movie=rocky"),
    "rocky-ii": ("Rocky II (1979)", "https://www.springfieldspringfield.co.uk/movie_script.php?movie=rocky-ii"),
    "rocky-iii": ("Rocky III (1982)", "https://www.springfieldspringfield.co.uk/movie_script.php?movie=rocky-iii"),
    "rocky-iv": ("Rocky IV (1985)", "https://www.springfieldspringfield.co.uk/movie_script.php?movie=rocky-iv"),
    "rocky-v": ("Rocky V (1990)", "https://www.springfieldspringfield.co.uk/movie_script.php?movie=rocky-v"),
    "rocky-balboa": ("Rocky Balboa (2006)", "https://www.springfieldspringfield.co.uk/movie_script.php?movie=rocky-balboa"),
}
# Short released-film dialogue fragments, including accurately credited trainers.
# No lyrics or speeches; the whole catalog stays below 90 excerpt characters per film.
BALBOA_DIALOGUE = (
    {"film": "rocky", "speaker": "Mickey", "text": "you're gonna eat lightning", "moods": ("training",)},
    {"film": "rocky-ii", "speaker": "Mickey", "text": "What are we waitin' for?", "moods": ("training",)},
    {"film": "rocky-iii", "speaker": "Apollo", "text": "There is no tomorrow!", "moods": ("training",)},
    {"film": "rocky-iv", "speaker": "Duke", "text": "No pain.", "moods": ("training",)},
    {"film": "rocky-v", "speaker": "Rocky", "text": "Take the shot.", "moods": ("training",)},
    {"film": "rocky-balboa", "speaker": "Rocky", "text": "keep moving forward.", "moods": ("training",)},
    {"film": "rocky", "speaker": "Rocky", "text": "Hey, that was terrific.", "moods": ("success",)},
    {"film": "rocky-ii", "speaker": "Rocky", "text": "Yo, Adrian, I did it!", "moods": ("success",)},
    {"film": "rocky-iii", "speaker": "Mickey", "text": "I'm proud of ya.", "moods": ("success",)},
    {"film": "rocky-iv", "speaker": "Rocky", "text": "everybody can change!", "moods": ("success",)},
    {"film": "rocky-v", "speaker": "Rocky", "text": "You did great, kid!", "moods": ("success",)},
    {"film": "rocky-balboa", "speaker": "Rocky", "text": "That's how winning is done!", "moods": ("success",)},
    {"film": "rocky", "speaker": "Rocky", "text": "I can't beat him.", "moods": ("setback",)},
    {"film": "rocky-ii", "speaker": "Rocky", "text": "I'm sorry.", "moods": ("setback",)},
    {"film": "rocky-iii", "speaker": "Rocky", "text": "I'm afraid!", "moods": ("setback",)},
    {"film": "rocky-iv", "speaker": "Rocky", "text": "He's winnin'.", "moods": ("setback",)},
    {"film": "rocky-v", "speaker": "Rocky", "text": "We been down before.", "moods": ("setback",)},
    {"film": "rocky-balboa", "speaker": "Rocky", "text": "Scared to death.", "moods": ("setback",)},
)
BALBOA_EVENTS = {
    "queued": "training", "flip": "training", "test": "training",
    "completed": "success", "fronts_saved": "success", "paper_reset": "success",
    "fault": "setback", "cancel_clearance": "setback", "monitoring": "setback",
}


def balboa_line(event, job_id="", artifact_id=""):
    """Vary between events/batches; replaying the same receipt keeps its line."""
    pool = [entry for entry in BALBOA_DIALOGUE if BALBOA_EVENTS[event] in entry["moods"]]
    seed = json.dumps([event, str(job_id), str(artifact_id)], ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    entry = pool[int.from_bytes(hashlib.sha256(seed).digest()[:4], "big") % len(pool)]
    return f'“{entry["text"]}” — {entry["speaker"]}, *{BALBOA_FILMS[entry["film"]][0]}*'


def valid_snowflake(value):
    return isinstance(value, str) and bool(SNOWFLAKE.fullmatch(value)) and int(value) < 2**64


def validate_alert_config(config):
    """Validate local preferences without returning or echoing webhook secrets."""
    for field in ("refeed_notifications", "refeed_sound"):
        if type(config.get(field, True)) is not bool:
            raise ValueError(field + " must be the JSON boolean true or false")
    url = config.get("refeed_discord_webhook_url", "")
    user_id = config.get("refeed_discord_user_id", "")
    if not isinstance(url, str):
        raise ValueError("refeed_discord_webhook_url must be an empty string or a canonical Discord webhook URL")
    if url:
        try:
            parsed = urllib.parse.urlsplit(url)
            match = WEBHOOK_PATH.fullmatch(parsed.path)
            valid = (url == url.strip() and not re.search(r"[\x00-\x20\x7f]", url)
                     and parsed.scheme == "https" and parsed.netloc == "discord.com"
                     and not parsed.query and not parsed.fragment and "?" not in url and "#" not in url
                     and match is not None and valid_snowflake(match[1]))
        except (TypeError, ValueError):
            valid = False
        if not valid:
            raise ValueError("refeed_discord_webhook_url must use https://discord.com/api/webhooks/id/token without extra URL components")
    if not isinstance(user_id, str) or (user_id and not valid_snowflake(user_id)):
        raise ValueError("refeed_discord_user_id must be an empty string or a Discord user snowflake")


class NoDiscordRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Discord webhook redirects are refused")


def post_discord(url, payload, timeout=5):
    """One bounded request; no redirect or automatic retry can forward the token."""
    validate_alert_config({"refeed_discord_webhook_url": url})
    request = urllib.request.Request(url + "?wait=true", data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Accept": "application/json",
                                              "User-Agent": "CLC-Print-Station"}, method="POST")
    opener = urllib.request.build_opener(NoDiscordRedirect())
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("Discord did not confirm the message")
        body = response.read(65537)
    if len(body) > 65536:
        raise ValueError("Discord message receipt exceeded the limit")
    receipt = json.loads(body)
    expected_webhook = WEBHOOK_PATH.fullmatch(urllib.parse.urlsplit(url).path)[1]
    if (not isinstance(receipt, dict) or not valid_snowflake(receipt.get("id"))
            or receipt.get("webhook_id") != expected_webhook):
        raise ValueError("Discord did not return a matching message receipt")
    return receipt


def result(status, message=None, level=None):
    return {"status": status, "message": message, "level": level}


def display_text(value, limit):
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(value))).strip()[:limit]


def flip_details(job, artifact):
    """Physical sheet count and packet position, including legacy PDFs."""
    fronts = artifact.get("frontPages")
    count = len(fronts) if isinstance(fronts, list) and fronts else artifact.get("sheetCount")
    if type(count) is not int or count < 1:
        pages = artifact.get("pageCount")
        count = pages // 2 if type(pages) is int and pages > 0 and pages % 2 == 0 else None
    if count is None:
        raise ValueError("Missing physical sheet count")
    index, total = artifact.get("packetIndex"), artifact.get("packetCount")
    if not (type(index) is int and type(total) is int and 1 <= index <= total):
        packets = [item for item in job.get("artifacts", []) if item.get("kind") == "dfc"]
        position = next((i for i, item in enumerate(packets) if item.get("id") == artifact["id"]), None)
        index, total = (position + 1, len(packets)) if position is not None else (1, 1)
    return count, index, total


def alert_text(job, artifact):
    """Describe the physical front sheets, not the alternating PDF page count."""
    count, index, total = flip_details(job, artifact)
    title = "CLC: flip printed cards"
    deck = display_text(job.get("deckName") or "Deck print", 70)
    subtitle = f"{deck} · {display_text(job['id'], 12)} · Packet {index}/{total}"
    paper = "the 1 printed sheet" if count == 1 else f"the {count} printed sheets"
    label = display_text(artifact.get("label") or "", 180)
    body = (f"Printed label: {label}. " if label else "") + f"Flip only {paper} from this packet. Remove blank paper from the rear feeder. Reload only the matching printed paper, then confirm in CLC Print Station."
    return title, subtitle, body


def discord_text(value):
    # Allowed mentions is the permission boundary; escaping also keeps deck text
    # from visually impersonating mentions, headings, links, or message fields.
    return re.sub(r"([\\`*_~|\[\]])", r"\\\1", value.replace("@", "@\u200b").replace("<", "‹").replace(">", "›"))


def discord_packet_payload(job, artifact, config, event):
    validate_alert_config(config)
    text_builder, heading = {
        "flip": (alert_text, "Paper flip needed"),
        "paper_reset": (paper_reset_text, "Return blank paper"),
        "cancel_clearance": (cancel_clearance_text, "Canceled print needs paper clearance"),
    }[event]
    _title, _subtitle, body = text_builder(job, artifact)
    _sheets, index, total = flip_details(job, artifact)
    show_packet = event != "cancel_clearance" or artifact.get("kind") == "dfc"
    mention = config.get("refeed_discord_user_id", "")
    deck = discord_text(display_text(job.get("deckName") or "Deck print", 70))
    packet_heading = f" · packet {index}/{total}" if show_packet else ""
    content = (f"<@{mention}> " if mention else "") + f"**{heading} · {deck}{packet_heading}**\n"
    content += balboa_line(event, job["id"], artifact["id"]) + "\n\n**Print details**"
    content += "\nPrinter: " + discord_text(printer_text(config.get("queue") or "Household printer", 96, config))
    content += "\nBatch ID: " + discord_text(display_text(job["id"], 128))
    if show_packet:
        content += f"\nPacket {index}/{total}"
    # The packet ID remains useful for legacy jobs whose PDF has no job label.
    content += ("\nPacket ID: " if show_packet else "\nPass artifact: ") + discord_text(display_text(artifact["id"], 96))
    content += "\n" + discord_text(body)
    origin = config.get("server_url", "")
    if isinstance(origin, str) and origin:
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username
                and not parsed.password and not parsed.query and not parsed.fragment
                and parsed.path in {"", "/"} and not re.search(r"[\s<>]", origin)):
            content += "\nOpen Printer in CLC: <" + origin.rstrip("/") + "/#print-station>"
    if len(content) > 2000:
        raise ValueError("Discord flip message exceeds its content limit")
    return {"username": DISCORD_USERNAME, "content": content, "allowed_mentions": {"parse": [], "users": [mention] if mention else [], "roles": []}, "tts": False}


def discord_payload(job, artifact, config):
    return discord_packet_payload(job, artifact, config, "flip")


DISCORD_SETTING = "managed_discord_notifications"
DISCORD_TEST_SETTING = "managed_discord_last_test"


def effective_alert_config(ledger, config):
    """An explicit managed disconnect must override a legacy config-file URL."""
    row = ledger.db.execute("SELECT value FROM settings WHERE key=?", (DISCORD_SETTING,)).fetchone()
    if not row:
        return dict(config), None
    value = json.loads(row["value"])
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool:
        raise ValueError("Saved Discord settings are invalid")
    merged = {**config, "refeed_discord_webhook_url": value.get("webhookUrl", "") if value["enabled"] else "",
              "refeed_discord_user_id": value.get("userId", "") if value["enabled"] else ""}
    validate_alert_config(merged)
    if value["enabled"] and not merged["refeed_discord_webhook_url"]:
        raise ValueError("Saved Discord settings are incomplete")
    return merged, value


def discord_status(ledger, config):
    try:
        effective, managed = effective_alert_config(ledger, config)
        row = ledger.db.execute("SELECT value FROM settings WHERE key=?", (DISCORD_TEST_SETTING,)).fetchone()
        last_test = json.loads(row["value"]) if row else None
        return {"supported": True, "configured": bool(effective.get("refeed_discord_webhook_url")),
                "managed": managed is not None, "revision": managed["revision"] if managed else "local",
                "userId": effective.get("refeed_discord_user_id", ""), "lastTest": last_test}
    except Exception:
        return {"supported": True, "configured": False, "managed": True, "revision": None,
                "userId": "", "lastTest": None}


def discord_test_payload(config):
    validate_alert_config(config)
    content = "**Discord delivery test · no printer action**\n"
    content += balboa_line("test", config.get("queue", "")) + "\n\n**Test details**\n"
    content += "Discord test confirmed. Future alerts report completed jobs, sheets to flip and printer errors that need attention. Only alerts requiring help mention you.\n"
    content += "Printer: " + discord_text(printer_text(config.get("queue") or "Household printer", 96, config))
    content += "\nPrinter action: None. This test does not print or resume anything."
    return {"username": DISCORD_USERNAME, "content": content, "allowed_mentions": {"parse": [], "users": [], "roles": []}, "tts": False}


def discord_job_payload(job, config, *, fronts_saved=False):
    """Useful completion receipt, with mentions disabled regardless of preferences."""
    validate_alert_config(config)
    name = job.get("deckName") or "Print batch"
    heading = "Fronts printed · backs saved" if fronts_saved else "Print job complete"
    content = "**" + heading + " · " + discord_text(printer_text(name, 70, config)) + "**\n"
    content += balboa_line("fronts_saved" if fronts_saved else "completed", job["id"]) + "\n\n**Print details**"
    content += "\nJob: " + discord_text(printer_text(name, 200, config))
    content += "\nBatch ID: " + discord_text(printer_text(job["id"], 128, config))
    content += "\nPrinter: " + discord_text(printer_text(config.get("queue") or "Household printer", 96, config))
    copies = job.get("totalCopies")
    if type(copies) is int and 0 < copies <= 1_000_000:
        content += f"\nCard copies: {copies}"
    if fronts_saved:
        content += "\nStatus: All front passes completed. Matching backs are saved for later."
        content += "\nAction: None right now. Leave blank paper loaded. Choose a saved packet in CLC when you want to print its backs; wait for the reload alert before loading it."
    else:
        content += "\nStatus: All print passes completed in the printer queue."
        content += "\nAction: None. No paper flip is needed for this job."
    origin = config.get("server_url", "")
    if isinstance(origin, str) and origin:
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment and parsed.path in {"", "/"} and not re.search(r"[\s<>]", origin)):
            content += "\nOpen Printer in CLC: <" + origin.rstrip("/") + "/#print-station>"
    if len(content) > 2000:
        raise ValueError("Completion alert exceeds the message limit")
    return {"username": DISCORD_USERNAME, "content": content,
            "allowed_mentions": {"parse": [], "users": [], "roles": []}, "tts": False}


def discord_completion_payload(job, config):
    return discord_job_payload(job, config)


def discord_queued_payload(notice, config):
    """A CLC queue receipt, never a claim that Epson has started printing."""
    validate_alert_config(config)
    clean = lambda value, limit: discord_text(printer_text(value, limit, config))
    content = "**Print job queued · " + clean(notice["deckName"], 70) + "**\n"
    content += balboa_line("queued", notice["jobId"]) + "\n\n**Print details**"
    content += "\nJob: " + clean(notice["deckName"], 200)
    content += "\nQueued by: " + clean(notice["requesterName"], 120)
    content += f"\nCard copies: {notice['totalCopies']}"
    content += "\nQueued at: " + clean(notice["queuedAt"], 40)
    content += "\nBatch ID: " + clean(notice["jobId"], 96)
    content += "\nPrinter: " + clean(config.get("queue") or "Household printer", 96)
    content += "\nStatus: Accepted into the CLC print queue. This does not mean the printer has started."
    content += "\nAction: None."
    origin = config.get("server_url", "")
    if isinstance(origin, str) and origin:
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment and parsed.path in {"", "/"} and not re.search(r"[\s<>]", origin)):
            content += "\nOpen Printer in CLC: <" + origin.rstrip("/") + "/#print-station>"
    if len(content) > 2000:
        raise ValueError("Queued-job alert exceeds the message limit")
    return {"username": DISCORD_USERNAME, "content": content,
            "allowed_mentions": {"parse": [], "users": [], "roles": []}, "tts": False}


def discord_fronts_payload(job, config):
    return discord_job_payload(job, config, fronts_saved=True)


def paper_reset_text(job, artifact):
    _title, subtitle, _body = alert_text(job, artifact)
    label = display_text(artifact.get("label") or artifact["id"], 180)
    body = f"Backs finished for {label}. Remove the printed sheet(s), load blank paper in the rear feeder, then confirm paper cleared in CLC. Other printing waits for this confirmation."
    return "CLC: return blank paper", subtitle, body


def discord_paper_reset_payload(job, artifact, config):
    return discord_packet_payload(job, artifact, config, "paper_reset")


def cancel_clearance_text(job, artifact):
    name = display_text(job.get("deckName") or "Print batch", 70)
    label = display_text(artifact.get("label") or artifact.get("id") or "", 180)
    body = f"Cancellation requested for {label}. Check that printing has stopped, remove partially printed paper, load blanks, then confirm paper cleared in CLC. The queue waits for this check."
    return "CLC: clear canceled print paper", f"{name} · {display_text(job['id'], 12)}", body


def discord_cancel_clearance_payload(job, artifact, config):
    return discord_packet_payload(job, artifact, config, "cancel_clearance")


class RefeedAlerts:
    def __init__(self, ledger, config, runner=subprocess.run, discord_transport=post_discord):
        self.ledger, self.config, self.runner = ledger, config, runner
        self.discord_transport = discord_transport
        self.storage_failed = set()
        self.storage_failure_reported = set()
        try:
            self.ledger.write("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        except Exception:
            self.storage_failed.add("discord")
        for channel, table in CHANNEL_TABLES.items():
            try:
                # Keep the original Mac table intact across upgrades/rollbacks.
                self.ledger.write(f"""CREATE TABLE IF NOT EXISTS {table} (
                    job_id TEXT NOT NULL, artifact_id TEXT NOT NULL, phase TEXT NOT NULL,
                    attempted_at REAL NOT NULL, outcome TEXT NOT NULL,
                    PRIMARY KEY(job_id, artifact_id, phase))""")
            except Exception:
                self.storage_failed.add(channel)

    def storage_failure(self, channel):
        if channel in self.storage_failure_reported:
            return result("duplicate")
        self.storage_failure_reported.add(channel)
        name = "Mac" if channel == "mac" else "Discord"
        return result("failed", name + " flip alert could not be saved safely. Check the waiting batch in CLC Print Station.", "warning")

    def notify_channel(self, channel, job, artifact, stage="backs"):
        try:
            if channel == "mac" and self.config.get("refeed_notifications", True) is False:
                return result("disabled")
            if channel in self.storage_failed:
                return self.storage_failure(channel)
            effective = self.config
            if channel == "discord":
                effective, _managed = effective_alert_config(self.ledger, self.config)
                if not effective.get("refeed_discord_webhook_url"):
                    return result("disabled")
            canceled = stage.startswith("cancel:")
            title, subtitle, body = (cancel_clearance_text if canceled else paper_reset_text if stage == "paper_reset" else alert_text)(job, artifact)
            identity = (job["id"], artifact["id"], stage)
            table = CHANNEL_TABLES[channel]
            try:
                with self.ledger.db:
                    reserved = self.ledger.db.execute(
                        f"INSERT OR IGNORE INTO {table} VALUES(?,?,?,?,?)",
                        (*identity, time.time(), "attempting"))
                if reserved.rowcount != 1:
                    return result("duplicate")
            except Exception:
                self.storage_failed.add(channel)
                return self.storage_failure(channel)
            name = "Mac" if channel == "mac" else "Discord"
            try:
                if channel == "discord":
                    payload = (discord_cancel_clearance_payload if canceled else discord_paper_reset_payload if stage == "paper_reset" else discord_payload)(job, artifact, effective)
                    self.discord_transport(effective["refeed_discord_webhook_url"], payload, timeout=5)
                else:
                    completed = self.runner(
                        ["/usr/bin/osascript", "-", title, subtitle, body,
                         "false" if self.config.get("refeed_sound", True) is False else "true"],
                        input=APPLE_SCRIPT, capture_output=True, text=True, timeout=5, check=False)
                    if completed.returncode:
                        raise ValueError("Mac notification request failed")
                response = result("attempted", name + " flip notification requested: " + subtitle + ". " + body, "info")
            except subprocess.TimeoutExpired:
                response = result("failed", name + " flip notification timed out. Check the waiting batch in CLC Print Station.", "warning")
            except Exception:
                # Never echo URL-bearing exceptions, response bodies or redirects.
                response = result("failed", name + " flip notification was not confirmed and will not be retried automatically. Check the waiting batch in CLC Print Station.", "warning")
            try:
                self.ledger.write(f"UPDATE {table} SET outcome=? WHERE job_id=? AND artifact_id=? AND phase=?",
                                  (response["status"], *identity))
            except Exception:
                return result("failed", name + " flip notification was attempted, but its result could not be saved. Check CLC Print Station.", "warning")
            return response
        except Exception:
            return result("failed", "Flip notification could not describe this batch. Check CLC Print Station for the required paper handling.", "warning")

    def notify(self, job, artifact):
        """Call after durable front completion. Each channel reserves before sending.

        A crash or ambiguous response may suppress an alert, but cannot cause repeat
        sends. CLC remains the persistent fallback; alerts never authorize the backs.
        """
        try:
            if artifact.get("kind") != "dfc":
                return result("ignored")
            channels = {name: self.notify_channel(name, job, artifact) for name in CHANNEL_TABLES}
            statuses = {item["status"] for item in channels.values()}
            status = next(value for value in ("failed", "attempted", "duplicate", "disabled") if value in statuses)
            messages = [item["message"] for item in channels.values() if item["message"]]
            response = result(status, " ".join(messages) or None, "warning" if status == "failed" else "info" if messages else None)
            response["channels"] = channels
            return response
        except Exception:
            return result("failed", "Flip notifications are unavailable. Check the waiting batch in CLC Print Station.", "warning")

    def paper_reset(self, job, artifact):
        return self.paper_clearance(job, artifact, "paper_reset")

    def cancellation(self, job, artifact):
        return self.paper_clearance(job, artifact, "cancel:" + str(job.get("cancelRequestId")))

    def paper_clearance(self, job, artifact, stage):
        try:
            channels = {name: self.notify_channel(name, job, artifact, stage) for name in CHANNEL_TABLES}
            statuses = {item["status"] for item in channels.values()}
            status = next(value for value in ("failed", "attempted", "duplicate", "disabled") if value in statuses)
            messages = [item["message"] for item in channels.values() if item["message"]]
            return {**result(status, " ".join(messages) or None, "warning" if status == "failed" else "info" if messages else None), "channels": channels}
        except Exception:
            return result("failed", "Paper-clearance notification unavailable. Check the waiting batch in CLC.", "warning")

    def fronts_completed(self, job):
        """One unmentioned receipt; saved backs never trigger unsolicited flips."""
        try:
            effective, _managed = effective_alert_config(self.ledger, self.config)
            if not effective.get("refeed_discord_webhook_url"):
                return result("disabled")
            self.ledger.write("""CREATE TABLE IF NOT EXISTS print_fronts_alerts (
                job_id TEXT PRIMARY KEY, attempted_at REAL NOT NULL, outcome TEXT NOT NULL)""")
            with self.ledger.db:
                row = self.ledger.db.execute("SELECT state,payload FROM jobs WHERE id=?", (job["id"],)).fetchone()
                if not row or row["state"] != "backs_pending":
                    return result("ignored")
                saved = json.loads(row["payload"])
                entries = self.ledger.passes(job["id"])
                expected = {artifact["id"] for artifact in saved["artifacts"]}
                fronts = [entry for entry in entries if entry["phase"] == "fronts"]
                if (saved.get("workflow") != "deferred-backs-v1" or saved.get("id") != job["id"] or not fronts
                        or any(entry["state"] != "completed" for entry in fronts)
                        or {entry["artifact_id"] for entry in fronts} != expected
                        or not any(entry["phase"] == "backs" and entry["state"] == "pending" for entry in entries)):
                    return result("ignored")
                payload = discord_fronts_payload(saved, effective)
                reserved = self.ledger.db.execute("INSERT OR IGNORE INTO print_fronts_alerts VALUES(?,?,?)", (job["id"], time.time(), "attempting"))
            if reserved.rowcount != 1:
                return result("duplicate")
            outcome = "attempted"
            try:
                self.discord_transport(effective["refeed_discord_webhook_url"], payload, timeout=5)
            except Exception:
                outcome = "failed"
            self.ledger.write("UPDATE print_fronts_alerts SET outcome=? WHERE job_id=?", (outcome, job["id"]))
            return result(outcome, "Fronts-finished notification " + ("requested without a mention." if outcome == "attempted" else "not confirmed; no automatic retry."), "info" if outcome == "attempted" else "warning")
        except Exception:
            return result("failed", "Fronts-finished notification unavailable. Saved backs remain in CLC.", "warning")

    def job_completed(self, job):
        """Called on a new durable whole-job completion, never for history scans.

        Discord alone receives this non-actionable receipt. Reserving before the
        request prevents duplicates across restarts and ambiguous delivery; alert
        failures never change print-job or pass state.
        """
        job_id = job.get("id") if isinstance(job, dict) else None
        if not isinstance(job_id, str) or not job_id:
            return result("failed", "Discord completion notification could not identify this job. Check the completed job in CLC.", "warning")
        if job_id in getattr(self, "completion_preparation_failures", set()):
            return result("duplicate")
        try:
            effective, _managed = effective_alert_config(self.ledger, self.config)
            if not effective.get("refeed_discord_webhook_url"):
                return result("disabled")
            self.ledger.write("""CREATE TABLE IF NOT EXISTS print_completion_alerts (
                job_id TEXT PRIMARY KEY, attempted_at REAL NOT NULL, outcome TEXT NOT NULL)""")
            with self.ledger.db:
                row = self.ledger.db.execute("SELECT state,payload FROM jobs WHERE id=?", (job["id"],)).fetchone()
                if not row or row["state"] != "completed":
                    return result("ignored")
                saved = json.loads(row["payload"])
                artifacts = saved.get("artifacts", [])
                if not artifacts or saved.get("id") != job["id"]:
                    return result("ignored")
                expected = {(artifact["id"], phase) for artifact in artifacts
                            for phase in (["fronts", "backs"] if artifact["kind"] == "dfc" else ["fronts"])}
                passes = self.ledger.passes(job["id"])
                if (any(entry["state"] != "completed" for entry in passes)
                        or {(entry["artifact_id"], entry["phase"]) for entry in passes} != expected):
                    return result("ignored")
                payload = discord_completion_payload(saved, effective)
                reserved = self.ledger.db.execute("INSERT OR IGNORE INTO print_completion_alerts VALUES(?,?,?)",
                                                  (job["id"], time.time(), "attempting"))
            if reserved.rowcount != 1:
                return result("duplicate")
        except Exception:
            if not hasattr(self, "completion_preparation_failures"):
                self.completion_preparation_failures = set()
            self.completion_preparation_failures.add(job_id)
            return result("failed", "Discord completion notification could not be prepared safely. The completed job remains available in CLC.", "warning")
        try:
            self.discord_transport(effective["refeed_discord_webhook_url"], payload, timeout=5)
            response = result("attempted", "Discord job-completion notification requested without a direct mention.", "info")
        except Exception:
            response = result("failed", "Discord completion notification was not confirmed and will not be retried automatically. The completed job remains available in CLC.", "warning")
        try:
            self.ledger.write("UPDATE print_completion_alerts SET outcome=? WHERE job_id=?", (response["status"], job["id"]))
        except Exception:
            return result("failed", "Discord completion notification was attempted, but its result could not be saved. The completed job remains available in CLC.", "warning")
        return response


    def printer_error(self, health, job=None, pending=None):
        """A healthy read ends an episode. Unknown/unreadable status never does.

        Reserve each channel before delivery. Repeated observations, restarts,
        transport timeouts and alternating already-seen faults never resend.
        """
        if not health.get("known"):
            return result("unknown")
        if getattr(self, "error_storage_failed", False):
            return result("duplicate")
        try:
            self.ledger.write("""CREATE TABLE IF NOT EXISTS printer_error_alerts (
                episode TEXT NOT NULL, fault TEXT NOT NULL, channel TEXT NOT NULL,
                attempted_at REAL NOT NULL, outcome TEXT NOT NULL,
                PRIMARY KEY(episode, fault, channel))""")
            key = "printer_error_episode"
            if health.get("ok") is True:
                self.ledger.write("DELETE FROM settings WHERE key=?", (key,))
                return result("healthy")
            reasons = health.get("reasons")
            if not isinstance(reasons, list) or not reasons or len(reasons) > 64:
                return result("unknown")
            fault = hashlib.sha256(json.dumps(sorted(reasons)).encode()).hexdigest()
            with self.ledger.db:
                row = self.ledger.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
                episode = json.loads(row["value"]) if row else None
                if not episode or episode.get("queue") != self.config.get("queue"):
                    episode = {"id": uuid.uuid4().hex, "queue": self.config.get("queue"), "faults": []}
                if fault not in episode["faults"]:
                    if len(episode["faults"]) >= 32:
                        return result("duplicate")  # Bound a continuously malfunctioning device's alerts.
                    episode["faults"].append(fault)
                self.ledger.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (key, json.dumps(episode)))
                self.ledger.db.execute("DELETE FROM printer_error_alerts WHERE episode != ? AND rowid NOT IN (SELECT rowid FROM printer_error_alerts ORDER BY rowid DESC LIMIT 200)", (episode["id"],))
            title, subtitle, body = printer_alert_text(health, job, pending, self.config)
            channels = {}
            for channel in ("mac", "discord"):
                effective = self.config
                if channel == "discord":
                    try:
                        effective, _managed = effective_alert_config(self.ledger, self.config)
                    except Exception:
                        channels[channel] = result("failed", "Saved Discord settings are unavailable. Check Printer in CLC.", "warning")
                        continue
                if ((channel == "mac" and self.config.get("refeed_notifications", True) is False)
                        or (channel == "discord" and not effective.get("refeed_discord_webhook_url"))):
                    channels[channel] = result("disabled")
                    continue
                with self.ledger.db:
                    reserved = self.ledger.db.execute("INSERT OR IGNORE INTO printer_error_alerts VALUES(?,?,?,?,?)",
                                                      (episode["id"], fault, channel, time.time(), "attempting"))
                if reserved.rowcount != 1:
                    channels[channel] = result("duplicate")
                    continue
                name = "Mac" if channel == "mac" else "Discord"
                try:
                    if channel == "mac":
                        complete = self.runner(["/usr/bin/osascript", "-", title, subtitle, body,
                                                "false" if self.config.get("refeed_sound", True) is False else "true"],
                                               input=APPLE_SCRIPT, capture_output=True, text=True, timeout=5, check=False)
                        if complete.returncode:
                            raise ValueError("Notification failed")
                    else:
                        self.discord_transport(effective["refeed_discord_webhook_url"],
                                               printer_discord_payload(title, subtitle, body, effective, job=job, fault=health["message"], category=health.get("category")), timeout=5)
                    channels[channel] = result("attempted", name + " printer-error notification requested: " + subtitle + ". " + body, "info")
                except Exception:
                    channels[channel] = result("failed", name + " printer-error notification was not confirmed and will not be retried automatically. Check Printer in CLC.", "warning")
                self.ledger.write("UPDATE printer_error_alerts SET outcome=? WHERE episode=? AND fault=? AND channel=?",
                                  (channels[channel]["status"], episode["id"], fault, channel))
            messages = [item["message"] for item in channels.values() if item.get("message")]
            status = next(value for value in ("failed", "attempted", "duplicate", "disabled") if any(item["status"] == value for item in channels.values()))
            return {**result(status, " ".join(messages) or None, "warning" if status == "failed" else "info" if messages else None), "channels": channels}
        except Exception:
            self.error_storage_failed = True
            return result("failed", "Printer-error alerts could not be saved safely. Check Printer in CLC; no automatic resend will be attempted.", "warning")


def printer_text(value, limit, config):
    value = str(value)
    for secret in (config.get("token"), config.get("refeed_discord_webhook_url")):
        if secret:
            value = value.replace(secret, "[credential]")
    value = re.sub(r"https?://[^\s]+|(?i:bearer)\s+[^\s]+", "[redacted]", value)
    return display_text(value, limit)


def printer_alert_text(health, job, pending, config):
    def clean(value, limit):
        return printer_text(value, limit, config)
    monitoring = health.get("category") == "monitoring"
    title = "CLC: print status unavailable" if monitoring else "CLC: printer needs attention"
    subtitle = "Household printer"
    if job:
        subtitle = clean(job.get("deckName") or "Print batch", 60) + " · " + clean(job.get("id", ""), 12)
    body = clean(health["message"], 450).rstrip(". ") + ". "
    if pending:
        artifact = next((item for item in (job or {}).get("artifacts", []) if item.get("id") == pending["artifact_id"]), {})
        label = artifact.get("label") or pending["artifact_id"]
        body += "Packet: " + clean(label, 80) + "; pass: " + ("backs" if pending.get("phase") == "backs" else "fronts") + ". "
    if monitoring:
        body += "Spooler job: " + clean(pending["spooler_id"], 128) + ". Completion is not confirmed. Check the Mac printer queue and Printer in CLC."
    else:
        body += "Check the printer and Printer in CLC."
    body += " This alert does not pause, resume or retry printing."
    if not monitoring and pending and pending.get("spooler_id"):
        body += " After fixing the fault, use Continue interrupted print in CLC. If CUPS canceled the pass, inspect the output and choose the first unprinted sheet in that attempt's displayed print order."
        if pending.get("phase") != "backs":
            body += " When the Discord command app is connected, use /proxy continue batch:" + clean((job or {}).get("id", ""), 96) + "; supply sheet: only for a canceled or stopped attempt."
        else:
            body += " For backs, reload only the matching front sheet and confirm it in CLC."
    return title, subtitle, body


def printer_discord_payload(title, subtitle, body, config, *, job=None, fault=None, category=None):
    validate_alert_config(config)
    mention = config.get("refeed_discord_user_id", "")
    summary = discord_text(printer_text(fault or title, 120, config))
    monitoring = category == "monitoring"
    heading = "Print status unavailable" if monitoring else "Printer needs attention"
    content = (f"<@{mention}> " if mention else "") + "**" + heading + " · " + summary + "**\n"
    content += balboa_line("monitoring" if monitoring else "fault", (job or {}).get("id") or config.get("queue", ""),
                           fault or title) + "\n\n**Printer details**\n"
    content += "Printer: " + discord_text(printer_text(config.get("queue") or "Household printer", 96, config))
    content += "\n" + discord_text(subtitle)
    if job:
        content += "\nBatch ID: " + discord_text(printer_text(job.get("id", ""), 128, config))
    content += "\n" + discord_text(body)
    origin = config.get("server_url", "")
    if isinstance(origin, str) and origin:
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment and parsed.path in {"", "/"} and not re.search(r"[\s<>]", origin)):
            content += "\nOpen Printer in CLC: <" + origin.rstrip("/") + "/#print-station>"
    if len(content) > 2000:
        raise ValueError("Printer alert exceeds the message limit")
    return {"username": DISCORD_USERNAME, "content": content, "allowed_mentions": {"parse": [], "users": [mention] if mention else [], "roles": []}, "tts": False}
