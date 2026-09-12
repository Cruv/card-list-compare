"""Synthetic CUPS replies, disposable ledgers and fake transports only."""
import json
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import tempfile
import unittest
from unittest import mock

import clc_print_station as native
from clc_printer_health import parse_printer_health
from clc_station_alerts import RefeedAlerts, APPLE_SCRIPT, DISCORD_SETTING
from clc_station_control import StationControl
from test_print_station import FakeCups, FakeClient, config, job


def reply(reasons=None, state=3, message="", accepting=True):
    return plistlib.dumps({"Tests": [{"Successful": True, "ResponseAttributes": [{
        "printer-state": state, "printer-state-reasons": reasons or ["none"],
        "printer-state-message": message, "printer-is-accepting-jobs": accepting}]}]})


def fault(name="media-empty"):
    return parse_printer_health(reply([name]))


class PrinterHealthTests(unittest.TestCase):
    def test_actionable_reasons_and_suffixes(self):
        for reason in ("media-empty", "media-jam-error", "door-open", "offline", "cups-filter-error", "vendor-widget-error"):
            with self.subTest(reason=reason):
                health = parse_printer_health(reply([reason]))
                self.assertFalse(health["ok"])
                self.assertTrue(health["known"])
                self.assertTrue(health["reasons"])
        self.assertIn("vendor widget", parse_printer_health(reply(["vendor-widget-error"]))["message"])

    def test_stopped_not_accepting_and_known_driver_messages(self):
        self.assertIn("queue-stopped", parse_printer_health(reply(state=5))["reasons"])
        self.assertIn("not-accepting-jobs", parse_printer_health(reply(accepting=False))["reasons"])
        health = parse_printer_health(reply(message="COM_001 Looking for printer https://secret.invalid/token"))
        self.assertEqual(health["reasons"], ["offline"])
        self.assertNotIn("secret", health["message"])
        self.assertIn("media-jam", parse_printer_health(reply(message="Paper jam. Remove paper."))["reasons"])

    def test_healthy_and_supply_warning_do_not_alert(self):
        for reasons in (["none"], ["marker-supply-low-warning"], ["toner-low"]):
            self.assertTrue(parse_printer_health(reply(reasons, state=4))["ok"])

    def test_unknown_and_connecting_status_cannot_clear_episode(self):
        for reasons in (["unknown"], ["vendor-mystery"], ["vendor-status-report"], ["connecting-to-device"]):
            self.assertFalse(parse_printer_health(reply(reasons))["known"])

    def test_epson_ink_check_reminder_is_informational_while_printing(self):
        health = parse_printer_health(reply(["com.epson.INKCHECKALERT_005-warning"], state=4, message="Printing..."))
        self.assertTrue(health["known"])
        self.assertTrue(health["ok"])
        self.assertEqual(health["message"], "Printer queue is processing")
        self.assertEqual(health["reasons"], [])
        self.assertEqual(health["advisories"], ["Regularly check ink levels in the actual ink tanks."])

    def test_epson_reminder_never_masks_a_simultaneous_fault_or_unknown_status(self):
        reminder = "com.epson.INKCHECKALERT_005-warning"
        for response, job_state, expected in (
                (reply([reminder, "media-empty-error"]), None, "media-empty"),
                (reply([reminder], state=5), None, "queue-stopped"),
                (reply([reminder], accepting=False), None, "not-accepting-jobs"),
                (reply([reminder], message="Out of ink"), None, "ink-empty"),
                (reply([reminder]), 6, "job-stopped")):
            with self.subTest(reason=expected):
                health = parse_printer_health(response, job_state)
                self.assertFalse(health["ok"])
                self.assertTrue(health["known"])
                self.assertIn(expected, health["reasons"])
                self.assertEqual(health["advisories"], ["Regularly check ink levels in the actual ink tanks."])
        unknown = parse_printer_health(reply([reminder, "vendor-unknown-warning"]))
        self.assertFalse(unknown["ok"])
        self.assertFalse(unknown["known"])
        self.assertTrue(unknown["advisories"])

    def test_similar_epson_keywords_remain_unknown_or_faults(self):
        for reason in ("com.epson.INKCHECKALERT_006-warning", "com.epson.INKCHECKALERT_005-report",
                       "com.epson.INKCHECKALERT_005", "com-epson-INKCHECKALERT-005-warning"):
            with self.subTest(reason=reason):
                health = parse_printer_health(reply([reason]))
                self.assertFalse(health["known"])
                self.assertFalse(health["ok"])
                self.assertEqual(health["advisories"], [])
        error = parse_printer_health(reply(["com.epson.INKCHECKALERT_005-error"]))
        self.assertFalse(error["ok"])
        self.assertTrue(error["known"])
        self.assertTrue(error["reasons"])
        self.assertEqual(error["advisories"], [])
        generic = parse_printer_health(reply(["com.epson.FILTER_001-error"]))
        self.assertTrue(generic["known"])
        self.assertIn("com epson filter 001", generic["message"])

    def test_incomplete_failed_or_oversized_replies_rejected(self):
        data = plistlib.loads(reply())
        variants = [b"not plist", b"x" * (256 * 1024 + 1)]
        for attr in ("printer-state", "printer-is-accepting-jobs", "printer-state-reasons"):
            copy = json.loads(json.dumps(data))
            del copy["Tests"][0]["ResponseAttributes"][0][attr]
            variants.append(plistlib.dumps(copy))
        data["Tests"][0]["Successful"] = False
        variants.append(plistlib.dumps(data))
        for value in variants:
            with self.assertRaises(ValueError):
                parse_printer_health(value)

    def test_scalar_or_malformed_plist_container_shapes_raise_value_error(self):
        shapes = ["scalar", [], {"Tests": 1}, {"Tests": [1]}, {"Tests": "scalar"},
                  {"Tests": [{"Successful": True, "ResponseAttributes": 1}]},
                  {"Tests": [{"Successful": True, "ResponseAttributes": [1]}]},
                  {"Tests": [{"Successful": True, "ResponseAttributes": {"printer-state": 3}}]}]
        for shape in shapes:
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                parse_printer_health(plistlib.dumps(shape))
        with self.assertRaises(ValueError):
            parse_printer_health(None)

    def test_active_job_hold_stop_cancel_abort_are_actionable(self):
        for state in (4, 6, 7, 8):
            health = parse_printer_health(reply(), state)
            self.assertFalse(health["ok"])
            self.assertTrue(health["reasons"][0].startswith("job-"))
        for state in (3, 5, 9):
            self.assertTrue(parse_printer_health(reply(), state)["ok"])

    def test_cups_uses_only_fixed_local_read_operation(self):
        runner = mock.Mock(return_value=reply())
        cups = native.Cups({"queue": "EPSON"}, runner)
        self.assertTrue(cups.status()["ok"])
        self.assertEqual(runner.call_args.args[0], ["/usr/bin/ipptool", "-X", "-T", "15", "ipp://localhost/printers/EPSON", str(native.HERE / "get-printer.test")])
        template = (native.HERE / "get-printer.test").read_text()
        self.assertEqual([line.strip() for line in template.splitlines() if line.strip().startswith("OPERATION")], ["OPERATION Get-Printer-Attributes"])
        cups.jobs = mock.Mock(return_value=[])
        self.assertFalse(cups.status("EPSON-7")["known"], "Missing active job is not completion or healthy evidence")
        cups.jobs.return_value = [{"id": "EPSON-7", "state": 8}]
        self.assertIn("job-aborted", cups.status("EPSON-7")["reasons"])


class PrinterAlertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "state"
        self.ledger = native.Ledger(self.directory)
        self.config = {"queue": "EPSON", "server_url": "https://clc.example.invalid", "refeed_discord_webhook_url": "https://discord.com/api/webhooks/123/fixture", "refeed_discord_user_id": "456"}
        self.runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.transport = mock.Mock(return_value={"id": "1"})
        self.alerts = RefeedAlerts(self.ledger, self.config, self.runner, self.transport)

    def tearDown(self):
        self.ledger.db.close()
        self.temp.cleanup()

    def test_channel_attempts_are_durable_before_delivery_and_use_safe_arguments(self):
        def send(*_args, **_kwargs):
            with sqlite3.connect(self.directory / "station.sqlite3") as db:
                self.assertEqual(db.execute("SELECT outcome FROM printer_error_alerts WHERE channel='mac'").fetchone()[0], "attempting")
            return subprocess.CompletedProcess([], 0, "", "")
        self.runner.side_effect = send
        value = {"id": "job123456789abcdef", "deckName": "Deck @everyone `code`", "artifacts": [{"id": "dfc-002", "label": "CLC job packet 2/3"}]}
        pending = {"artifact_id": "dfc-002", "phase": "backs"}
        answer = self.alerts.printer_error(fault(), value, pending)
        self.assertEqual(answer["status"], "attempted")
        command = self.runner.call_args.args[0]
        self.assertEqual(command[:2], ["/usr/bin/osascript", "-"])
        self.assertEqual(self.runner.call_args.kwargs["input"], APPLE_SCRIPT)
        self.assertEqual(self.runner.call_args.kwargs["timeout"], 5)
        self.assertIn("job123456789", command[3])
        self.assertIn("packet 2/3; pass: backs", command[4])
        payload = self.transport.call_args.args[1]
        self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": ["456"], "roles": []})
        self.assertNotIn("@everyone", payload["content"])
        self.assertIn("/#print-station", payload["content"])

    def test_repeated_fault_restart_and_unknown_reads_do_not_resend(self):
        self.alerts.printer_error(fault())
        self.alerts.printer_error(fault())
        self.alerts.printer_error({"ok": False, "known": False})
        self.ledger.db.close()
        self.ledger = native.Ledger(self.directory)
        restarted = RefeedAlerts(self.ledger, self.config, self.runner, self.transport)
        self.assertEqual(restarted.printer_error(fault())["status"], "duplicate")
        self.assertEqual(self.runner.call_count, 1)
        self.assertEqual(self.transport.call_count, 1)

    def test_fault_transition_alerts_once_and_healthy_rearms(self):
        for value in (fault(), fault("media-jam"), fault(), fault("media-jam")):
            self.alerts.printer_error(value)
        self.assertEqual(self.runner.call_count, 2)
        self.alerts.printer_error(parse_printer_health(reply()))
        self.alerts.printer_error(fault())
        self.assertEqual(self.runner.call_count, 3)

    def test_ink_check_advisory_is_silent_and_clears_only_a_resolved_fault(self):
        reminder = "com.epson.INKCHECKALERT_005-warning"
        healthy = parse_printer_health(reply([reminder], state=4))
        self.alerts.printer_error(healthy)
        self.runner.assert_not_called()
        self.transport.assert_not_called()
        self.alerts.printer_error(fault())
        self.alerts.printer_error(parse_printer_health(reply([reminder, "media-empty"])))
        self.assertEqual(self.runner.call_count, 1, "An advisory alongside the same fault must not resend")
        self.alerts.printer_error(healthy)
        self.assertEqual(self.runner.call_count, 1, "Recovery with an advisory needs no alert")
        self.alerts.printer_error(fault())
        self.assertEqual(self.runner.call_count, 2, "A new fault after real recovery should alert")
        self.assertEqual(self.transport.call_count, 2)

    def test_timeout_or_ambiguous_transport_is_not_retried_and_does_not_block_other_channel(self):
        self.runner.side_effect = subprocess.TimeoutExpired("osascript", 5)
        self.transport.side_effect = ValueError("https://discord.com/api/webhooks/123/PRIVATE")
        result = self.alerts.printer_error(fault())
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("PRIVATE", result["message"])
        self.alerts.printer_error(fault())
        self.assertEqual(self.runner.call_count, 1)
        self.assertEqual(self.transport.call_count, 1)

    def test_managed_disconnect_wins_and_mac_preference_independent(self):
        self.ledger.write("INSERT INTO settings VALUES(?,?)", (DISCORD_SETTING, json.dumps({"enabled": False, "revision": "disabled"})))
        self.assertEqual(self.alerts.printer_error(fault())["channels"]["discord"]["status"], "disabled")
        self.transport.assert_not_called()
        self.config["refeed_notifications"] = False
        self.ledger.write("DELETE FROM settings WHERE key=?", (DISCORD_SETTING,))
        result = self.alerts.printer_error(fault("media-jam"))
        self.assertEqual(result["channels"]["mac"]["status"], "disabled")
        self.assertEqual(self.transport.call_count, 1)

    def test_storage_failure_never_sends_and_reports_once(self):
        with mock.patch.object(self.ledger, "write", side_effect=OSError("fixture fail")):
            self.assertEqual(self.alerts.printer_error(fault())["status"], "failed")
        self.assertEqual(self.alerts.printer_error(fault())["status"], "duplicate")
        self.runner.assert_not_called()
        self.transport.assert_not_called()

    def test_invalid_discord_override_does_not_suppress_mac(self):
        self.ledger.write("INSERT INTO settings VALUES(?,?)", (DISCORD_SETTING, "invalid-json"))
        result = self.alerts.printer_error(fault())
        self.assertEqual(result["channels"]["mac"]["status"], "attempted")
        self.assertEqual(result["channels"]["discord"]["status"], "failed")


