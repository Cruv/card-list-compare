#!/usr/bin/env python3
"""Build a relocatable Mac station package using pinned, verified Astral Python.

This only builds local artifacts. Publishing is a separate explicit release action.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request

from clc_station_manager import (PUBLISHER, ManagerError, MAX_ARCHIVE, architecture,
                                 bundle_files, bundle_health, digest, safe_extract, version)

HERE = Path(__file__).resolve().parent
PYTHON_RELEASE = "20260901"
PYTHON_VERSION = "3.13.15"
RUNTIMES = {
    "arm64": {"target": "aarch64-apple-darwin", "size": 25147663,
              "sha256": "d3904bd6a072246e07aa0bdadee9a14e80521e42a943c0848059feb16a2816dc"},
    "x86_64": {"target": "x86_64-apple-darwin", "size": 24912286,
               "sha256": "f712a9143c8a5d248438ec7921a0b48d548bca4f1337d33c690d28c2d0504137"},
}


def runtime_archive(arch, cache):
    info = RUNTIMES[arch]
    filename = f"cpython-{PYTHON_VERSION}+{PYTHON_RELEASE}-{info['target']}-install_only_stripped.tar.gz"
    url = f"https://github.com/astral-sh/python-build-standalone/releases/download/{PYTHON_RELEASE}/{filename.replace('+', '%2B')}"
    cache.mkdir(parents=True, exist_ok=True)
    output = cache / filename
    if output.exists() and output.stat().st_size == info["size"] and digest(output) == info["sha256"]:
        return output, {**info, "url": url, "pythonVersion": PYTHON_VERSION, "release": PYTHON_RELEASE}
    temporary = output.with_suffix(".download")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "CLC-Print-Station-Builder"})
        with urllib.request.urlopen(request, timeout=30) as source, temporary.open("wb") as target:
            size = 0
            while True:
                block = source.read(256 * 1024)
                if not block:
                    break
                size += len(block)
                if size > info["size"]:
                    raise ManagerError("Pinned Python archive exceeds its expected size")
                target.write(block)
        if size != info["size"] or digest(temporary) != info["sha256"]:
            raise ManagerError("Pinned Python archive failed SHA-256 verification")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return output, {**info, "url": url, "pythonVersion": PYTHON_VERSION, "release": PYTHON_RELEASE}


def build(arch, output, cache, requested_version=None, smoke=True):
    output = Path(output).absolute()
    output.mkdir(parents=True, exist_ok=True)
    app_version = version(json.loads((HERE.parents[1] / "package.json").read_text())["version"])
    source = (HERE / "clc_print_station.py").read_text()
    match = re.search(r'^COMPANION_VERSION\s*=\s*["\']([^"\']+)', source, re.MULTILINE)
    if not match or match[1] != app_version or requested_version and requested_version != app_version:
        raise ManagerError("Package, companion and requested versions must match before building")
    archive, runtime = runtime_archive(arch, Path(cache))
    destination = output / ("clc-print-station-macos-" + arch + ".tar.gz")
    if destination.exists():
        raise ManagerError("Package output already exists; use a fresh output directory")
    with tempfile.TemporaryDirectory(prefix=".bundle-", dir=output) as temporary:
        root = Path(temporary)
        bundle = root / "CLC-Print-Station"
        bundle.mkdir()
        safe_extract(archive, bundle)
        names = ["clc_print_station.py", "clc_station_manager.py", "get-jobs.test", "config.example.json",
                 "epson-et8550-13.45-driver-options.example.json", "Install CLC Print Station.command"]
        # The station control module is packaged when present in this release.
        names += [path.name for path in HERE.glob("clc_station_control*.py")]
        for name in names:
            shutil.copy2(HERE / name, bundle / name)
        (bundle / "Install CLC Print Station.command").chmod(0o755)
        for name in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
            if (HERE.parents[1] / name).is_file():
                shutil.copy2(HERE.parents[1] / name, bundle / ("CLC-" + name))
        (bundle / "INSTALL.txt").write_text(
            "CLC Print Station - self-contained Mac package\n\n"
            "Open Install CLC Print Station.command to install once. The installer asks for\n"
            "your CLC origin and a hidden station token if no existing configuration is found.\n"
            "Printing starts paused. Verify Epson settings and proofs before enabling it.\n"
            "An existing configuration can be selected by running the command with --config PATH.\n"
            "Updates are reviewed in CLC, then applied only between jobs while paused.\n"
            "Configuration, token and print ledger stay outside the versioned application.\n"
            "This draft is not Developer-ID signed or notarized. macOS may require explicit\n"
            "approval to open downloaded software; the installer does not remove quarantine.\n\n"
            "Publisher: https://github.com/Cruv/card-list-compare\n"
            "Runtime: https://github.com/astral-sh/python-build-standalone\n"
            "Python's included license notices remain inside the python directory.\n")
        (bundle / "RUNTIME-SOURCE.json").write_text(json.dumps(runtime, indent=2) + "\n")
        # Verification never imports third-party packages or accesses a queue.
        if smoke:
            if arch != architecture():
                raise ManagerError("Native package smoke requires a matching Mac architecture")
            bundle_health(bundle, app_version)
        metadata = {"formatVersion": 1, "publisher": PUBLISHER, "version": app_version,
                    "architecture": arch, "runtime": runtime, "files": bundle_files(bundle)}
        (bundle / "bundle-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
        with tarfile.open(destination, "w:gz", dereference=False) as tar:
            tar.add(bundle, arcname="CLC-Print-Station", recursive=True)
    if destination.stat().st_size > MAX_ARCHIVE:
        destination.unlink()
        raise ManagerError("Package exceeds the manager download limit")
    package = {"name": destination.name, "size": destination.stat().st_size, "sha256": digest(destination)}
    part = {"formatVersion": 1, "publisher": PUBLISHER, "version": app_version, "packages": {arch: package}}
    (output / ("package-" + arch + ".json")).write_text(json.dumps(part, indent=2) + "\n")
    print(json.dumps(part, indent=2))
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=RUNTIMES, default=architecture())
    parser.add_argument("--version")
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache", default=str(Path.home() / "Library/Caches/CLC Print Station/python-builds"))
    parser.add_argument("--skip-native-smoke", action="store_true", help="For cross-packaging only; CI must smoke each native architecture")
    args = parser.parse_args()
    build(args.arch, args.output, args.cache, args.version, not args.skip_native_smoke)


if __name__ == "__main__":
    main()
