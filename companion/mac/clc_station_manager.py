#!/usr/bin/env python3
"""Versioned local installation and fixed-publisher updates for CLC Print Station.

No printer commands or CLC credentials are used for package downloads. Callers must
hold the station worker lock; this manager separately requires a paused, idle ledger.
"""
import argparse
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import posixpath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

PUBLISHER = "Cruv/card-list-compare"
RELEASE_API = "https://api.github.com/repos/" + PUBLISHER + "/releases/"
VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
MAX_ARCHIVE = 100 * 1024**2
MAX_EXPANDED = 600 * 1024**2
MAX_MEMBERS = 30000
LABEL = "local.clc.print-station"
MANIFEST_ASSET = "clc-print-station-manifest.json"
DEFAULT_CONFIG = "~/.config/clc-print-station/config.json"


class ManagerError(RuntimeError):
    pass


def version(value):
    if not isinstance(value, str) or len(value) > 40 or not VERSION.fullmatch(value):
        raise ManagerError("A stable numeric release version is required")
    return value


def architecture():
    machine = platform.machine()
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    if machine == "x86_64":
        # A universal terminal can be translated on Apple Silicon. Prefer native.
        if sys.platform == "darwin":
            result = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip() == "1":
                return "arm64"
        return "x86_64"
    raise ManagerError("Only Apple Silicon and Intel Macs are supported")


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(256 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def sync_dir(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, data):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private_dir(path):
    path = Path(path).expanduser().absolute()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ManagerError("Managed directories must belong to this user and have mode 700")
    return path


def read_config(path):
    path = Path(path).expanduser().absolute()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ManagerError("Configuration must be a private mode-600 file owned by this user")
    return json.loads(path.read_text())


def managed_root(config):
    return Path(config.get("managed_root") or Path(config["state_dir"]).expanduser() / "app").expanduser().absolute()


def selected(root, name="current"):
    pointer = Path(root) / name
    if not pointer.is_symlink():
        return None
    target = os.readlink(pointer)
    parts = PurePosixPath(target).parts
    if len(parts) != 2 or parts[0] != "versions":
        raise ManagerError("Invalid managed version selection")
    value = version(parts[1])
    if (Path(root) / target).resolve().parent != (Path(root) / "versions").resolve():
        raise ManagerError("Managed version escapes its installation")
    return value


def select(root, value, pointer="current"):
    value = version(value)
    root = Path(root)
    if not (root / "versions" / value / "bundle-manifest.json").is_file():
        raise ManagerError("Requested installed version is missing")
    temporary = root / ("." + pointer + "-" + str(os.getpid()))
    try:
        os.symlink("versions/" + value, temporary)
        os.replace(temporary, root / pointer)
        sync_dir(root)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


@contextlib.contextmanager
def manager_lock(root):
    root = private_dir(root)
    with (root / "manager.lock").open("a") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ManagerError("Another install or update is already running") from None
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def assert_idle(config, allow_missing=False):
    database = Path(config["state_dir"]).expanduser() / "station.sqlite3"
    if not database.exists():
        if allow_missing:
            return
        raise ManagerError("Station ledger is unavailable; update safety cannot be verified")
    try:
        connection = sqlite3.connect(database.absolute().as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            paused = connection.execute("SELECT value FROM settings WHERE key='paused'").fetchone()
            active = connection.execute("SELECT id FROM jobs WHERE state NOT IN ('completed','failed','canceled','backs_pending') LIMIT 1").fetchone()
            uncertain = connection.execute("""SELECT p.job_id FROM passes p LEFT JOIN jobs j ON j.id=p.job_id
                WHERE p.state IN ('intent','submitting','submitted','uncertain')
                AND (j.id IS NULL OR j.state NOT IN ('completed','failed','canceled')) LIMIT 1""").fetchone()
            if active or uncertain:
                raise ManagerError("Finish or reconcile every active print job and manual refeed before updating")
            if not paused or paused[0] != "1":
                raise ManagerError("Pause the station before changing its installed version")
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise ManagerError("Station ledger could not be checked safely") from error


def assert_workflow_compatible(config, target_version):
    """Old workers cannot safely schedule a ledger containing saved backs."""
    if tuple(map(int, version(target_version).split("."))) >= (2, 55, 0):
        return
    database = Path(config["state_dir"]).expanduser() / "station.sqlite3"
    if not database.exists():
        return
    try:
        with contextlib.closing(sqlite3.connect(database.absolute().as_uri() + "?mode=ro", uri=True, timeout=5)) as connection:
            saved = connection.execute("SELECT payload FROM jobs WHERE state NOT IN ('completed','failed','canceled')")
            if any(json.loads(row[0]).get("workflow") == "deferred-backs-v1" for row in saved):
                raise ManagerError("Finish or cancel saved backs before installing a companion older than 2.55.0")
    except (sqlite3.Error, ValueError) as error:
        raise ManagerError("Saved print workflow compatibility could not be checked safely") from error


def safe_name(name):
    parts = PurePosixPath(name).parts
    if not name or not parts or name.startswith("/") or "\\" in name or "\0" in name or any(p in {"..", "."} for p in parts):
        raise ManagerError("Unsafe archive path")
    return PurePosixPath(*parts)


def safe_extract(archive, directory):
    """Bound bytes before extraction; allow only contained, non-dangling runtime links."""
    directory = Path(directory).resolve()
    if any(directory.iterdir()):
        raise ManagerError("Archive staging directory must be empty")
    members, expanded = [], 0
    with tarfile.open(archive, "r|gz") as scan:
        for member in scan:
            expanded += member.size
            members.append(member)
            if len(members) > MAX_MEMBERS or expanded > MAX_EXPANDED:
                raise ManagerError("Archive exceeds extraction limits")
    with tarfile.open(archive, "r:gz") as stream:
        names, links = {}, set()
        for member in members:
            name = safe_name(member.name)
            if str(name) in names or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ManagerError("Archive has duplicate paths or unsupported file types")
            if member.size < 0:
                raise ManagerError("Invalid archive size")
            names[str(name)] = member
            if member.issym() or member.islnk():
                links.add(str(name))
                link = member.linkname
                if link.startswith("/") or "\\" in link or "\0" in link:
                    raise ManagerError("Unsafe archive link")
                target = posixpath.normpath(posixpath.join(str(name.parent), link) if member.issym() else link)
                if target == ".." or target.startswith("../"):
                    raise ManagerError("Archive link escapes staging")
        for name, member in names.items():
            if any(str(parent) in links for parent in PurePosixPath(name).parents):
                raise ManagerError("Archive writes through a link")
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            elif member.isfile():
                with stream.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 256 * 1024)
                os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
        for name in links:
            member = names[name]
            target = directory / name
            if member.issym():
                os.symlink(member.linkname, target)
            else:
                source = directory / member.linkname
                if not source.is_file() or source.is_symlink():
                    raise ManagerError("Unsupported archive hard link")
                os.link(source, target)
        for name in links:
            target = directory / name
            try:
                resolved = target.resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise ManagerError("Archive has a dangling or cyclic link") from error
            if not resolved.is_relative_to(directory):
                raise ManagerError("Archive link escapes staging")


def bundle_files(directory):
    root = Path(directory)
    result = {}
    for path in sorted(root.rglob("*")):
        name = path.relative_to(root).as_posix()
        if name == "bundle-manifest.json":
            continue
        if path.is_symlink():
            if not path.resolve(strict=True).is_relative_to(root.resolve()):
                raise ManagerError("Bundle has an external symbolic link")
            result[name] = {"link": os.readlink(path)}
        elif path.is_file():
            result[name] = {"sha256": digest(path), "size": path.stat().st_size}
    return result


def verify_bundle(directory, expected_version=None, expected_arch=None):
    root = Path(directory)
    data = json.loads((root / "bundle-manifest.json").read_text())
    if data.get("formatVersion") != 1 or data.get("publisher") != PUBLISHER:
        raise ManagerError("Unsupported package manifest or publisher")
    value = version(data.get("version"))
    if expected_version and value != expected_version or expected_arch and data.get("architecture") != expected_arch:
        raise ManagerError("Package version or architecture does not match the reviewed release")
    if data.get("files") != bundle_files(root):
        raise ManagerError("Package files do not match their manifest checksums")
    for name in ["python/bin/python3", "clc_print_station.py", "clc_station_manager.py", "clc_station_control.py", "get-jobs.test"]:
        if not (root / name).is_file():
            raise ManagerError("Package lacks its self-contained runtime or station code")
    if tuple(map(int, value.split("."))) >= (2, 48, 0) and not (root / "clc_station_alerts.py").is_file():
        raise ManagerError("Package lacks its flip notification helper")
    if tuple(map(int, value.split("."))) >= (2, 53, 0):
        if not all((root / name).is_file() for name in ("clc_printer_health.py", "get-printer.test")):
            raise ManagerError("Package lacks its read-only printer status support")
    return data


def bundle_health(directory, expected_version):
    root = Path(directory)
    result = subprocess.run([str(root / "python/bin/python3"), "-B", "-E", "-s",
                             str(root / "clc_print_station.py"), "self-check"],
                            capture_output=True, text=True, timeout=30)
    try:
        report = json.loads(result.stdout)
    except ValueError:
        report = {}
    if (result.returncode or report.get("version") != expected_version or report.get("protocolVersion") != 1
            or report.get("managedRuntime") is not True or report.get("networkRequests") != 0
            or report.get("printerSubmissions") != 0):
        raise ManagerError("Bundled runtime startup/version check failed; current installation was retained")


class PublisherRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.hostname not in {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}:
            raise ManagerError("Package download redirected outside GitHub release storage")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_bytes(url, limit, expected_sha=None):
    # Never attach config.token, environment credentials, or a CLC Authorization header.
    request = urllib.request.Request(url, headers={"User-Agent": "CLC-Print-Station-Manager", "Accept": "application/vnd.github+json" if url.startswith("https://api.github.com/") else "application/octet-stream"})
    with urllib.request.build_opener(PublisherRedirect()).open(request, timeout=30) as response:
        if int(response.headers.get("Content-Length", "0")) > limit:
            raise ManagerError("Package response exceeds its size limit")
        data = response.read(limit + 1)
    if len(data) > limit or expected_sha and hashlib.sha256(data).hexdigest() != expected_sha:
        raise ManagerError("Package response size or SHA-256 verification failed")
    return data


def asset(release, name):
    found = [item for item in release.get("assets", []) if item.get("name") == name]
    if len(found) != 1:
        raise ManagerError("This release does not provide the required station package")
    item = found[0]
    url = item.get("browser_download_url", "")
    prefix = "https://github.com/" + PUBLISHER + "/releases/download/" + release["tag_name"] + "/"
    checksum = item.get("digest", "")
    if not url.startswith(prefix) or "/" in url[len(prefix):] or not checksum.startswith("sha256:") or not SHA.fullmatch(checksum[7:]):
        raise ManagerError("Release asset URL or GitHub SHA-256 digest is unavailable")
    return item


def release_package(target_version=None):
    if target_version:
        release = json.loads(fetch_bytes(RELEASE_API + "tags/v" + version(target_version), 2 * 1024**2))
    else:
        releases = json.loads(fetch_bytes(RELEASE_API.rstrip("/") + "?per_page=20", 2 * 1024**2))
        if not isinstance(releases, list):
            raise ManagerError("Invalid GitHub releases response")
        eligible = [item for item in releases if isinstance(item, dict) and not item.get("draft") and not item.get("prerelease")
                    and str(item.get("tag_name", "")).startswith("v")
                    and VERSION.fullmatch(str(item.get("tag_name", "")).removeprefix("v"))
                    and any(asset.get("name") == MANIFEST_ASSET for asset in item.get("assets", []))]
        if not eligible:
            return None
        release = max(eligible, key=lambda item: tuple(map(int, item["tag_name"].removeprefix("v").split("."))))
    if release.get("draft") or release.get("prerelease"):
        raise ManagerError("Only published stable station releases can be installed")
    value = version(str(release.get("tag_name", "")).removeprefix("v"))
    if target_version and value != target_version:
        raise ManagerError("Release version changed after review")
    manifest_asset = asset(release, MANIFEST_ASSET)
    manifest = json.loads(fetch_bytes(manifest_asset["browser_download_url"], 64 * 1024, manifest_asset["digest"][7:]))
    if manifest.get("formatVersion") != 1 or manifest.get("publisher") != PUBLISHER or manifest.get("version") != value:
        raise ManagerError("Invalid release package manifest")
    arch = architecture()
    package = manifest.get("packages", {}).get(arch)
    expected_name = "clc-print-station-macos-" + arch + ".tar.gz"
    if not package or package.get("name") != expected_name or not SHA.fullmatch(package.get("sha256", "")) or type(package.get("size")) is not int or not 1 <= package["size"] <= MAX_ARCHIVE:
        raise ManagerError("No bounded package for this Mac architecture")
    remote = asset(release, expected_name)
    if remote.get("size") != package["size"] or remote["digest"] != "sha256:" + package["sha256"]:
        raise ManagerError("Release and package manifest checksums disagree")
    return {"version": value, "architecture": arch, "url": remote["browser_download_url"], "sha256": package["sha256"], "size": package["size"], "releaseUrl": "https://github.com/" + PUBLISHER + "/releases/tag/v" + value}


def managed_status(config):
    root = managed_root(config)
    current = selected(root) if root.exists() else None
    if not current or not (root / "installation.json").is_file():
        return {"supported": False, "managed": False, "status": "unsupported", "error": None,
                "reason": "Install the self-contained Mac station package to enable managed updates"}
    saved = json.loads((root / "update-status.json").read_text()) if (root / "update-status.json").is_file() else {}
    available = saved.get("availableVersion")
    if available and tuple(map(int, version(available).split("."))) <= tuple(map(int, current.split("."))):
        available = None
    status = "failed" if saved.get("status") == "failed" else "available" if available else "idle"
    return {"supported": True, "managed": True, "version": current, "currentVersion": current,
            "previousVersion": selected(root, "previous"), "architecture": architecture(),
            "publisher": PUBLISHER, "root": str(root), "restartNeeded": False,
            "availableVersion": available, "status": status, "error": saved.get("error") if status == "failed" else None,
            "checkedAt": saved.get("checkedAt")}


def save_update_status(config, **data):
    root = managed_root(config)
    previous = json.loads((root / "update-status.json").read_text()) if (root / "update-status.json").is_file() else {}
    atomic_json(root / "update-status.json", {**previous, **data})


def check_update(config):
    current = managed_status(config)
    if not current["supported"]:
        return current
    try:
        candidate = release_package()
    except (OSError, ValueError, RuntimeError) as error:
        save_update_status(config, status="failed", error=str(error)[:500], checkedAt=time.time())
        raise
    newer = candidate is not None and tuple(map(int, candidate["version"].split("."))) > tuple(map(int, current["version"].split(".")))
    save_update_status(config, status="available" if newer else "idle", error=None,
                       availableVersion=candidate["version"] if newer else None, checkedAt=time.time())
    return {**managed_status(config), "updateAvailable": newer,
            "releaseUrl": candidate["releaseUrl"] if candidate else None, "downloadBytes": candidate["size"] if newer else 0,
            "message": "A newer published companion bundle is available" if newer else "No newer published companion bundle"}


def activate_bundle(config, directory, expected_version, expected_arch):
    assert_workflow_compatible(config, expected_version)
    root = managed_root(config)
    metadata = verify_bundle(directory, expected_version, expected_arch)
    bundle_health(directory, expected_version)
    assert_idle(config)
    destination = root / "versions" / metadata["version"]
    if destination.exists():
        verify_bundle(destination, expected_version, expected_arch)
        if json.loads((destination / "bundle-manifest.json").read_text()) != metadata:
            raise ManagerError("An installed version cannot be replaced with different bytes")
    else:
        os.replace(directory, destination)
        sync_dir(destination.parent)
    current = selected(root)
    if current == metadata["version"]:
        return managed_status(config)
    if current:
        select(root, current, "previous")
    select(root, metadata["version"])
    return {**managed_status(config), "restartNeeded": True}


def _apply_update(config, action="update", target_version=None):
    status = managed_status(config)
    if not status["supported"]:
        raise ManagerError(status["reason"])
    root = managed_root(config)
    with manager_lock(root):
        assert_idle(config)
        if action == "rollback":
            previous = selected(root, "previous")
            if not previous or target_version and version(target_version) != previous:
                raise ManagerError("No matching previous version is available for rollback")
            assert_workflow_compatible(config, previous)
            verify_bundle(root / "versions" / previous, previous, architecture())
            bundle_health(root / "versions" / previous, previous)
            assert_idle(config)
            select(root, status["version"], "previous")
            select(root, previous)
            return {**managed_status(config), "restartNeeded": True, "action": "rollback"}
        if action != "update" or target_version is None:
            raise ManagerError("Review an available release and provide its target_version")
        candidate = release_package(version(target_version))
        if tuple(map(int, candidate["version"].split("."))) <= tuple(map(int, status["version"].split("."))):
            raise ManagerError("Updates must be newer; use rollback for a retained previous version")
        with tempfile.TemporaryDirectory(prefix=".update-", dir=root) as temporary:
            temporary = Path(temporary)
            archive = temporary / "bundle.tar.gz"
            archive.write_bytes(fetch_bytes(candidate["url"], candidate["size"], candidate["sha256"]))
            if archive.stat().st_size != candidate["size"]:
                raise ManagerError("Downloaded package size changed")
            staging = temporary / "unpacked"
            staging.mkdir()
            safe_extract(archive, staging)
            bundle = staging / "CLC-Print-Station"
            return {**activate_bundle(config, bundle, candidate["version"], candidate["architecture"]), "action": "update"}


def apply_update(config, action="update", target_version=None):
    try:
        result = _apply_update(config, action, target_version)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        if managed_status(config).get("supported"):
            save_update_status(config, status="failed", error=str(error)[:500])
        raise
    save_update_status(config, status="idle", availableVersion=None, error=None)
    return {**result, "status": "idle", "availableVersion": None, "error": None}


def write_launcher(root):
    # Stable shell selects a complete version once; Python comes from that version.
    launcher = root / "launch-station.command"
    content = '''#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=$(/usr/bin/readlink "$ROOT/current")
case "$TARGET" in versions/[0-9]*.[0-9]*.[0-9]*) ;; *) echo "Invalid CLC version selection" >&2; exit 1;; esac
case "$TARGET" in *..*|*/*/*) exit 1;; esac
exec "$ROOT/$TARGET/python/bin/python3" -B -E -s "$ROOT/$TARGET/clc_station_manager.py" launch --root "$ROOT"
'''
    if launcher.exists() and launcher.read_text() != content:
        raise ManagerError("Stable launcher differs from this installer; preserve it and review manually")
    if not launcher.exists():
        launcher.write_text(content)
        os.chmod(launcher, 0o700)
    return launcher


def bootstrap_config(path):
    from clc_print_station import private_directory
    path = Path(path).expanduser().absolute()
    private_directory(path.parent)
    token_path = path.parent / "station-token"
    print("Set up CLC Print Station. Printing starts paused and requires verified local settings.")
    url = input("CLC server origin (https://...): ").strip()
    queue = input("Installed Epson queue [EPSON_ET_8550_Series]: ").strip() or "EPSON_ET_8550_Series"
    token = getpass.getpass("CLC station token (hidden): ").strip()
    if len(token) < 32 or any(c.isspace() for c in token):
        raise ManagerError("Station token must be at least 32 characters with no whitespace")
    data = json.loads((Path(__file__).parent / "config.example.json").read_text())
    data.update(server_url=url, queue=queue, station_token_file=str(token_path), recipe_verified=False, duplex_verified=False)
    with token_path.open("x") as stream:
        os.chmod(token_path, 0o600)
        stream.write(token + "\n")
    atomic_json(path, data)


def install_bundle(bundle, config_path=DEFAULT_CONFIG, load_agent=True, launch_agents=None):
    from clc_print_station import Ledger, load_config
    bundle = Path(bundle).resolve()
    metadata = verify_bundle(bundle, expected_arch=architecture())
    bundle_health(bundle, metadata["version"])
    config_path = Path(config_path).expanduser().absolute()
    if not config_path.exists():
        bootstrap_config(config_path)
    raw = read_config(config_path)
    config = load_config(config_path)
    state = private_dir(config["state_dir"])
    root = private_dir(managed_root(config))
    private_dir(root / "versions")
    folder = Path(launch_agents).expanduser() if launch_agents else Path.home() / "Library/LaunchAgents"
    plist = folder / (LABEL + ".plist")
    expected_launcher = str(root / "launch-station.command")
    if plist.exists():
        current_plist = plistlib.loads(plist.read_bytes())
        if current_plist.get("Label") != LABEL or current_plist.get("ProgramArguments") != [expected_launcher]:
            raise ManagerError("An existing LaunchAgent uses a different installation; unload it before migration")
    ledger = Ledger(state)
    try:
        with ledger.worker_lock(), manager_lock(root):
            # Existing active state must never be hidden by a fresh installation.
            if ledger.current():
                raise ManagerError("Reconcile existing print jobs before installing the managed station")
            assert_workflow_compatible(config, metadata["version"])
            ledger.write("INSERT OR REPLACE INTO settings(key,value) VALUES('paused','1')")
            assert_idle(config)
            destination = root / "versions" / metadata["version"]
            if not destination.exists():
                with tempfile.TemporaryDirectory(prefix=".install-", dir=root) as temporary:
                    staged = Path(temporary) / "bundle"
                    shutil.copytree(bundle, staged, symlinks=True)
                    verify_bundle(staged, metadata["version"], architecture())
                    os.replace(staged, destination)
                    sync_dir(destination.parent)
            else:
                installed = verify_bundle(destination, metadata["version"], architecture())
                if installed != metadata:
                    raise ManagerError("An installed version cannot be replaced with different bytes")
            previous = selected(root)
            if previous and previous != metadata["version"]:
                select(root, previous, "previous")
            select(root, metadata["version"])
            raw["managed_root"] = str(root)
            atomic_json(config_path, raw)
            atomic_json(root / "installation.json", {"formatVersion": 1, "configPath": str(config_path), "installedAt": time.time(), "publisher": PUBLISHER})
            launcher = write_launcher(root)
            folder.mkdir(parents=True, exist_ok=True)
            data = {"Label": LABEL, "ProgramArguments": [str(launcher)], "RunAtLoad": True,
                    "KeepAlive": True, "ThrottleInterval": 15, "ProcessType": "Background",
                    "StandardOutPath": str(state / "worker.log"), "StandardErrorPath": str(state / "worker-error.log")}
            with plist.open("wb") as stream:
                plistlib.dump(data, stream)
            os.chmod(plist, 0o600)
    finally:
        ledger.db.close()
    if load_agent:
        domain = "gui/" + str(os.getuid())
        subprocess.run(["/bin/launchctl", "bootout", domain + "/" + LABEL], capture_output=True)
        result = subprocess.run(["/bin/launchctl", "bootstrap", domain, str(plist)], capture_output=True, text=True)
        if result.returncode:
            raise ManagerError("Installed paused, but LaunchAgent loading failed: " + result.stderr.strip())
    return {**managed_status({**raw, "managed_root": str(root)}), "paused": True, "configPath": str(config_path), "launchAgent": str(plist), "autostartLoaded": load_agent}


def rotate_logs(config):
    for name in ("worker.log", "worker-error.log"):
        path = Path(config["state_dir"]).expanduser() / name
        if path.exists() and path.stat().st_size > 5 * 1024**2:
            for index in (3, 2, 1):
                older = path.with_name(name + "." + str(index))
                if index == 3:
                    older.unlink(missing_ok=True)
                prior = path if index == 1 else path.with_name(name + "." + str(index - 1))
                if prior.exists():
                    os.replace(prior, older)


def launch(root):
    root = Path(root).expanduser().resolve()
    installation = json.loads((root / "installation.json").read_text())
    value = selected(root)
    if not value:
        raise ManagerError("No installed station version is selected")
    directory = root / "versions" / value
    config = read_config(installation["configPath"])
    rotate_logs(config)
    # launchd opened its descriptors before rotation. Reopen the current paths so
    # this run does not keep appending to a renamed backup file.
    for descriptor, name in [(1, "worker.log"), (2, "worker-error.log")]:
        path = Path(config["state_dir"]).expanduser() / name
        with path.open("a") as stream:
            os.dup2(stream.fileno(), descriptor)
    # No supervisor child remains: launchd signals reach the actual worker. Exit75
    # restarts this stable selector and therefore the newly selected version.
    executable = str(directory / "python/bin/python3")
    os.execv(executable, [executable, "-B", "-E", "-s", str(directory / "clc_print_station.py"),
                          "--config", installation["configPath"], "run"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    install = commands.add_parser("install")
    install.add_argument("--bundle", default=str(Path(__file__).resolve().parent))
    install.add_argument("--config", default=DEFAULT_CONFIG)
    install.add_argument("--no-launch", action="store_true", help="Install paused without loading launchd")
    install.add_argument("--launch-agent-dir", help="Alternate LaunchAgent output directory; requires --no-launch")
    for name in ["status", "check-update", "update", "rollback"]:
        command = commands.add_parser(name)
        command.add_argument("--config", default=DEFAULT_CONFIG)
        if name in {"update", "rollback"}:
            command.add_argument("--version", required=name == "update")
    launcher = commands.add_parser("launch")
    launcher.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    if args.action == "launch":
        return launch(args.root)
    if args.action == "install":
        if args.launch_agent_dir and not args.no_launch:
            raise ManagerError("An alternate LaunchAgent directory requires --no-launch")
        result = install_bundle(args.bundle, args.config, not args.no_launch, args.launch_agent_dir)
    else:
        config = read_config(args.config)
        if args.action == "status":
            result = managed_status(config)
        elif args.action == "check-update":
            result = check_update(config)
        else:
            from clc_print_station import Ledger
            ledger = Ledger(config["state_dir"])
            try:
                with ledger.worker_lock():
                    result = apply_update(config, args.action, args.version)
            finally:
                ledger.db.close()
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ManagerError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("CLC station manager: " + str(error), file=sys.stderr)
        sys.exit(1)
