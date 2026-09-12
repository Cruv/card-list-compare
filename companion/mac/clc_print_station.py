#!/usr/bin/env python3
"""Native CLC print station. Python 3.9+, standard library, fixed CUPS commands."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from clc_station_alerts import RefeedAlerts, validate_alert_config
from clc_printer_health import parse_printer_health


HERE = Path(__file__).resolve().parent
COMPANION_VERSION = "2.53.1"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")
SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")
OPTION = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
VALUE = re.compile(r"[A-Za-z0-9_.:/+-]{1,100}\Z")
FIXED_OPTIONS = {"media": "Letter", "sides": "one-sided", "number-up": "1",
                 "print-scaling": "none", "fit-to-page": "false", "orientation-requested": "4"}
RESERVED_OPTIONS = set(FIXED_OPTIONS) | {"copies", "page-ranges", "page-set", "outputorder",
                                       "job-name", "job-hold-until", "job-sheets", "landscape"}
TERMINAL = {"completed", "failed", "canceled"}


class StationError(Exception):
    pass


def checked_id(value, label):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise StationError("Invalid " + label)
    return value


def private_file(path):
    path = Path(path).expanduser()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise StationError("File must be owned by this user, regular, and mode 600: " + str(path))
    return path


def private_directory(path):
    path = Path(path).expanduser().absolute()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise StationError("State directory must be owned by this user and mode 700: " + str(path))
    return path


def load_config(path):
    with private_file(path).open() as stream:
        config = json.load(stream)
    for flag in ("allow_http", "recipe_verified", "duplex_verified", "allow_unverified_printing", "refeed_notifications", "refeed_sound"):
        if type(config.get(flag, False)) is not bool:
            raise StationError(flag + " must be the JSON boolean true or false")
    config.setdefault("allow_unverified_printing", False)
    try:
        validate_alert_config(config)
    except ValueError as error:
        raise StationError(str(error)) from error
    checked_id(config.get("queue"), "CUPS queue")
    url = urllib.parse.urlsplit(config.get("server_url", ""))
    if (url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in {"", "/"}):
        raise StationError("server_url must be an HTTP(S) origin without credentials or a path")
    if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"} and not config.get("allow_http"):
        raise StationError("Use HTTPS; allow_http must be explicitly enabled for a trusted LAN")
    config["server_url"] = config["server_url"].rstrip("/")
    with private_file(config["station_token_file"]).open() as stream:
        token = stream.read().strip()
    if len(token) < 32 or any(c.isspace() for c in token):
        raise StationError("Station token must contain at least 32 characters and no whitespace")
    config["token"] = token
    recipes = config.get("approved_recipe_ids", [])
    if not isinstance(recipes, list) or not recipes:
        raise StationError("approved_recipe_ids must list at least one locally approved recipe")
    for recipe in recipes:
        checked_id(recipe, "recipe ID")
    options = config.setdefault("driver_options", {})
    if not isinstance(options, dict):
        raise StationError("driver_options must be a local option/value object")
    for key, value in options.items():
        if not OPTION.fullmatch(key) or not isinstance(value, str) or not VALUE.fullmatch(value):
            raise StationError("Invalid local CUPS option/value")
        if key.lower() in {x.lower() for x in RESERVED_OPTIONS}:
            raise StationError("The companion controls option " + key)
        if key.lower() == "pagesize" and value != "Letter":
            raise StationError("This recipe requires PageSize=Letter")
    for field in ("ordinary_output_order", "dfc_front_output_order", "dfc_back_output_order"):
        config.setdefault(field, "reverse")
        if config[field] not in {"normal", "reverse"}:
            raise StationError(field + " must be normal or reverse")
    config.setdefault("poll_seconds", 5)
    config.setdefault("max_pdf_bytes", 1024 * 1024 * 1024)
    config.setdefault("max_job_bytes", 2 * 1024 * 1024 * 1024)
    config.setdefault("retention_days", 7)
    if not 2 <= config["poll_seconds"] <= 60:
        raise StationError("poll_seconds must be between 2 and 60")
    for name in ("max_pdf_bytes", "max_job_bytes"):
        if type(config[name]) is not int or not 1024 <= config[name] <= 2 * 1024**3:
            raise StationError(name + " must be a bounded positive byte count (at most 2 GiB)")
    if type(config["retention_days"]) is not int or not 1 <= config["retention_days"] <= 90:
        raise StationError("retention_days must be between 1 and 90")
    return config


def recipe_fingerprint(config):
    fields = ["queue", "driver_options", "ordinary_output_order", "dfc_front_output_order",
              "dfc_back_output_order"]
    recipe = {key: config.get(key) for key in fields}
    recipe["fixed_options"] = FIXED_OPTIONS
    return hashlib.sha256(json.dumps(recipe, sort_keys=True).encode()).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise StationError("Redirect refused; station credentials stay on the configured CLC origin")


class Client:
    def __init__(self, config, opener=None):
        self.config = config
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def url(self, path):
        url = urllib.parse.urljoin(self.config["server_url"] + "/", path)
        parsed, origin = urllib.parse.urlsplit(url), urllib.parse.urlsplit(self.config["server_url"])
        if ((parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)
                or parsed.username or parsed.password or parsed.fragment):
            raise StationError("Artifact/API URL is outside the configured CLC origin")
        return url

    def open(self, path, body=None):
        headers = {"Authorization": "Bearer " + self.config["token"], "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url(path), data=data, headers=headers)
        try:
            return self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            raise StationError("CLC returned HTTP " + str(error.code)) from None
        except urllib.error.URLError as error:
            raise StationError("CLC connection failed: " + str(error.reason)) from None

    def json(self, path, body=None):
        with self.open(path, body) as response:
            content = response.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise StationError("CLC JSON response exceeds the limit")
        result = json.loads(content)
        if not isinstance(result, dict):
            raise StationError("Unexpected CLC JSON response")
        return result

    def claim(self):
        return self.json("/api/print-station/claim", {"maxArtifacts": 37}).get("job")

    def management_heartbeat(self, status):
        return self.json("/api/print-station/heartbeat", status)

    def get_job(self, job_id):
        return self.json("/api/print-station/jobs/" + checked_id(job_id, "job ID")).get("job")

    def report(self, job, event):
        return self.json("/api/print-station/jobs/" + job["id"] + "/report", event)

    def download(self, artifact, target, heartbeat=lambda: None):
        expected = artifact["sha256"].lower()
        if target.exists() and digest_file(target) == expected:
            return target
        temp = None
        try:
            with self.open(artifact["downloadUrl"]) as response:
                content_type = response.headers.get("Content-Type", "").split(";")[0].strip()
                if content_type not in {"application/pdf", "application/octet-stream"}:
                    raise StationError("Artifact response is not a PDF")
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                    temp = Path(output.name)
                    sha, size, prefix, last_beat = hashlib.sha256(), 0, b"", time.monotonic()
                    while True:
                        block = response.read(256 * 1024)
                        if not block:
                            break
                        if not prefix:
                            prefix = block[:5]
                        size += len(block)
                        if size > self.config["max_pdf_bytes"] or size > artifact["size"]:
                            raise StationError("PDF exceeds its declared size or the local size limit")
                        output.write(block)
                        sha.update(block)
                        if time.monotonic() - last_beat > 10:
                            heartbeat()
                            last_beat = time.monotonic()
                    output.flush()
                    os.fsync(output.fileno())
            if prefix != b"%PDF-" or size != artifact["size"] or sha.hexdigest() != expected:
                raise StationError("PDF checksum, signature or size does not match the immutable artifact")
            os.replace(temp, target)
            fsync_directory(target.parent)
            return target
        finally:
            if temp and temp.exists():
                temp.unlink()


def digest_file(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(256 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def fsync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Ledger:
    def __init__(self, directory):
        self.directory = private_directory(directory)
        self.db = sqlite3.connect(str(self.directory / "station.sqlite3"))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, payload TEXT NOT NULL, recipe_hash TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'active', detail TEXT, updated REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS passes (
            job_id TEXT NOT NULL, artifact_id TEXT NOT NULL, phase TEXT NOT NULL,
            state TEXT NOT NULL, title TEXT NOT NULL, spooler_id TEXT, detail TEXT,
            resume_requested INTEGER NOT NULL DEFAULT 0, cups_started INTEGER,
            PRIMARY KEY(job_id, artifact_id, phase));
          CREATE TABLE IF NOT EXISTS events (
            event_key TEXT PRIMARY KEY, payload TEXT NOT NULL, reply TEXT);
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        if "cups_started" not in {row[1] for row in self.db.execute("PRAGMA table_info(passes)")}:
            # Older ambiguous passes have no proof that CUPS was never called.
            self.write("ALTER TABLE passes ADD COLUMN cups_started INTEGER")
        os.chmod(self.directory / "station.sqlite3", 0o600)

    @contextlib.contextmanager
    def worker_lock(self):
        with (self.directory / "worker.lock").open("a") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise StationError("Another station worker is already running") from None
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def write(self, sql, args=()):
        with self.db:
            self.db.execute(sql, args)

    def current(self):
        return self.db.execute("SELECT * FROM jobs WHERE state NOT IN ('completed','failed','canceled') ORDER BY updated LIMIT 1").fetchone()

    def passes(self, job_id):
        return self.db.execute("SELECT * FROM passes WHERE job_id=? ORDER BY rowid", (job_id,)).fetchall()

    def set_pass(self, entry, state, detail=None, spooler_id=None):
        self.write("UPDATE passes SET state=?,detail=?,spooler_id=COALESCE(?,spooler_id) WHERE job_id=? AND artifact_id=? AND phase=?",
                   (state, detail, spooler_id, entry["job_id"], entry["artifact_id"], entry["phase"]))

    def set_job(self, job_id, state, detail=None):
        self.write("UPDATE jobs SET state=?,detail=?,updated=? WHERE id=?", (state, detail, time.time(), job_id))

    def event(self, job, entry, state, renew=False, **extra):
        base = "/".join([job["id"], entry["artifact_id"], entry["phase"], state, extra.get("resolution", "event")])
        prefix = base + "/"
        existing = self.db.execute("SELECT * FROM events WHERE substr(event_key,1,?)=? ORDER BY rowid DESC LIMIT 1", (len(prefix), prefix)).fetchone()
        if existing and (existing["reply"] is None or not renew):
            return existing["event_key"], json.loads(existing["payload"]), json.loads(existing["reply"]) if existing["reply"] else None
        key = base + "/" + uuid.uuid4().hex
        event = {"claimToken": job["claimToken"], "eventId": uuid.uuid4().hex, "state": state,
                 "artifactId": entry["artifact_id"], "phase": entry["phase"], **extra}
        self.write("INSERT INTO events(event_key,payload) VALUES(?,?)", (key, json.dumps(event)))
        return key, event, None

    def paused(self):
        row = self.db.execute("SELECT value FROM settings WHERE key='paused'").fetchone()
        return bool(row and row[0] == "1")


def checked_job(job, config):
    checked_id(job.get("id"), "job ID")
    if not isinstance(job.get("claimToken"), str) or not 16 <= len(job["claimToken"]) <= 512:
        raise StationError("Job has no valid durable claim token")
    if job.get("recipeId") not in config["approved_recipe_ids"]:
        raise StationError("Job recipe is not locally approved")
    if not SHA256.fullmatch(job.get("manifestSha256", "")):
        raise StationError("Job has no immutable manifest SHA-256")
    artifacts = job.get("artifacts", [])
    if not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 37:
        raise StationError("Expected one to 37 finished PDF artifacts")
    packets = [item for item in artifacts if "packetIndex" in item or "packetCount" in item]
    ids, size = set(), 0
    for artifact in artifacts:
        checked_id(artifact.get("id"), "artifact ID")
        if artifact["id"] in ids or artifact.get("kind") not in {"ordinary", "dfc"}:
            raise StationError("Duplicate artifact ID or unsupported artifact kind")
        ids.add(artifact["id"])
        if not SHA256.fullmatch(artifact.get("sha256", "")):
            raise StationError("Artifact has no SHA-256")
        if type(artifact.get("size")) is not int or not 1 <= artifact["size"] <= config["max_pdf_bytes"]:
            raise StationError("Invalid or oversized PDF artifact")
        size += artifact["size"]
        count = artifact.get("pageCount")
        if type(count) is not int or not 1 <= count <= 1000:
            raise StationError("Invalid PDF page count")
        if not isinstance(artifact.get("downloadUrl"), str):
            raise StationError("Artifact has no download URL")
        fronts = artifact.get("frontPages")
        backs = artifact.get("backPages", [])
        if artifact["kind"] == "ordinary":
            if fronts != list(range(1, count + 1)) or backs:
                raise StationError("Ordinary artifact must contain only all front pages")
        elif count % 2 or fronts != list(range(1, count + 1, 2)) or backs != list(range(2, count + 1, 2)):
            raise StationError("DFC artifact must identify alternating front/back page pairs")
        if artifact in packets:
            index = packets.index(artifact) + 1
            if (artifact["kind"] != "dfc" or count != 2 or artifact.get("sheetCount") != 1
                    or type(artifact.get("packetIndex")) is not int or artifact["packetIndex"] != index
                    or type(artifact.get("packetCount")) is not int or artifact["packetCount"] != len(packets)
                    or artifact["id"] != "double-faced-" + str(index).zfill(3)
                    or type(artifact.get("cardCount")) is not int or not 1 <= artifact["cardCount"] <= 7
                    or not isinstance(artifact.get("label"), str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _/-]{0,63}", artifact["label"])):
                raise StationError("Invalid double-sided packet identity or page count")
    if size > config["max_job_bytes"]:
        raise StationError("Job PDF size exceeds the local storage limit")
    return job


def command(args, timeout=30):
    # Do not inherit a remote CUPS_SERVER or printer override from the shell.
    env = {key: value for key, value in os.environ.items() if not key.startswith("CUPS_") and key not in {"LPDEST", "PRINTER"}}
    env.update({"LC_ALL": "C", "LANG": "C"})
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False, env=env, text=True)
    if result.returncode:
        raise StationError(Path(args[0]).name + " failed: " + result.stderr.strip()[:500])
    return result.stdout


def parse_ipp_jobs(text, queue):
    try:
        document = plistlib.loads(text.encode() if isinstance(text, str) else text)
        tests = document["Tests"]
        if len(tests) != 1 or not tests[0].get("Successful"):
            raise ValueError("Get-Jobs failed")
        groups = tests[0]["ResponseAttributes"]
        jobs = []
        for group in groups:
            if "job-id" not in group:
                continue
            number, title, state_value = group.get("job-id"), group.get("job-name"), group.get("job-state")
            if type(number) is not int or not isinstance(title, str) or type(state_value) is not int:
                raise ValueError("Missing job identity/state")
            uri = group.get("job-printer-uri", "")
            if urllib.parse.urlsplit(uri).path != "/printers/" + queue:
                continue
            jobs.append({"id": queue + "-" + str(number), "title": title, "state": state_value})
        return jobs
    except (KeyError, ValueError, TypeError, plistlib.InvalidFileException):
        raise StationError("Cannot read authoritative CUPS job titles/states") from None


class Cups:
    def __init__(self, config, runner=command):
        self.config, self.runner = config, runner

    def doctor(self):
        queue = self.config["queue"]
        destinations = self.runner(["/usr/bin/lpstat", "-h", "localhost", "-e"])
        if queue not in destinations.splitlines():
            raise StationError("Configured Epson queue is not installed: " + queue)
        status_text = self.runner(["/usr/bin/lpstat", "-h", "localhost", "-p", queue, "-l"])
        accepting = self.runner(["/usr/bin/lpstat", "-h", "localhost", "-a", queue])
        options = self.runner(["/usr/bin/lpoptions", "-h", "localhost", "-p", queue, "-l"])
        supported = {}
        for line in options.splitlines():
            match = re.match(r"([^/:\s]+)(?:/[^:]+)?:\s*(.*)", line)
            if match:
                supported[match[1]] = {item.lstrip("*") for item in match[2].split()}
        for key, value in self.config["driver_options"].items():
            if key not in supported or value not in supported[key]:
                raise StationError("Driver does not advertise configured option " + key + "=" + value)
        if "disabled" in status_text or "not accepting" in accepting:
            raise StationError("Configured printer is paused or not accepting jobs")
        self.jobs()  # Validate the read-only reconciliation path before accepting work.
        return {"queue": queue, "status": status_text, "accepting": accepting,
                "advertised_options": options, "configured_options": self.config["driver_options"],
                "fixed_options": FIXED_OPTIONS, "recipe_verified": bool(self.config.get("recipe_verified")),
                "duplex_verified": bool(self.config.get("duplex_verified")),
                "recipe_fingerprint": recipe_fingerprint(self.config)}

    def status(self, spooler_id=None):
        # Fixed local destination and operation; no printer settings or job changes.
        data = self.runner(["/usr/bin/ipptool", "-X", "-T", "15",
                            "ipp://localhost/printers/" + self.config["queue"], str(HERE / "get-printer.test")])
        state = None
        if spooler_id:
            match = next((item for item in self.jobs() if item["id"] == spooler_id), None)
            if match:
                state = match["state"]
        health = parse_printer_health(data, state)
        if spooler_id and state is None and health["ok"]:
            return {"ok": False, "known": False, "reasons": [], "message": "Active print pass is not visible in CUPS; reconcile its receipt in CLC"}
        return health

    def jobs(self):
        queue = self.config["queue"]
        # macOS lpstat does not reliably expose job-name. Cross-check IDs there,
        # then use native ipptool's structured, read-only Get-Jobs for exact titles.
        listing = self.runner(["/usr/bin/lpstat", "-h", "localhost", "-W", "all", "-o", queue])
        ids = {line.split()[0] for line in listing.splitlines() if line.strip() and not line[0].isspace()}
        data = self.runner(["/usr/bin/ipptool", "-X", "-T", "15", "-d", "clc_user=" + pwd.getpwuid(os.getuid()).pw_name,
                            "ipp://localhost/printers/" + queue, str(HERE / "get-jobs.test")])
        jobs = parse_ipp_jobs(data, queue)
        for job in jobs:
            # A newly completed job can disappear between reads; the IPP state
            # remains authoritative. Active mismatches must be reconciled later.
            if job["state"] < 7 and job["id"] not in ids:
                raise StationError("CUPS queue changed during inspection; retry reconciliation")
        return jobs

    def args(self, artifact, phase, title, path):
        pages = artifact["backPages"] if phase == "backs" else artifact["frontPages"]
        order = (self.config["ordinary_output_order"] if artifact["kind"] == "ordinary"
                 else self.config["dfc_back_output_order" if phase == "backs" else "dfc_front_output_order"])
        options = {**self.config["driver_options"], **FIXED_OPTIONS, "outputorder": order}
        args = ["/usr/bin/lp", "-h", "localhost", "-d", self.config["queue"], "-n", "1", "-t", title,
                "-P", ",".join(str(page) for page in pages)]
        for key, value in sorted(options.items()):
            args.extend(["-o", key + "=" + value])
        return args + [str(path.absolute())]

    def submit(self, artifact, phase, title, path):
        output = self.runner(self.args(artifact, phase, title, path))
        match = re.search(r"request id is (" + re.escape(self.config["queue"]) + r"-\d+)\b", output)
        if not match:
            raise StationError("lp returned no recognizable spooler job ID; reconcile before any retry")
        return match[1]


class Station:
    def __init__(self, config, client=None, cups=None, ledger=None, alerts=None):
        self.config = config
        self.client = client or Client(config)
        self.cups = cups or Cups(config)
        self.ledger = ledger or Ledger(config["state_dir"])
        self.management = None
        self.alerts = alerts if alerts is not None else RefeedAlerts(self.ledger, config)

    def waiting_for_refeed(self, job, pending):
        """Surface durable physical attention even while paused or disconnected."""
        if pending["phase"] != "backs" or pending["state"] != "pending" or pending["resume_requested"]:
            return False
        if job.get("state") in TERMINAL or job.get("state") == "expired":
            return False
        remote = next((step for step in job.get("steps", []) if step["artifactId"] == pending["artifact_id"]
                       and step["phase"] == "backs"), {})
        if remote.get("refeedConfirmed") or remote.get("state") == "completed":
            return False
        front = next((entry for entry in self.ledger.passes(job["id"]) if entry["artifact_id"] == pending["artifact_id"]
                      and entry["phase"] == "fronts"), None)
        if front is None or front["state"] != "completed":
            raise StationError("A back pass cannot wait for refeed before its fronts complete")
        artifact = next(item for item in job["artifacts"] if item["id"] == pending["artifact_id"])
        label = artifact.get("label") or artifact["id"]
        detail = "Flip and reload only " + label + "; confirm this packet in CLC Print Station"
        self.ledger.set_job(job["id"], "awaiting_refeed", detail)
        notice = self.alerts.notify(job, artifact)
        if self.management and notice.get("message") and notice.get("level"):
            self.management.event(notice["level"], notice["message"])
        return True

    def adopt(self, job):
        checked_job(job, self.config)
        existing = self.ledger.db.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
        if existing:
            original = json.loads(existing["payload"])
            if original["manifestSha256"] != job["manifestSha256"] or original["claimToken"] != job["claimToken"]:
                raise StationError("Previously seen job changed its manifest or claim token; refusing to print")
            return
        steps = {(step["artifactId"], step["phase"]): step for step in job.get("steps", [])}
        with self.ledger.db:
            self.ledger.db.execute("INSERT INTO jobs(id,payload,recipe_hash,updated) VALUES(?,?,?,?)",
                                   (job["id"], json.dumps(job), recipe_fingerprint(self.config), time.time()))
            # Ordinary fronts precede DFC batches; each DFC batch finishes both
            # passes before another artifact can enter the physical queue.
            for artifact in sorted(job["artifacts"], key=lambda a: a["kind"] == "dfc"):
                for phase in (["fronts", "backs"] if artifact["kind"] == "dfc" else ["fronts"]):
                    step = steps.get((artifact["id"], phase), {})
                    state_value = step.get("state", "pending")
                    if state_value not in {"pending", "submitting", "submitted", "completed", "uncertain", "failed"}:
                        raise StationError("Unknown server submission state")
                    # Server submission intent survives even loss of this Mac's
                    # ledger. Recover from CUPS, never treat it as a fresh pass.
                    local = "intent" if state_value == "submitting" else state_value
                    title = "CLC-" + hashlib.sha256((job["id"] + "/" + artifact["id"] + "/" + phase).encode()).hexdigest()[:32]
                    self.ledger.db.execute("INSERT INTO passes(job_id,artifact_id,phase,state,title,spooler_id,cups_started) VALUES(?,?,?,?,?,?,?)",
                                           (job["id"], artifact["id"], phase, local, title, step.get("spoolerId"),
                                            0 if state_value == "pending" else 1))

    def retire_canceled_before_cups(self, original, fresh):
        """Release only a verified cancellation with durable proof of no CUPS attempt."""
        if (not isinstance(fresh, dict) or fresh.get("state") != "canceled"
                or any(fresh.get(key) != original.get(key) for key in ("id", "manifestSha256", "claimToken"))):
            return False
        entries = self.ledger.passes(original["id"])
        if not entries or any(entry["cups_started"] != 0 or entry["spooler_id"]
                              or entry["state"] not in {"pending", "intent", "uncertain"} for entry in entries):
            return False
        steps = fresh.get("steps")
        expected = {(entry["artifact_id"], entry["phase"]) for entry in entries}
        if (not isinstance(steps, list) or len(steps) != len(expected)
                or any(not isinstance(step, dict) or step.get("state") != "pending"
                       or not isinstance(step.get("artifactId"), str) or not isinstance(step.get("phase"), str)
                       or any(step.get(key) for key in ("spoolerId", "submissionEventId", "submittingAt", "submittedAt", "completedAt"))
                       for step in steps)
                or {(step.get("artifactId"), step.get("phase")) for step in steps} != expected):
            return False
        # Also retain successful authorization receipts: an older companion
        # resumed after rollback may not know about the new local boundary.
        prefix = original["id"] + "/"
        receipts = self.ledger.db.execute("SELECT payload FROM events WHERE substr(event_key,1,?)=? AND reply IS NOT NULL",
                                          (len(prefix), prefix))
        if any(json.loads(row["payload"]).get("state") == "submitting" for row in receipts):
            return False
        with self.ledger.db:
            self.ledger.db.execute("UPDATE jobs SET state='canceled',payload=?,detail=?,updated=? WHERE id=?",
                                   (json.dumps(fresh), "Canceled on CLC before any local CUPS attempt", time.time(), original["id"]))
        return True

    def report(self, job, entry, state_value, **extra):
        remote = next((step for step in job.get("steps", []) if step["artifactId"] == entry["artifact_id"]
                       and step["phase"] == entry["phase"]), {})
        desired = extra.get("resolution", state_value)
        renew = state_value in {"uncertain", "reconciled"} and remote.get("state") != desired
        key, event, reply = self.ledger.event(job, entry, state_value, renew=renew, **extra)
        if reply is not None:
            return {**reply, "replayed": True}
        reply = self.client.report(job, event)
        if not isinstance(reply.get("job"), dict) or reply["job"].get("id") != job["id"]:
            raise StationError("CLC did not acknowledge the expected job")
        with self.ledger.db:
            self.ledger.db.execute("UPDATE events SET reply=? WHERE event_key=?", (json.dumps(reply), key))
            self.ledger.db.execute("UPDATE jobs SET payload=?,updated=? WHERE id=?",
                                   (json.dumps(reply["job"]), time.time(), job["id"]))
        return reply

    def heartbeat(self, job):
        self.client.report(job, {"claimToken": job["claimToken"], "eventId": uuid.uuid4().hex, "state": "heartbeat"})

    def uncertain(self, job, entry, detail):
        self.ledger.set_pass(entry, "uncertain", detail)
        self.ledger.set_job(job["id"], "uncertain", detail)
        try:
            self.report(job, entry, "uncertain", detail=detail)
        except (StationError, OSError):
            pass  # Durable local state still blocks every later physical job.

    def observe(self, job, entry):
        remote = next((step for step in job.get("steps", []) if step["artifactId"] == entry["artifact_id"]
                       and step["phase"] == entry["phase"]), {})
        matches = [item for item in self.cups.jobs() if item["title"] == entry["title"]]
        if len(matches) != 1:
            self.uncertain(job, entry, "No unique CUPS title match. History may have expired; do not automatically reprint.")
            return
        match = matches[0]
        if entry["spooler_id"] and entry["spooler_id"] != match["id"]:
            self.uncertain(job, entry, "CUPS title and recorded spooler ID disagree")
            return
        state_value = match["state"]
        if state_value in {7, 8}:
            detail = "CUPS canceled or aborted " + match["id"] + "; clear the paper before releasing this station"
            self.ledger.set_pass(entry, "failed", detail, match["id"])
            self.ledger.set_job(job["id"], "uncertain", detail)
            # Even a confirmed cancellation may have left partially printed
            # paper. Keep the local station held if reporting fails, too.
            self.report(job, entry, "uncertain" if remote.get("state") in {"submitting", "uncertain"} else "failed",
                        spoolerId=match["id"], detail=detail)
            return
        if state_value not in {3, 4, 5, 6, 9}:
            self.uncertain(job, entry, "Unrecognized CUPS job state")
            return
        recovering = entry["state"] in {"intent", "uncertain"} or remote.get("state") == "uncertain"
        if recovering:
            self.ledger.set_pass(entry, entry["state"], spooler_id=match["id"])
            self.report(job, entry, "reconciled", spoolerId=match["id"],
                        resolution="completed" if state_value == 9 else "submitted", detail="Exact unique CUPS title and job ID observed")
        else:
            if remote.get("state") not in {"submitted", "completed"} or remote.get("spoolerId") != match["id"]:
                self.report(job, entry, "submitted", spoolerId=match["id"])
        if state_value == 9:
            if not recovering:
                self.report(job, entry, "completed", spoolerId=match["id"])
            self.ledger.set_pass(entry, "completed", spooler_id=match["id"])
            self.ledger.set_job(job["id"], "active")
        else:
            self.ledger.set_pass(entry, "submitted", spooler_id=match["id"])
            self.ledger.set_job(job["id"], "active", "Waiting for spooler completion: " + match["id"])

    def poll_once(self, allow_submit=True):
        current = self.ledger.current()
        if not current:
            if self.ledger.paused():
                return "paused"
            if not allow_submit:
                return "waiting for station management connection"
            if not self.config.get("recipe_verified") and self.config.get("allow_unverified_printing") is not True:
                return "waiting for local printer and cutting proof"
            job = self.client.claim()
            if job is None:
                return "idle"
            self.adopt(job)
            current = self.ledger.current()
            if current is None:
                # A replay of a locally completed/failed job is never a reprint.
                return "already processed"
        job = json.loads(current["payload"])
        if current["recipe_hash"] != recipe_fingerprint(self.config):
            raise StationError("Local queue/options changed during this job; restore its original recipe before continuing")
        pending = next((entry for entry in self.ledger.passes(job["id"]) if entry["state"] != "completed"), None)
        if pending is None:
            self.ledger.set_job(job["id"], "completed", "All passes confirmed completed by CUPS")
            return "completed"
        self.waiting_for_refeed(job, pending)
        fresh = self.client.get_job(job["id"])
        if (not isinstance(fresh, dict) or fresh.get("id") != job["id"]
                or fresh.get("manifestSha256") != job["manifestSha256"] or fresh.get("claimToken") != job["claimToken"]):
            raise StationError("Server job identity changed; refusing to continue")
        job = fresh
        self.ledger.write("UPDATE jobs SET payload=? WHERE id=?", (json.dumps(job), job["id"]))
        if self.retire_canceled_before_cups(job, fresh):
            return "canceled before submission"
        remote = {(step["artifactId"], step["phase"]): step for step in job.get("steps", [])}
        for entry in self.ledger.passes(job["id"]):
            step = remote.get((entry["artifact_id"], entry["phase"]), {})
            if entry["state"] != "completed" and step.get("state") == "completed" and step.get("spoolerId"):
                if entry["spooler_id"] and entry["spooler_id"] != step["spoolerId"]:
                    self.ledger.set_job(job["id"], "uncertain", "CLC completion and local spooler ID disagree")
                    return "paper clearance required"
                # A lost acknowledgement for any pass (including DFC fronts)
                # survives expired CUPS history in CLC's durable completion.
                self.ledger.set_pass(entry, "completed", spooler_id=step["spoolerId"])
                self.ledger.set_job(job["id"], "active")
        pending = next((entry for entry in self.ledger.passes(job["id"]) if entry["state"] != "completed"), None)
        if pending is None:
            self.ledger.set_job(job["id"], "completed", "Recovered durable spooler completion acknowledgements from CLC")
            return "completed"
        if job.get("state") in TERMINAL or job.get("state") == "expired":
            if all(entry["state"] == "pending" for entry in self.ledger.passes(job["id"])):
                self.ledger.set_job(job["id"], "canceled", "Job ended on CLC before local submission")
                return "canceled before submission"
            self.ledger.set_job(job["id"], "uncertain", "CLC job ended after printing began; check output and clear paper")
            return "paper clearance required"
        self.heartbeat(job)
        if pending["state"] in {"intent", "submitted", "uncertain"}:
            self.observe(job, pending)
            return "reconciled"
        if pending["state"] == "failed":
            return "paper clearance required"
        if self.waiting_for_refeed(job, pending):
            return "awaiting_refeed"
        if self.ledger.paused():
            return "paused"
        if not allow_submit:
            return "waiting for station management connection"
        artifact = next(item for item in job["artifacts"] if item["id"] == pending["artifact_id"])
        if not self.config.get("recipe_verified") and self.config.get("allow_unverified_printing") is not True:
            raise StationError("The local printer/color recipe has not been physically verified")
        if (artifact["kind"] == "dfc" and not self.config.get("duplex_verified")
                and self.config.get("allow_unverified_printing") is not True):
            raise StationError("The local DFC page order and refeed orientation have not been physically verified")
        if pending["phase"] == "backs":
            remote = next((step for step in job.get("steps", []) if step["artifactId"] == pending["artifact_id"]
                           and step["phase"] == "backs"), {})
            if not remote.get("refeedConfirmed"):
                self.report(job, pending, "refeed", detail="Operator explicitly confirmed flip/reload on this Mac")
            self.ledger.set_job(job["id"], "active")
        self.cups.doctor()
        directory = private_directory(self.ledger.directory / job["id"])
        path = directory / (artifact["id"] + ".pdf")
        if not path.exists() and shutil.disk_usage(directory).free < artifact["size"] + 64 * 1024 * 1024:
            raise StationError("Not enough free disk space for the verified PDF")
        def download_heartbeat():
            self.heartbeat(job)
            if self.management:
                self.management.sync(check_printer=False)
        self.client.download(artifact, path, download_heartbeat)
        self.heartbeat(job)
        # A large PDF may take several minutes to download. Refresh operator
        # controls immediately before any submission intent is committed.
        if self.management:
            self.management.sync(check_printer=False)
        if self.ledger.paused():
            return "paused"
        # This transaction commits before the network submission authorization,
        # and both are durable before the local spooler is contacted.
        self.ledger.set_pass(pending, "intent")
        try:
            reply = self.report(job, pending, "submitting", detail="Durable local intent recorded before lp")
            if reply.get("replayed"):
                self.uncertain(job, pending, "Submission authorization was replayed; reconcile CUPS before proceeding")
                return "uncertain"
            # Commit before calling lp. A crash or timeout after this point is
            # always a possible physical attempt, even without a spooler ID.
            self.ledger.write("UPDATE passes SET cups_started=1 WHERE job_id=? AND artifact_id=? AND phase=?",
                              (job["id"], pending["artifact_id"], pending["phase"]))
            spooler_id = self.cups.submit(artifact, pending["phase"], pending["title"], path)
            self.ledger.set_pass(pending, "submitted", spooler_id=spooler_id)
        except (StationError, OSError, subprocess.TimeoutExpired) as error:
            if all(entry["cups_started"] == 0 for entry in self.ledger.passes(job["id"])):
                try:
                    if self.retire_canceled_before_cups(job, self.client.get_job(job["id"])):
                        return "canceled before submission"
                except (StationError, OSError, ValueError):
                    pass  # A failed lookup cannot establish that nothing printed.
            self.uncertain(job, pending, "Submission outcome uncertain: " + str(error))
            return "uncertain"
        # A reporting failure leaves the local submitted ID durable. The next
        # poll reconciles it and retries the same event, without calling lp again.
        self.report(job, pending, "submitted", spoolerId=spooler_id)
        return "submitted " + spooler_id

    def resume(self, job_id):
        checked_id(job_id, "job ID")
        row = self.ledger.db.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row or row["state"] != "awaiting_refeed":
            raise StationError("This job is not waiting for an operator refeed")
        entry = next((item for item in self.ledger.passes(job_id) if item["state"] != "completed"), None)
        if not entry or entry["phase"] != "backs" or entry["state"] != "pending":
            raise StationError("No unsubmitted back pass is eligible for refeed")
        self.ledger.write("UPDATE passes SET resume_requested=1 WHERE job_id=? AND artifact_id=? AND phase='backs'",
                          (job_id, entry["artifact_id"]))

    def release(self, job_id, paper_cleared):
        checked_id(job_id, "job ID")
        row = self.ledger.current()
        if not paper_cleared or not row or row["id"] != job_id or row["state"] != "uncertain":
            raise StationError("Only a blocked uncertain job can be released after clearing paper and unsafe CUPS jobs")
        original = json.loads(row["payload"])
        job = self.client.get_job(job_id)
        if (not isinstance(job, dict) or job.get("id") != job_id
                or job.get("manifestSha256") != original["manifestSha256"] or job.get("claimToken") != original["claimToken"]):
            raise StationError("Server job identity changed; refusing to release")
        detail = "Operator checked output, cleared paper and unsafe CUPS jobs; abandon without automatic reprint"
        if job.get("state") not in TERMINAL and job.get("state") != "expired":
            remote = next((step for step in job.get("steps", []) if step["state"] != "completed"), None)
            if not remote:
                raise StationError("CLC has no remaining pass to release")
            entry = next(item for item in self.ledger.passes(job_id)
                         if item["artifact_id"] == remote["artifactId"] and item["phase"] == remote["phase"])
            if remote["state"] in {"submitting", "submitted", "uncertain"}:
                job = self.report(job, entry, "reconciled", resolution="abandoned", paperCleared=True, detail=detail)["job"]
            elif remote["state"] == "pending":
                # Authorization may have been rejected before lp was called.
                # There is no disputed server intent to reconcile in that case.
                job = self.report(job, entry, "failed", detail=detail)["job"]
                if job.get("state") == "uncertain":
                    # Earlier passes may already have printed. CLC deliberately
                    # holds their paper until this same explicit clearance is
                    # recorded as an abandoned reconciliation.
                    job = self.report(job, entry, "reconciled", resolution="abandoned", paperCleared=True, detail=detail)["job"]
            else:
                raise StationError("CLC pass is not eligible for release")
        if job.get("state") not in TERMINAL and job.get("state") != "expired":
            raise StationError("CLC has not confirmed release; this station remains blocked")
        self.ledger.set_job(job_id, "failed", detail)

    def cleanup(self):
        cutoff = time.time() - self.config["retention_days"] * 86400
        for row in self.ledger.db.execute("SELECT id FROM jobs WHERE state IN ('completed','failed','canceled') AND updated<?", (cutoff,)):
            directory = self.ledger.directory / row["id"]
            if directory.is_dir() and not directory.is_symlink():
                shutil.rmtree(directory)
        # Keep job/pass/event tombstones permanently for duplicate prevention.


def dry_run(config, job):
    checked_job(job, config)
    cups = Cups(config)
    commands = []
    for artifact in job["artifacts"]:
        for phase in (["fronts", "backs"] if artifact["kind"] == "dfc" else ["fronts"]):
            path = Path(config["state_dir"]).expanduser() / job["id"] / (artifact["id"] + ".pdf")
            commands.append({"artifact": artifact["id"], "phase": phase,
                             "requires_operator_refeed": phase == "backs",
                             "argv": cups.args(artifact, phase, "CLC-DRY-RUN", path)})
    return {"dry_run": True, "claimed_jobs": 0, "spooler_submissions": 0, "commands": commands}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=COMPANION_VERSION)
    parser.add_argument("--config", default="~/.config/clc-print-station/config.json")
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("self-check", help="Check runtime imports and in-memory SQLite; never load config or contact CLC/CUPS")
    commands.add_parser("doctor", help="Read queue/options and reconciliation support; never print")
    run = commands.add_parser("run", help="Report station health and poll jobs; only verified, unpaused recipes can print")
    run.add_argument("--once", action="store_true")
    commands.add_parser("status", help="Show local durable job states")
    commands.add_parser("pause", help="Stop accepting/submitting new passes; do not cancel CUPS jobs")
    commands.add_parser("unpause", help="Allow the worker to accept/submit passes again")
    resume = commands.add_parser("resume", help="Confirm the DFC paper has been flipped and reloaded")
    resume.add_argument("job_id")
    release = commands.add_parser("release", help="Release a blocked job after checking output and clearing the paper")
    release.add_argument("job_id")
    release.add_argument("--paper-cleared", action="store_true", required=True)
    dry = commands.add_parser("dry-run", help="Preview a local claimed-job fixture; makes no network/CUPS calls")
    dry.add_argument("--manifest", required=True)
    launch = commands.add_parser("write-launch-agent", help="Write a launchd plist; do not install/load it")
    launch.add_argument("--output", required=True)
    token = commands.add_parser("set-token", help="Store the server's station token via a hidden prompt")
    token.add_argument("--file", required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    if args.action == "self-check":
        import ssl
        from clc_station_control import StationControl
        managed = False
        try:
            import clc_station_manager
            managed = callable(clc_station_manager.managed_status)
        except ImportError:
            pass
        ssl.create_default_context()
        with sqlite3.connect(":memory:") as connection:
            connection.execute("CREATE TABLE runtime_check(id INTEGER PRIMARY KEY)")
            connection.execute("INSERT INTO runtime_check VALUES(1)")
            if connection.execute("SELECT id FROM runtime_check").fetchone()[0] != 1:
                raise StationError("SQLite runtime check failed")
        if not callable(StationControl):
            raise StationError("Station controls are unavailable")
        print(json.dumps({"version": COMPANION_VERSION, "protocolVersion": 1,
                          "managedRuntime": managed, "networkRequests": 0, "printerSubmissions": 0}))
        return
    if args.action == "set-token":
        import getpass
        secret = getpass.getpass("CLC station token: ").strip()
        if len(secret) < 32 or any(c.isspace() for c in secret):
            raise StationError("Token must contain at least 32 characters and no whitespace")
        path = Path(args.file).expanduser()
        private_directory(path.parent)
        descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secret + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        print("Token stored privately; no printer settings changed.")
        return
    config = load_config(args.config)
    if args.action == "dry-run":
        job = json.loads(Path(args.manifest).expanduser().read_text())
        print(json.dumps(dry_run(config, job.get("job", job)), indent=2))
        return
    if args.action == "doctor":
        print(json.dumps(Cups(config).doctor(), indent=2))
        return
    if args.action == "write-launch-agent":
        state = private_directory(config["state_dir"])
        plist = {"Label": "local.clc.print-station", "RunAtLoad": True, "KeepAlive": True,
                 "ProgramArguments": [str(Path(sys.executable).resolve()), str(HERE / "clc_print_station.py"),
                                      "--config", str(Path(args.config).expanduser().absolute()), "run"],
                 "ThrottleInterval": 15, "StandardOutPath": str(state / "worker.log"),
                 "StandardErrorPath": str(state / "worker-error.log")}
        output = Path(args.output).expanduser()
        with output.open("xb") as stream:
            plistlib.dump(plist, stream)
        print("Wrote " + str(output) + "; launchd was not loaded.")
        return
    station = Station(config)
    if args.action == "status":
        jobs = [dict(row) for row in station.ledger.db.execute("SELECT id,state,detail,updated FROM jobs ORDER BY updated DESC LIMIT 20")]
        print(json.dumps({"paused": station.ledger.paused(), "jobs": jobs}, indent=2))
    elif args.action in {"pause", "unpause"}:
        station.ledger.write("INSERT OR REPLACE INTO settings(key,value) VALUES('paused',?)", ("1" if args.action == "pause" else "0",))
        print("Station " + ("paused" if args.action == "pause" else "unpaused") + "; existing CUPS jobs are unchanged.")
    elif args.action == "resume":
        station.resume(args.job_id)
        print("Refeed confirmed. The worker may submit this batch's back pass.")
    elif args.action == "release":
        with station.ledger.worker_lock():
            station.release(args.job_id, args.paper_cleared)
            print("Station released. This job will never be automatically reprinted.")
    elif args.action == "run":
        if sys.platform != "darwin":
            raise StationError("Physical station runs require macOS; use dry-run or tests on other platforms")
        with station.ledger.worker_lock():
            from clc_station_control import StationControl
            station.management = StationControl(station, COMPANION_VERSION)
            last_status = None
            while True:
                connected = False
                try:
                    station.management.sync()
                    connected = True
                except (StationError, OSError, ValueError, subprocess.TimeoutExpired) as error:
                    station.management.event("error", "Station connection: " + str(error))
                if station.management.restart_needed:
                    # Receipts remain durable if the final acknowledgement is
                    # lost. launchd's stable managed launcher selects the version.
                    try:
                        station.management.exchange(station.management.snapshot(), process=False)
                    except (StationError, OSError, ValueError, subprocess.TimeoutExpired):
                        pass
                    return 75
                try:
                    status_text = station.poll_once(allow_submit=connected)
                    station.cleanup()
                except (StationError, OSError, ValueError, subprocess.TimeoutExpired) as error:
                    status_text = "Waiting: " + str(error)
                if status_text != last_status:
                    station.management.event("error" if status_text.startswith("Waiting:") else "info", status_text)
                    print(station.management.safe_message(status_text), flush=True)
                    last_status = status_text
                if args.once:
                    break
                time.sleep(config["poll_seconds"])


if __name__ == "__main__":
    # The control module imports shared types; keep one identity when this file
    # is invoked as a script rather than imported by the fake-printer tests.
    sys.modules.setdefault("clc_print_station", sys.modules[__name__])
    try:
        sys.exit(main() or 0)
    except (StationError, OSError, ValueError) as error:
        print("CLC print station: " + str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(0)
