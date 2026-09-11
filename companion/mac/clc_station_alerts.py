"""Best-effort flip alerts; never authorize or submit a print pass."""

import json
import re
import subprocess
import time
import urllib.parse
import urllib.request


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


def alert_text(job, artifact):
    """Describe the physical front sheets, not the alternating PDF page count."""
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
    title = "CLC: flip printed cards"
    deck = display_text(job.get("deckName") or "Deck print", 70)
    subtitle = f"{deck} · {display_text(job['id'], 12)} · Batch {index}/{total}"
    paper = "the 1 printed sheet" if count == 1 else f"the {count} printed sheets"
    label = display_text(artifact.get("label") or "", 180)
    body = (f"Printed label: {label}. " if label else "") + f"Flip only {paper} from this batch. Remove blank paper from the rear feeder. Reload only the matching printed paper, then confirm in CLC Print Station."
    return title, subtitle, body


def discord_text(value):
    # Allowed mentions is the permission boundary; escaping also keeps deck text
    # from visually impersonating mentions, headings, links, or message fields.
    return re.sub(r"([\\`*_~|\[\]])", r"\\\1", value.replace("@", "@\u200b").replace("<", "‹").replace(">", "›"))


def discord_payload(job, artifact, config):
    validate_alert_config(config)
    title, subtitle, body = alert_text(job, artifact)
    mention = config.get("refeed_discord_user_id", "")
    content = (f"<@{mention}> " if mention else "") + title + "\n" + discord_text(subtitle)
    # The packet ID remains useful for legacy jobs whose PDF has no job label.
    content += "\nPacket ID: " + discord_text(display_text(artifact["id"], 96))
    content += "\n" + discord_text(body)
    origin = config.get("server_url", "")
    if isinstance(origin, str) and origin:
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username
                and not parsed.password and not parsed.query and not parsed.fragment
                and parsed.path in {"", "/"} and not re.search(r"[\s<>]", origin)):
            content += "\nOpen CLC Print Station: <" + origin.rstrip("/") + "/#print-station>"
    if len(content) > 2000:
        raise ValueError("Discord flip message exceeds its content limit")
    return {"content": content, "allowed_mentions": {"parse": [], "users": [mention] if mention else [], "roles": []}, "tts": False}


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
    mention = config.get("refeed_discord_user_id", "")
    content = (f"<@{mention}> " if mention else "") + "CLC Print Station: Discord test confirmed. Future flip alerts identify the deck, exact packet and printed sheet to reload. This test does not print or resume anything."
    return {"content": content, "allowed_mentions": {"parse": [], "users": [mention] if mention else [], "roles": []}, "tts": False}


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

    def notify_channel(self, channel, job, artifact):
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
            title, subtitle, body = alert_text(job, artifact)
            identity = (job["id"], artifact["id"], "backs")
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
                    payload = discord_payload(job, artifact, effective)
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
