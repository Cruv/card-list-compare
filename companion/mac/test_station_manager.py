import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import clc_station_manager as manager
from clc_print_station import Ledger
from clc_station_control import StationControl


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="clc-manager-test-")
        self.root = Path(self.temporary.name)
        self.config = {"state_dir": str(self.root / "state"), "managed_root": str(self.root / "app"),
                       "server_url": "https://example.test", "station_token_file": str(self.root / "token"),
                       "queue": "Epson", "approved_recipe_ids": ["household-letter-v6"],
                       "recipe_verified": False, "duplex_verified": False, "driver_options": {}}
        self.ledger = Ledger(self.config["state_dir"])
        self.ledger.write("INSERT INTO settings(key,value) VALUES('paused','1')")
        (self.root / "token").write_text("s" * 48)
        (self.root / "token").chmod(0o600)
        self.config_path = self.root / "config.json"
        manager.atomic_json(self.config_path, self.config)

    def tearDown(self):
        self.ledger.db.close()
        self.temporary.cleanup()

    def bundle(self, version="1.0.0", where=None):
        root = where or self.root / ("bundle-" + version)
        (root / "python/bin").mkdir(parents=True)
        (root / "python/bin/python3").write_text("#!/bin/sh\nprintf '%s\\n' '{\"version\":\"" + version + "\",\"protocolVersion\":1,\"managedRuntime\":true,\"networkRequests\":0,\"printerSubmissions\":0}'\n")
        (root / "python/bin/python3").chmod(0o755)
        (root / "clc_print_station.py").write_text("# station fixture " + version)
        (root / "clc_station_manager.py").write_text("# manager fixture " + version)
        (root / "clc_station_control.py").write_text("# control fixture " + version)
        (root / "get-jobs.test").write_text("# fixed CUPS query")
        (root / "bundle-manifest.json").write_text(json.dumps({"formatVersion": 1, "publisher": manager.PUBLISHER,
             "version": version, "architecture": manager.architecture(), "files": manager.bundle_files(root)}))
        return root

    def test_new_release_requires_printer_health_files_but_older_rollback_does_not(self):
        old = self.bundle("2.52.1")
        (old / "clc_station_alerts.py").write_text("# alert fixture")
        new = self.bundle("2.53.0")
        (new / "clc_station_alerts.py").write_text("# alert fixture")
        def resign(root):
            data = json.loads((root / "bundle-manifest.json").read_text())
            data["files"] = manager.bundle_files(root)
            (root / "bundle-manifest.json").write_text(json.dumps(data))
        resign(old)
        manager.verify_bundle(old)
        resign(new)
        with self.assertRaisesRegex(manager.ManagerError, "printer status"):
            manager.verify_bundle(new)

        for name in ("clc_printer_health.py", "get-printer.test"):
            (new / name).write_text("# local health fixture")
        resign(new)
        manager.verify_bundle(new)
        (new / "get-printer.test").unlink()
        resign(new)
        with self.assertRaisesRegex(manager.ManagerError, "printer status"):
            manager.verify_bundle(new)

    def test_safe_saved_backs_allow_idle_upgrade_but_not_old_worker_rollback(self):
        self.ledger.write("INSERT INTO jobs VALUES('saved',?,'recipe','backs_pending',NULL,0)",
                          (json.dumps({'workflow': 'deferred-backs-v1'}),))
        self.ledger.write("INSERT INTO passes(job_id,artifact_id,phase,state,title,cups_started) VALUES('saved','dfc','backs','pending','title',0)")
        manager.assert_idle(self.config)
        manager.assert_workflow_compatible(self.config, '2.55.0')
        with self.assertRaisesRegex(manager.ManagerError, 'Finish or cancel saved backs'):
            manager.assert_workflow_compatible(self.config, '2.54.0')
        self.ledger.write("UPDATE passes SET state='submitted',cups_started=1")
        with self.assertRaisesRegex(manager.ManagerError, 'active print job'):
            manager.assert_idle(self.config)

    def install(self):
        return manager.install_bundle(self.bundle(), self.config_path, load_agent=False, launch_agents=self.root / "agents")

    def archive(self, members):
        target = self.root / "test.tar.gz"
        with tarfile.open(target, "w:gz") as stream:
            for name, content, kind in members:
                info = tarfile.TarInfo(name)
                if kind == "file":
                    info.size = len(content)
                    stream.addfile(info, io.BytesIO(content))
                elif kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = content
                    stream.addfile(info)
                elif kind == "fifo":
                    info.type = tarfile.FIFOTYPE
                    stream.addfile(info)
        return target

    def test_installs_self_contained_paused_without_loading_or_printing(self):
        control = StationControl(SimpleNamespace(config=self.config, ledger=self.ledger), "1.0.0", manager)
        self.ledger.write("INSERT INTO control_receipts VALUES('history','{}','applied','Preserved receipt',1)")
        history = tuple(self.ledger.db.execute("SELECT * FROM control_receipts WHERE id='history'").fetchone())
        before = (self.root / "token").read_bytes()
        with mock.patch.object(manager.subprocess, "run", wraps=manager.subprocess.run) as run:
            result = self.install()
        self.assertTrue(result["supported"])
        self.assertTrue(result["paused"])
        self.assertFalse(result["autostartLoaded"])
        self.assertTrue(self.ledger.paused())
        self.assertEqual((self.root / "token").read_bytes(), before)
        self.assertEqual(tuple(self.ledger.db.execute("SELECT * FROM control_receipts WHERE id='history'").fetchone()), history)
        # Use the native constructor's schema, including acknowledged's default:
        # a receipt inserted by the actual command handler must be reportable.
        control.apply({"id": "new-control", "type": "pause", "expiresAt": "2099-01-01T00:00:00Z"})
        self.assertEqual(self.ledger.db.execute("SELECT acknowledged FROM control_receipts WHERE id='new-control'").fetchone()[0], 0)
        self.assertEqual(control.snapshot()["receipts"][0]["commandId"], "new-control")
        self.assertEqual([call.args[0][-1] for call in run.call_args_list], ["self-check"])
        plist = plistlib.loads((self.root / "agents/local.clc.print-station.plist").read_bytes())
        self.assertTrue(plist["KeepAlive"])
        launcher = Path(plist["ProgramArguments"][0]).read_text()
        self.assertIn('/python/bin/python3" -B -E -s', launcher)
        self.assertNotIn("/usr/bin/python", launcher)

    def test_active_uncertain_or_manual_refeed_blocks_update_independently(self):
        self.install()
        for state in ["active", "uncertain", "awaiting_refeed"]:
            with self.subTest(state=state):
                self.ledger.write("INSERT OR REPLACE INTO jobs VALUES('job','{}','hash',?,NULL,0)", (state,))
                with mock.patch.object(manager, "release_package") as network:
                    with self.assertRaisesRegex(manager.ManagerError, "Finish or reconcile"):
                        manager.apply_update(self.config, target_version="2.0.0")
                    network.assert_not_called()
                self.assertEqual(manager.selected(self.root / "app"), "1.0.0")

    def test_orphan_submission_intent_blocks_without_a_job_record(self):
        self.ledger.write("INSERT INTO passes(job_id,artifact_id,phase,state,title) VALUES('job','fronts','fronts','intent','title')")
        with self.assertRaisesRegex(manager.ManagerError, "Finish or reconcile"):
            manager.assert_idle(self.config)

    def test_explicitly_released_terminal_job_can_update_without_erasing_pass_history(self):
        self.ledger.write("INSERT INTO jobs VALUES('job','{}','hash','failed','Operator cleared paper',0)")
        self.ledger.write("INSERT INTO passes(job_id,artifact_id,phase,state,title) VALUES('job','fronts','fronts','uncertain','title')")
        manager.assert_idle(self.config)
        self.assertEqual(self.ledger.db.execute("SELECT state FROM passes").fetchone()[0], "uncertain")

    def test_pause_required_and_unreadable_schema_fails_closed(self):
        self.ledger.write("UPDATE settings SET value='0' WHERE key='paused'")
        with self.assertRaisesRegex(manager.ManagerError, "Pause"):
            manager.assert_idle(self.config)
        self.ledger.write("DROP TABLE passes")
        with self.assertRaisesRegex(manager.ManagerError, "checked safely"):
            manager.assert_idle(self.config)

    def test_upgrade_and_rollback_preserve_private_state_and_pause(self):
        self.install()
        self.ledger.write("INSERT INTO jobs VALUES('history','{}','hash','completed','kept',1)")
        next_bundle = self.bundle("2.0.0")
        result = manager.activate_bundle(self.config, next_bundle, "2.0.0", manager.architecture())
        self.assertTrue(result["restartNeeded"])
        self.assertEqual(manager.selected(self.root / "app"), "2.0.0")
        self.assertEqual(manager.selected(self.root / "app", "previous"), "1.0.0")
        before_config = self.config_path.read_bytes()
        result = manager.apply_update(self.config, "rollback", "1.0.0")
        self.assertTrue(result["restartNeeded"])
        self.assertEqual(result["currentVersion"], "1.0.0")
        self.assertEqual(self.config_path.read_bytes(), before_config)
        self.assertEqual(self.ledger.db.execute("SELECT detail FROM jobs WHERE id='history'").fetchone()[0], "kept")
        self.assertTrue(self.ledger.paused())

    def test_health_failure_does_not_select_candidate(self):
        self.install()
        candidate = self.bundle("2.0.0")
        with mock.patch.object(manager, "bundle_health", side_effect=manager.ManagerError("failed")):
            with self.assertRaises(manager.ManagerError):
                manager.activate_bundle(self.config, candidate, "2.0.0", manager.architecture())
        self.assertEqual(manager.selected(self.root / "app"), "1.0.0")

    def test_selection_failure_keeps_complete_old_pointer(self):
        self.install()
        candidate = self.bundle("2.0.0")
        original = os.replace
        def fail_current(src, dst):
            if Path(dst) == self.root / "app/current":
                raise OSError("disk failure")
            return original(src, dst)
        with mock.patch.object(manager.os, "replace", side_effect=fail_current):
            with self.assertRaisesRegex(OSError, "disk failure"):
                manager.activate_bundle(self.config, candidate, "2.0.0", manager.architecture())
        self.assertEqual(manager.selected(self.root / "app"), "1.0.0")
        self.assertTrue((self.root / "app/versions/2.0.0/clc_print_station.py").is_file())

    def test_modified_bundle_and_version_mismatch_are_rejected(self):
        bundle = self.bundle()
        with self.assertRaisesRegex(manager.ManagerError, "version or architecture"):
            manager.verify_bundle(bundle, "9.0.0", manager.architecture())
        (bundle / "clc_print_station.py").write_text("changed")
        with self.assertRaisesRegex(manager.ManagerError, "checksums"):
            manager.verify_bundle(bundle)

    def test_update_requires_reviewed_target_version(self):
        self.install()
        with self.assertRaisesRegex(manager.ManagerError, "target_version"):
            manager.apply_update(self.config)

    def test_status_is_read_only_and_does_not_access_network(self):
        with mock.patch.object(manager, "fetch_bytes") as fetch:
            self.assertFalse(manager.managed_status(self.config)["supported"])
            self.assertFalse((self.root / "app").exists())
            fetch.assert_not_called()

    def test_update_availability_survives_restart_and_only_reports_newer_versions(self):
        self.install()
        candidate = {"version": "2.0.0", "releaseUrl": "https://github.com/Cruv/card-list-compare/releases/tag/v2.0.0", "size": 123}
        with mock.patch.object(manager, "release_package", return_value=candidate):
            result = manager.check_update(self.config)
        self.assertEqual(result["status"], "available")
        self.assertIsNone(result["error"])
        with mock.patch.object(manager, "fetch_bytes") as fetch:
            persisted = manager.managed_status(json.loads(self.config_path.read_text()))
            self.assertEqual(persisted["availableVersion"], "2.0.0")
            self.assertIsNotNone(persisted["checkedAt"])
            fetch.assert_not_called()
        for candidate in [None, {"version": "1.0.0", "releaseUrl": "same", "size": 1}]:
            with mock.patch.object(manager, "release_package", return_value=candidate):
                result = manager.check_update(self.config)
            self.assertEqual(result["status"], "idle")
            self.assertIsNone(result["availableVersion"])
            self.assertIsNone(result["error"])

    def test_no_published_companion_package_is_normal_idle(self):
        releases = [{"tag_name": "v2.0.0", "assets": []},
                    {"tag_name": "v3.0.0", "draft": True, "assets": [{"name": manager.MANIFEST_ASSET}]}]
        with mock.patch.object(manager, "fetch_bytes", return_value=json.dumps(releases).encode()):
            self.assertIsNone(manager.release_package())

    def test_installer_rejects_existing_version_with_different_verified_bytes(self):
        self.install()
        candidate = self.bundle(where=self.root / "second-candidate")
        (candidate / "clc_station_manager.py").write_text("# changed but self-consistent bundle")
        metadata = json.loads((candidate / "bundle-manifest.json").read_text())
        metadata["files"] = manager.bundle_files(candidate)
        (candidate / "bundle-manifest.json").write_text(json.dumps(metadata))
        before = self.config_path.read_bytes()
        with self.assertRaisesRegex(manager.ManagerError, "different bytes"):
            manager.install_bundle(candidate, self.config_path, load_agent=False, launch_agents=self.root / "agents")
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertEqual(manager.selected(self.root / "app"), "1.0.0")

    def test_launch_agent_conflict_is_rejected_before_config_or_selection_changes(self):
        self.install()
        candidate = self.bundle("2.0.0")
        plist = self.root / "agents/local.clc.print-station.plist"
        plist.write_bytes(plistlib.dumps({"Label": manager.LABEL, "ProgramArguments": ["/old/launcher"]}))
        before = self.config_path.read_bytes()
        with self.assertRaisesRegex(manager.ManagerError, "different installation"):
            manager.install_bundle(candidate, self.config_path, load_agent=False, launch_agents=self.root / "agents")
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertEqual(manager.selected(self.root / "app"), "1.0.0")
        self.assertFalse((self.root / "app/versions/2.0.0").exists())

    def test_installer_cannot_hide_active_job_or_change_pause_state(self):
        self.ledger.write("UPDATE settings SET value='0' WHERE key='paused'")
        self.ledger.write("INSERT INTO jobs VALUES('job','{}','hash','uncertain','kept',1)")
        before = self.config_path.read_bytes()
        with self.assertRaisesRegex(manager.ManagerError, "Reconcile existing"):
            self.install()
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertFalse(self.ledger.paused())
        self.assertIsNone(manager.selected(self.root / "app"))

    def test_extract_rejects_traversal_external_links_and_special_files(self):
        for member in [("../escape", b"bad", "file"), ("/absolute", b"bad", "file"),
                       ("python/link", "../../outside", "symlink"), ("fifo", b"", "fifo")]:
            with self.subTest(member=member[0]):
                staging = self.root / "unpack"
                staging.mkdir(exist_ok=True)
                with self.assertRaises(manager.ManagerError):
                    manager.safe_extract(self.archive([member]), staging)
                shutil.rmtree(staging)

    def test_extract_rejects_write_through_link_duplicate_and_bomb(self):
        cases = [[("safe/file", b"ok", "file"), ("link", "safe", "symlink"), ("link/escape", b"bad", "file")],
                 [("same", b"a", "file"), ("same", b"b", "file")]]
        for members in cases:
            staging = self.root / "unpack"; staging.mkdir()
            with self.assertRaises(manager.ManagerError):
                manager.safe_extract(self.archive(members), staging)
            shutil.rmtree(staging)
        staging.mkdir()
        with mock.patch.object(manager, "MAX_EXPANDED", 4):
            with self.assertRaisesRegex(manager.ManagerError, "limits"):
                manager.safe_extract(self.archive([("large", b"12345", "file")]), staging)

    def test_extract_accepts_contained_runtime_symlink(self):
        staging = self.root / "unpack"; staging.mkdir()
        manager.safe_extract(self.archive([("python/bin/python3.13", b"runtime", "file"),
                                           ("python/bin/python3", "python3.13", "symlink")]), staging)
        self.assertEqual((staging / "python/bin/python3").read_bytes(), b"runtime")

    def test_fixed_release_metadata_pins_package_hash_and_architecture(self):
        arch = manager.architecture(); name = "clc-print-station-macos-" + arch + ".tar.gz"
        package_hash = "a" * 64
        manifest = {"formatVersion": 1, "publisher": manager.PUBLISHER, "version": "2.0.0",
                    "packages": {arch: {"name": name, "size": 10, "sha256": package_hash}}}
        manifest_bytes = json.dumps(manifest).encode()
        release = {"tag_name": "v2.0.0", "draft": False, "prerelease": False, "assets": []}
        for asset_name, size, sha in [(manager.MANIFEST_ASSET, len(manifest_bytes), hashlib.sha256(manifest_bytes).hexdigest()), (name, 10, package_hash)]:
            release["assets"].append({"name": asset_name, "size": size, "digest": "sha256:" + sha,
                                      "browser_download_url": "https://github.com/" + manager.PUBLISHER + "/releases/download/v2.0.0/" + asset_name})
        with mock.patch.object(manager, "fetch_bytes", side_effect=[json.dumps(release).encode(), manifest_bytes]) as fetch:
            result = manager.release_package("2.0.0")
        self.assertEqual(result["sha256"], package_hash)
        self.assertEqual(fetch.call_args_list[0].args[0], manager.RELEASE_API + "tags/v2.0.0")
        release["assets"][1]["browser_download_url"] = "https://evil.example/package"
        with mock.patch.object(manager, "fetch_bytes", side_effect=[json.dumps(release).encode(), manifest_bytes]):
            with self.assertRaisesRegex(manager.ManagerError, "URL"):
                manager.release_package("2.0.0")


if __name__ == "__main__":
    unittest.main()