class PrinterControlTests(unittest.TestCase):
    def test_read_only_health_alerts_preserve_pause_and_active_pass_and_unknown_does_not_clear(self):
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(Path(temp)); cfg["refeed_notifications"] = True; cups = FakeCups()
            station = native.Station(cfg, FakeClient(job()), cups)
            try:
                station.adopt(job())
                current = station.ledger.passes("job1")[0]
                station.ledger.set_pass(current, "submitted", spooler_id="EPSON-9")
                station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','0')")
                station.alerts.runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
                control = StationControl(station, "2.53.0", manager=mock.Mock(managed_status=lambda _config: {"supported": False}))
                cups.status = mock.Mock(return_value=fault("media-jam"))
                control.check_printer()
                cups.status.assert_called_once_with("EPSON-9")
                self.assertFalse(control.snapshot()["health"]["ok"])
                self.assertFalse(station.ledger.paused())
                self.assertEqual(station.ledger.passes("job1")[0]["state"], "submitted")
                self.assertEqual(station.ledger.passes("job1")[0]["resume_requested"], 0)
                self.assertEqual(cups.submissions, [])
                self.assertEqual(station.alerts.runner.call_count, 1)
                control.last_doctor = None
                cups.status.side_effect = native.StationError("read failed")
                control.check_printer()
                control.last_doctor = None
                cups.status.side_effect = None
                control.check_printer()
                self.assertEqual(station.alerts.runner.call_count, 1)
                control.last_doctor = None
                cups.status.return_value = parse_printer_health(reply())
                cups.doctor = mock.Mock(side_effect=native.StationError("driver options unavailable"))
                control.check_printer()
                control.last_doctor = None
                cups.status.return_value = fault("media-jam")
                control.check_printer()
                self.assertEqual(station.alerts.runner.call_count, 1, "Failed driver validation must not clear the fault")
                station.alerts.printer_error = mock.Mock(side_effect=OSError("alert helper failed"))
                control.last_doctor = None
                control.check_printer()
                self.assertEqual(cups.submissions, [])
                self.assertFalse(station.ledger.paused())
            finally:
                station.ledger.db.close()

    def test_unknown_vendor_warning_does_not_pause_or_block_new_native_submission(self):
        from test_station_control import ManagedClient
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(Path(temp)); cups = FakeCups()
            station = native.Station(cfg, ManagedClient(job()), cups)
            try:
                station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','0')")
                cups.status = mock.Mock(return_value=parse_printer_health(reply(["com.epson.UNKNOWN_005-warning"])))
                control = StationControl(station, "2.53.0", manager=mock.Mock(managed_status=lambda _config: {"supported": False}))
                station.management = control
                control.check_printer()
                self.assertFalse(control.health["ok"])
                self.assertFalse(control.snapshot()["health"]["known"])
                self.assertEqual(control.snapshot()["health"]["advisories"], [])
                event = station.ledger.db.execute("SELECT level FROM station_log WHERE message=? ORDER BY rowid DESC LIMIT 1",
                                                  (control.health["message"],)).fetchone()
                self.assertEqual(event["level"], "warning", "Uncertain telemetry is not a confirmed printer error")
                self.assertFalse(station.ledger.paused())
                self.assertEqual(station.poll_once(), "submitted EPSON-1")
                self.assertEqual(len(cups.submissions), 1)
                self.assertFalse(station.ledger.paused())
            finally:
                station.ledger.db.close()

    def test_ink_check_reminder_reaches_telemetry_without_attention_or_control_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(Path(temp)); cfg["refeed_notifications"] = True
            cups = FakeCups()
            station = native.Station(cfg, FakeClient(job()), cups)
            try:
                station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','0')")
                station.alerts.runner = mock.Mock()
                cups.status = mock.Mock(return_value=parse_printer_health(reply(["com.epson.INKCHECKALERT_005-warning"], state=4)))
                control = StationControl(station, "2.53.0", manager=mock.Mock(managed_status=lambda _config: {"supported": False}))
                self.assertFalse(control.snapshot()["health"]["known"], "Initial pending check is not a known fault")
                control.check_printer()
                self.assertEqual(control.snapshot()["health"], {
                    "ok": True, "known": True, "message": "Printer queue is processing",
                    "advisories": ["Regularly check ink levels in the actual ink tanks."]})
                event = station.ledger.db.execute("SELECT level FROM station_log WHERE message=? ORDER BY rowid DESC LIMIT 1",
                                                  (control.health["message"],)).fetchone()
                self.assertEqual(event["level"], "info")
                station.alerts.runner.assert_not_called()
                self.assertFalse(station.ledger.paused())
                self.assertEqual(cups.submissions, [])
            finally:
                station.ledger.db.close()

    def test_two_read_failures_alert_once_without_claiming_recovery_or_changing_queue(self):
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(Path(temp)); cfg["refeed_notifications"] = True
            cups = FakeCups()
            station = native.Station(cfg, FakeClient(job()), cups)
            try:
                station.alerts.runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
                control = StationControl(station, "2.53.0", manager=mock.Mock(managed_status=lambda _config: {"supported": False}))
                cups.status = mock.Mock(side_effect=native.StationError("unreachable local CUPS"))
                control.check_printer()
                station.alerts.runner.assert_not_called()
                self.assertFalse(control.snapshot()["health"]["known"])
                control.last_doctor = None
                control.check_printer()
                self.assertTrue(control.snapshot()["health"]["known"])
                self.assertEqual(control.snapshot()["health"]["advisories"], [])
                self.assertEqual(station.alerts.runner.call_count, 1)
                control.last_doctor = None
                control.check_printer()
                self.assertEqual(station.alerts.runner.call_count, 1)
                self.assertEqual(cups.submissions, [])
                self.assertFalse(control.health["ok"])
            finally:
                station.ledger.db.close()


if __name__ == '__main__':
    unittest.main()
