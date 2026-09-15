"""Queue announcements use mocked Discord and temporary ledgers; never print."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import clc_print_station as native
from clc_station_control import StationControl
from test_print_station import FakeCups, config, job
from test_station_control import FakeManager, ManagedClient, control


def notice(identifier="6b8b64f1-1320-4dd0-96c6-714aa941a7bf", **changes):
    return {"id": identifier, "jobId": "c3397d3e-ae43-435c-ae96-2438c46f3283", "deckName": "Jin Sakai",
            "requesterName": "Cruv", "totalCopies": 100, "queuedAt": "2026-09-14T16:45:00.000Z", **changes}


class QueueClient(ManagedClient):
    def __init__(self):
        super().__init__(job())
        self.notices = [notice()]
        self.queue_ack = None

    def management_heartbeat(self, payload):
        response = super().management_heartbeat(payload)
        # Optional fields are omitted by an old server or a nonprocessing beat.
        if payload.get("queueNotifications"):
            response.update(queueNotifications=copy.deepcopy(self.notices), acknowledgedQueueNotificationIds=(
                self.queue_ack if self.queue_ack is not None else [entry["id"] for entry in payload["queueNotificationReceipts"]]))
        return response


class QueuedNotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = config(Path(self.temp.name))
        self.config.update(refeed_discord_webhook_url="https://discord.com/api/webhooks/123/fixture-secret",
                           refeed_discord_user_id="456")
        self.client, self.cups = QueueClient(), FakeCups()
        self.station = native.Station(self.config, self.client, self.cups)
        self.transport = mock.Mock()
        self.station.alerts.discord_transport = self.transport
        self.manager = FakeManager()
        self.control = StationControl(self.station, "2.56.0", self.manager)

    def tearDown(self):
        self.assertEqual(self.cups.submissions, [])
        self.assertEqual(self.client.claims, 0)
        self.station.ledger.db.close()
        self.temp.cleanup()

    def receipt(self, identifier=None):
        return self.station.ledger.db.execute("SELECT * FROM queue_notification_receipts WHERE id=?", (identifier or notice()["id"],)).fetchone()

    def sync(self):
        return self.control.sync(check_printer=False)

    def test_receipt_is_committed_before_send_and_payload_has_useful_facts_without_mentions(self):
        self.client.notices = [notice(deckName="Jin @everyone <@456> *deck*", requesterName="Cruv @here")]
        def send(url, payload, timeout):
            self.assertEqual(timeout, 5)
            self.assertEqual(self.receipt()["status"], "attempting")
            # Separate connection confirms the write committed before HTTP.
            import sqlite3
            with sqlite3.connect(self.station.ledger.directory / "station.sqlite3") as check:
                self.assertEqual(check.execute("SELECT status FROM queue_notification_receipts").fetchone()[0], "attempting")
            self.assertEqual(url, self.config["refeed_discord_webhook_url"])
            self.assertEqual(payload["username"], "Proxy Balboa")
            self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": [], "roles": []})
            self.assertFalse(payload["tts"])
            for text in ("Yo, we got another one lined up", "Job: Jin", "Queued by: Cruv", "Card copies: 100",
                         "Queued at: 2026-09-14T16:45:00.000Z", "Batch ID: " + notice()["jobId"], "Printer: EPSON",
                         "Accepted into the CLC print queue", "does not mean the printer has started", "https://clc.test/#print-station"):
                self.assertIn(text, payload["content"])
            for text in ("<@456>", "@everyone", "@here", "fixture-secret", self.config["token"]):
                self.assertNotIn(text, payload["content"])
        self.transport.side_effect = send
        paused_before = self.station.ledger.paused()
        self.sync()
        self.assertEqual(self.receipt()["status"], "attempted")
        self.assertEqual(self.station.ledger.paused(), paused_before)
        self.assertLess(len(self.transport.call_args.args[1]["content"]), 2000)

    def test_busy_and_paused_station_announces_without_claiming_or_changing_passes(self):
        self.station.adopt(self.client.job)
        self.station.ledger.write("UPDATE passes SET state='submitted',spooler_id='EPSON-42'")
        self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','1')")
        before = [dict(row) for row in self.station.ledger.passes("job1")]
        self.sync()
        self.transport.assert_called_once()
        self.assertEqual([dict(row) for row in self.station.ledger.passes("job1")], before)
        self.assertTrue(self.station.ledger.paused())

    def test_restart_and_lost_ack_resend_only_durable_receipt_not_message(self):
        self.sync()
        self.client.lose_reply = True
        with self.assertRaises(native.StationError):
            self.sync()
        self.control = StationControl(self.station, "2.56.0", self.manager)
        self.sync()
        self.assertEqual(self.client.statuses[-1]["queueNotificationReceipts"], [{"id": notice()["id"], "status": "attempted"}])
        self.assertEqual(self.receipt()["acknowledged"], 1)
        self.sync()
        self.assertEqual(self.client.statuses[-1]["queueNotificationReceipts"], [])
        self.transport.assert_called_once()

    def test_interrupted_attempt_recovers_failed_receipt_without_resend(self):
        digest = hashlib.sha256(json.dumps(notice(), sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        self.station.ledger.write("INSERT INTO queue_notification_receipts(id,payload_hash,status,at) VALUES(?,?,'attempting','fixture')", (notice()["id"], digest))
        self.control = StationControl(self.station, "2.56.0", self.manager)
        self.sync()
        self.assertEqual(self.receipt()["status"], "failed")
        self.assertEqual(self.receipt()["acknowledged"], 1)
        self.transport.assert_not_called()

    def test_transport_timeout_cannot_change_pause_or_retry_or_leak_destination(self):
        self.transport.side_effect = TimeoutError(self.config["refeed_discord_webhook_url"])
        self.client.commands = [control("unpause")]
        self.sync()
        self.control = StationControl(self.station, "2.56.0", self.manager)
        self.sync()
        self.assertEqual(self.receipt()["status"], "failed")
        self.assertFalse(self.station.ledger.paused())
        self.transport.assert_called_once()
        self.assertNotIn("fixture-secret", json.dumps(self.control.snapshot()))

    def test_same_id_with_changed_content_is_rejected_without_resending(self):
        self.sync()
        self.client.notices[0]["deckName"] = "Different deck"
        self.client.commands = [control("unpause")]
        self.sync()
        self.assertFalse(self.station.ledger.paused())
        self.transport.assert_called_once()
        self.assertEqual(self.receipt()["status"], "attempted")

    def test_disconnected_notice_is_recorded_and_not_replayed_on_later_connect(self):
        self.config["refeed_discord_webhook_url"] = ""
        self.sync()
        self.assertEqual(self.receipt()["status"], "disabled")
        self.config["refeed_discord_webhook_url"] = "https://discord.com/api/webhooks/123/new-secret"
        self.control = StationControl(self.station, "2.56.0", self.manager)
        self.sync()
        self.transport.assert_not_called()

    def test_configure_disconnect_in_same_response_precedes_notice_and_overrides_legacy(self):
        self.client.commands = [control("configure_discord", "disconnect", revision="disconnect", discord={"enabled": False, "webhookUrl": "", "userId": ""})]
        self.sync()
        self.assertEqual(self.receipt()["status"], "disabled")
        self.transport.assert_not_called()

    def test_configure_connect_in_same_response_uses_new_effective_destination(self):
        self.client.commands = [control("configure_discord", "connect", revision="connect", discord={"enabled": True, "webhookUrl": "https://discord.com/api/webhooks/123/new-secret", "userId": "789"})]
        self.sync()
        self.assertEqual(self.transport.call_args.args[0], "https://discord.com/api/webhooks/123/new-secret")
        self.assertEqual(self.transport.call_args.args[1]["allowed_mentions"]["users"], [])

    def test_process_false_progress_exchange_never_sends_notice_or_receipts(self):
        self.control.exchange(self.control.snapshot(), process=False)
        self.assertFalse(self.client.statuses[-1]["queueNotifications"])
        self.assertEqual(self.client.statuses[-1]["queueNotificationReceipts"], [])
        self.transport.assert_not_called()
        self.sync()
        self.control.exchange(self.control.snapshot(), process=False)
        self.assertEqual(self.client.statuses[-1]["queueNotificationReceipts"], [])
        self.assertEqual(self.receipt()["acknowledged"], 0)
        self.transport.assert_called_once()

    def test_absent_optional_old_server_fields_never_scan_existing_jobs(self):
        self.station.adopt(self.client.job)
        self.station.ledger.set_job("job1", "completed")
        self.client.management_heartbeat = mock.Mock(return_value={"commands": [], "acknowledgedCommandIds": []})
        self.sync()
        self.assertIsNone(self.receipt())
        self.transport.assert_not_called()

    def test_malformed_notices_never_send_and_valid_ids_receive_ignored_receipts(self):
        malformed = [{"totalCopies": True}, {"totalCopies": 0}, {"totalCopies": 1_000_001}, {"totalCopies": "100"},
                     {"deckName": "x" * 201}, {"deckName": "\n"}, {"requesterName": "x" * 121}, {"requesterName": None},
                     {"jobId": "not-a-uuid"}, {"queuedAt": "2026-09-14T16:45:00"}, {"queuedAt": "bad"},
                     {"queuedAt": "2026-09-14T16:45:00.000Z\n"}, {"extra": "not-permitted"}]
        for index, changes in enumerate(malformed):
            identifier = f"6b8b64f1-1320-4dd0-96c6-{index:012x}"
            self.client.notices = [notice(identifier, **changes)]
            self.sync()
            self.assertEqual(self.receipt(identifier)["status"], "ignored", changes)
        self.transport.assert_not_called()

    def test_invalid_notice_shapes_ids_and_acknowledgements_do_not_block_controls(self):
        cases = [None, "not-array", [notice(), notice()], [None], [{"id": "not-uuid"}], [{"id": None}]]
        for index, malformed in enumerate(cases):
            self.client.notices = malformed
            self.client.commands = [control("unpause", f"unpause{index}")]
            self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','1')")
            self.sync()
            self.assertFalse(self.station.ledger.paused())
        self.client.notices = [notice()]
        for index, ack in enumerate([None, "bad", ["unknown"], [123], [notice()["id"]] * 21]):
            # None here represents an actual invalid JSON null, unlike QueueClient's default.
            self.client.management_heartbeat = mock.Mock(return_value={"commands": [control("unpause", f"badack{index}")],
                "acknowledgedCommandIds": [], "acknowledgedQueueNotificationIds": ack, "queueNotifications": [notice()]})
            self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','1')")
            self.sync()
            self.assertFalse(self.station.ledger.paused())
        self.transport.assert_not_called()

    def test_failed_durable_reservation_never_sends_and_does_not_block_controls(self):
        # Removing only this feature's table simulates inaccessible notification storage.
        payload = self.control.snapshot()
        self.station.ledger.write("DROP TABLE queue_notification_receipts")
        self.client.commands = [control("unpause")]
        self.control.exchange(payload)
        self.assertFalse(self.station.ledger.paused())
        self.transport.assert_not_called()

    def test_optional_receipt_storage_read_failure_does_not_stop_actual_sync(self):
        self.station.ledger.write("DROP TABLE queue_notification_receipts")
        self.client.commands = [control("unpause")]
        self.sync()
        self.assertFalse(self.station.ledger.paused())
        self.assertFalse(self.client.statuses[-1]["queueNotifications"])
        self.assertEqual(self.client.statuses[-1]["queueNotificationReceipts"], [])
        self.transport.assert_not_called()

    def test_optional_receipt_storage_initialization_failure_does_not_stop_controls(self):
        original_write = self.station.ledger.write
        def fail_optional(sql, args=()):
            if "queue_notification_receipts" in sql:
                raise OSError("Optional alert table is unavailable")
            return original_write(sql, args)
        with mock.patch.object(self.station.ledger, "write", side_effect=fail_optional):
            self.control = StationControl(self.station, "2.56.0", self.manager)
        self.client.commands = [control("unpause")]
        self.sync()
        self.assertFalse(self.station.ledger.paused())
        self.assertFalse(self.client.statuses[-1]["queueNotifications"])
        self.transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
