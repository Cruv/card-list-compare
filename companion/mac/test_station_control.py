"""Station management tests use only temporary ledgers and a fake printer."""
import copy
import datetime
import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import clc_print_station as native
from clc_station_control import StationControl
from test_print_station import FakeClient, FakeCups, config, job


def control(kind, identifier="control123", **fields):
    return {"id": identifier, "type": kind,
            "expiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat(),
            **({"paperReloaded": True} if kind == "resume" else {}), **fields}


class ManagedClient(FakeClient):
    def __init__(self, value):
        super().__init__(value)
        self.commands, self.statuses = [], []
        self.lose_reply = False

    def management_heartbeat(self, payload):
        self.statuses.append(copy.deepcopy(payload))
        if self.lose_reply:
            self.lose_reply = False
            raise native.StationError("Connection lost after receiving status")
        return {"commands": copy.deepcopy(self.commands),
                "acknowledgedCommandIds": [entry["commandId"] for entry in payload["receipts"]]}


class FakeManager:
    def __init__(self):
        self.calls = []
        self.current = "2.45.0"

    def managed_status(self, _config):
        return {"supported": True, "currentVersion": self.current, "previousVersion": "2.44.2",
                "availableVersion": "2.46.0", "status": "available", "error": None}

    def check_update(self, config):
        self.calls.append("check")
        return self.managed_status(config)

    def apply_update(self, config, action, target_version):
        self.calls.append((action, target_version))
        self.current = target_version
        return {**self.managed_status(config), "restartNeeded": True}


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = config(Path(self.temp.name))
        self.client, self.cups = ManagedClient(job()), FakeCups()
        self.station = native.Station(self.config, self.client, self.cups)
        self.manager = FakeManager()
        self.control = StationControl(self.station, "2.45.0", self.manager)

    def tearDown(self):
        self.station.ledger.db.close()
        self.temp.cleanup()

    def receipt(self, key="control123"):
        return self.station.ledger.db.execute("SELECT * FROM control_receipts WHERE id=?", (key,)).fetchone()

    def test_pause_receipt_survives_lost_ack_and_restart_without_replaying(self):
        self.client.commands = [control("pause")]
        self.control.sync()
        self.assertTrue(self.station.ledger.paused())
        self.client.lose_reply = True
        with self.assertRaises(native.StationError):
            self.control.sync()
        self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','0')")
        restarted = StationControl(self.station, "2.45.0", self.manager)
        restarted.sync()
        self.assertFalse(self.station.ledger.paused(), "A delayed duplicate must not undo a later local control")
        self.assertEqual(self.receipt()["acknowledged"], 1)
        self.assertEqual(self.cups.submissions, [])

    def test_reused_control_id_cannot_change_action(self):
        self.control.apply(control("pause"))
        with self.assertRaisesRegex(native.StationError, "changed"):
            self.control.apply(control("unpause"))
        self.assertTrue(self.station.ledger.paused())

    def test_expired_unknown_or_executable_controls_have_no_effect(self):
        for number, request in enumerate([control("unpause", expiresAt="2001-01-01T00:00:00Z"),
                                          control("run", path="/usr/bin/lp"), control("unpause", expiresAt="bad")]):
            request["id"] = "invalid" + str(number)
            self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','1')")
            self.control.apply(request)
            self.assertTrue(self.station.ledger.paused())
            self.assertEqual(self.receipt(request["id"])["state"], "rejected")
        self.assertEqual(self.cups.submissions, [])

    def test_unverified_station_reports_health_and_never_claims(self):
        self.config["recipe_verified"] = False
        self.client.commands = [control("unpause")]
        self.control.sync()
        self.assertIn("proof", self.station.poll_once())
        self.assertEqual(self.client.claims, 0)
        self.assertEqual(self.cups.submissions, [])
        self.assertFalse(self.client.statuses[-1]["recipeVerified"])

    def test_management_disconnection_blocks_new_claims_but_reconciles_submitted_job(self):
        self.assertIn("connection", self.station.poll_once(allow_submit=False))
        self.assertEqual(self.client.claims, 0)
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once(allow_submit=False)
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "completed")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_pause_received_after_download_prevents_submission(self):
        self.station.management = self.control
        self.client.commands = [control("pause")]
        self.assertEqual(self.station.poll_once(), "paused")
        self.assertEqual(self.cups.submissions, [])
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "pending")

    def test_refeed_is_bound_to_current_artifact_and_is_idempotent(self):
        self.client.job = job("dfc")
        self.station.adopt(self.client.job)
        self.station.ledger.write("UPDATE passes SET state='completed' WHERE phase='fronts'")
        self.station.ledger.set_job("job1", "awaiting_refeed")
        self.control.apply(control("resume", "unconfirmed", jobId="job1", artifactId="dfc", paperReloaded=False))
        self.assertEqual(self.receipt("unconfirmed")["state"], "rejected")
        self.control.apply(control("resume", "wrongpass", jobId="job1", artifactId="different"))
        self.assertEqual(self.receipt("wrongpass")["state"], "rejected")
        self.assertEqual(self.station.ledger.passes("job1")[1]["resume_requested"], 0)
        self.control.apply(control("resume", jobId="job1", artifactId="dfc"))
        self.assertEqual(self.receipt()["state"], "applied")
        self.assertEqual(self.station.ledger.passes("job1")[1]["resume_requested"], 1)
        self.station.ledger.set_job("job1", "completed")
        self.control.apply(control("resume", jobId="job1", artifactId="dfc"))
        self.assertEqual(self.receipt()["state"], "applied")
        self.assertEqual(self.cups.submissions, [])

    def test_every_unresolved_job_blocks_update_and_rollback(self):
        self.station.adopt(self.client.job)
        for number, state in enumerate(["active", "awaiting_refeed", "uncertain"]):
            self.station.ledger.set_job("job1", state)
            for kind in ["update", "rollback"]:
                key = kind + str(number)
                self.control.apply(control(kind, key, targetVersion="2.46.0"))
                self.assertEqual(self.receipt(key)["state"], "rejected")
        self.assertEqual(self.manager.calls, [])

    def test_version_selection_retains_pause_and_restart_receipt(self):
        self.control.apply(control("update", targetVersion="2.46.0"))
        self.assertEqual(self.manager.calls, [("update", "2.46.0")])
        self.assertTrue(self.control.restart_needed)
        self.assertTrue(self.station.ledger.paused())
        self.control.apply(control("update", targetVersion="2.46.0"))
        self.assertEqual(len(self.manager.calls), 1)
        self.assertEqual(self.receipt()["state"], "applied")

    def test_update_requires_explicit_version_and_check_does_not_restart(self):
        self.control.apply(control("update"))
        self.assertEqual(self.receipt()["state"], "rejected")
        self.control.apply(control("check_update", "check123"))
        self.assertEqual(self.manager.calls, ["check"])
        self.assertFalse(self.control.restart_needed)

    def test_interrupted_update_reconciles_selected_version_without_reexecution(self):
        payload = json.dumps({"type": "update", "jobId": None, "artifactId": None, "paperReloaded": None, "targetVersion": "2.46.0"}, sort_keys=True)
        self.station.ledger.write("INSERT INTO control_receipts(id,payload,state,message) VALUES(?,?,'processing','Applying')", ("interrupted", payload))
        self.manager.current = "2.46.0"
        StationControl(self.station, "2.46.0", self.manager)
        self.assertEqual(self.receipt("interrupted")["state"], "applied")
        self.assertEqual(self.manager.calls, [])

    def test_telemetry_is_bounded_and_credentials_are_redacted(self):
        for number in range(220):
            self.control.event("error", self.config["token"] + " Bearer secret-value " + str(number))
        payload = self.control.snapshot()
        self.assertLessEqual(len(payload["events"]), 20)
        self.assertEqual(self.station.ledger.db.execute("SELECT COUNT(*) FROM station_log").fetchone()[0], 200)
        self.assertNotIn(self.config["token"], json.dumps(payload))
        self.assertNotIn("secret-value", json.dumps(payload))

    def test_packaged_startup_check_never_reads_config_or_contacts_printer(self):
        output = io.StringIO()
        with mock.patch.object(native, "load_config") as config_read, mock.patch.object(native.Cups, "submit") as submit, mock.patch("sys.stdout", output):
            native.main(["self-check"])
        result = json.loads(output.getvalue())
        self.assertEqual(result["version"], native.COMPANION_VERSION)
        self.assertEqual(result["networkRequests"], 0)
        self.assertEqual(result["printerSubmissions"], 0)
        config_read.assert_not_called()
        submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
