"""All alert tests use fake subprocesses: no macOS notifications or printer calls."""

import copy
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

from clc_print_station import Ledger
from clc_station_alerts import APPLE_SCRIPT, NoDiscordRedirect, RefeedAlerts, post_discord, validate_alert_config, discord_test_payload


def fixture():
    artifact = {"id": "dfc-1", "kind": "dfc", "pageCount": 2,
                "frontPages": [1], "backPages": [2], "packetIndex": 1, "packetCount": 2}
    return {"id": "job-123456789abcdef", "deckName": "Sauron", "artifacts": [artifact]}, artifact


class RefeedAlertTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "state"
        self.ledger = Ledger(self.directory)
        self.config = {}
        self.runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.alerts = RefeedAlerts(self.ledger, self.config, runner=self.runner)
        self.job, self.artifact = fixture()

    def tearDown(self):
        self.ledger.db.close()
        self.temporary.cleanup()

    def test_one_sound_request_identifies_exact_batch_and_only_printed_sheet(self):
        response = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(response["status"], "attempted")
        self.assertEqual(response["level"], "info")
        self.assertIn("requested", response["message"])
        args, kwargs = self.runner.call_args
        command = args[0]
        self.assertEqual(command[:2], ["/usr/bin/osascript", "-"])
        self.assertIn("Sauron", command[3])
        self.assertIn("job-12345678", command[3])
        self.assertIn("Batch 1/2", command[3])
        self.assertIn("only the 1 printed sheet", command[4])
        self.assertIn("Remove blank paper from the rear feeder", command[4])
        self.assertIn("confirm in CLC", command[4])
        self.assertEqual(command[5], "true")
        self.assertEqual(kwargs["input"], APPLE_SCRIPT)
        self.assertIn('sound name "Glass"', APPLE_SCRIPT)
        self.assertEqual(kwargs["timeout"], 5)
        self.assertNotIn("shell", kwargs)

    def test_dynamic_text_cannot_become_script_or_shell_code(self):
        self.job["deckName"] = 'Denny " & do shell script "touch /tmp/DO-NOT-CREATE"\n$(whoami) `id` \\'
        self.alerts.notify(self.job, self.artifact)
        command = self.runner.call_args.args[0]
        self.assertIn('Denny " & do shell script', command[3])
        self.assertNotIn("\n", command[3])
        self.assertNotIn("Denny", self.runner.call_args.kwargs["input"])
        self.assertEqual(self.runner.call_args.kwargs["input"], APPLE_SCRIPT)

    def test_durable_reservation_exists_before_external_attempt(self):
        def execute(*_args, **_kwargs):
            with sqlite3.connect(self.directory / "station.sqlite3") as observer:
                row = observer.execute("SELECT job_id,artifact_id,phase,outcome FROM refeed_alerts").fetchone()
            self.assertEqual(row, (self.job["id"], self.artifact["id"], "backs", "attempting"))
            return subprocess.CompletedProcess([], 0, "", "")
        self.runner.side_effect = execute
        self.alerts.notify(self.job, self.artifact)
        self.assertEqual(self.ledger.db.execute("SELECT outcome FROM refeed_alerts").fetchone()[0], "attempted")

    def test_polling_and_restart_do_not_repeat_same_batch(self):
        self.alerts.notify(self.job, self.artifact)
        for _ in range(20):
            response = self.alerts.notify(self.job, self.artifact)
            self.assertEqual({key: response[key] for key in ("status", "message", "level")}, {"status": "duplicate", "message": None, "level": None})
        self.ledger.db.close()
        self.ledger = Ledger(self.directory)
        restarted = RefeedAlerts(self.ledger, self.config, runner=self.runner)
        self.assertEqual(restarted.notify(self.job, self.artifact)["status"], "duplicate")
        self.runner.assert_called_once()

    def test_crash_after_reservation_does_not_retry_on_restart(self):
        self.ledger.write("INSERT INTO refeed_alerts VALUES(?,?,?,?,?)", (self.job["id"], self.artifact["id"], "backs", 1, "attempting"))
        self.assertEqual(RefeedAlerts(self.ledger, {}, runner=self.runner).notify(self.job, self.artifact)["status"], "duplicate")
        self.runner.assert_not_called()

    def test_different_packets_and_jobs_each_receive_one_alert(self):
        self.alerts.notify(self.job, self.artifact)
        second = {**self.artifact, "id": "dfc-2", "packetIndex": 2}
        self.job["artifacts"].append(second)
        self.assertEqual(self.alerts.notify(self.job, second)["status"], "attempted")
        self.assertIn("Batch 2/2", self.runner.call_args.args[0][3])
        self.assertEqual(self.alerts.notify({**self.job, "id": "different-job"}, second)["status"], "attempted")
        self.assertEqual(self.runner.call_count, 3)

    def test_legacy_multi_sheet_pdf_reports_sheets_not_total_pages(self):
        legacy = {"id": "legacy-dfc", "kind": "dfc", "pageCount": 6, "frontPages": [1, 3, 5], "backPages": [2, 4, 6]}
        job = {**self.job, "artifacts": [legacy]}
        self.alerts.notify(job, legacy)
        command = self.runner.call_args.args[0]
        self.assertIn("Batch 1/1", command[3])
        self.assertIn("the 3 printed sheets", command[4])
        self.assertNotIn("6 printed sheets", command[4])

    def test_packet_position_and_sheet_count_fallbacks(self):
        first = {"id": "first", "kind": "dfc", "pageCount": 2}
        second = {"id": "second", "kind": "dfc", "sheetCount": 2}
        job = {**self.job, "artifacts": [{"id": "fronts", "kind": "ordinary"}, first, second]}
        self.alerts.notify(job, first)
        self.assertIn("Batch 1/2", self.runner.call_args.args[0][3])
        self.assertIn("the 1 printed sheet", self.runner.call_args.args[0][4])
        self.alerts.notify(job, second)
        self.assertIn("Batch 2/2", self.runner.call_args.args[0][3])
        self.assertIn("the 2 printed sheets", self.runner.call_args.args[0][4])

    def test_silent_preference_omits_sound_but_keeps_visual_notification(self):
        self.config["refeed_sound"] = False
        self.assertEqual(self.alerts.notify(self.job, self.artifact)["status"], "attempted")
        self.assertEqual(self.runner.call_args.args[0][-1], "false")

    def test_disabled_notifications_do_not_consume_batch_attempt(self):
        self.config["refeed_notifications"] = False
        self.assertEqual(self.alerts.notify(self.job, self.artifact)["status"], "disabled")
        self.runner.assert_not_called()
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM refeed_alerts").fetchone()[0], 0)
        self.config["refeed_notifications"] = True
        self.assertEqual(self.alerts.notify(self.job, self.artifact)["status"], "attempted")

    def test_ordinary_fronts_never_raise_flip_alert(self):
        self.assertEqual(self.alerts.notify(self.job, {**self.artifact, "kind": "ordinary"})["status"], "ignored")
        self.runner.assert_not_called()

    def test_subprocess_failures_return_warning_once_without_retry_or_raw_output(self):
        for outcome in [subprocess.TimeoutExpired("osascript", 5), OSError("private path or data"),
                        RuntimeError("private runtime detail"), subprocess.CompletedProcess([], 1, "", "private stderr")]:
            with self.subTest(outcome=type(outcome).__name__):
                artifact = copy.deepcopy(self.artifact)
                artifact["id"] = "failure-" + str(self.runner.call_count)
                if isinstance(outcome, Exception):
                    self.runner.side_effect = outcome
                else:
                    self.runner.side_effect = None
                    self.runner.return_value = outcome
                response = self.alerts.notify(self.job, artifact)
                self.assertEqual(response["status"], "failed")
                self.assertEqual(response["level"], "warning")
                self.assertIn("CLC Print Station", response["message"])
                self.assertNotIn("private", response["message"])
                before = self.runner.call_count
                self.assertEqual(self.alerts.notify(self.job, artifact)["status"], "duplicate")
                self.assertEqual(self.runner.call_count, before)

    def test_storage_setup_failure_never_raises_or_attempts_undurable_notification(self):
        broken = mock.Mock()
        broken.write.side_effect = sqlite3.OperationalError("disk full")
        alerts = RefeedAlerts(broken, {}, runner=self.runner)
        self.assertEqual(alerts.notify(self.job, self.artifact)["status"], "failed")
        self.assertEqual(alerts.notify(self.job, self.artifact)["status"], "duplicate")
        self.runner.assert_not_called()

    def test_completion_storage_failure_keeps_pre_attempt_deduplication(self):
        with mock.patch.object(self.ledger, "write", side_effect=sqlite3.OperationalError("disk full")):
            response = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(response["status"], "failed")
        self.assertIn("was attempted", response["message"])
        self.assertEqual(self.alerts.notify(self.job, self.artifact)["status"], "duplicate")
        self.runner.assert_called_once()

    def test_malformed_description_does_not_raise_or_invent_one_sheet(self):
        response = self.alerts.notify(self.job, {"id": "bad", "kind": "dfc", "pageCount": 3})
        self.assertEqual(response["status"], "failed")
        self.runner.assert_not_called()


WEBHOOK_ID = "223704706495545344"
USER_ID = "190320984123768832"
WEBHOOK = "https://discord.com/api/webhooks/" + WEBHOOK_ID + "/local-test-token-not-a-real-secret"
MESSAGE = {"id": "333704706495545344", "webhook_id": WEBHOOK_ID}


class DiscordAlertTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "state"
        self.ledger = Ledger(self.directory)
        self.config = {"refeed_discord_webhook_url": WEBHOOK, "refeed_discord_user_id": USER_ID,
                       "server_url": "https://clc.test"}
        self.runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.transport = mock.Mock(return_value=MESSAGE)
        self.alerts = RefeedAlerts(self.ledger, self.config, runner=self.runner, discord_transport=self.transport)
        self.job, self.artifact = fixture()
        self.artifact["label"] = "CLC a12b34c56d78 DFC 1/2"

    def tearDown(self):
        self.ledger.db.close()
        self.temporary.cleanup()

    def test_discord_packet_identity_sheet_count_and_explicit_user_ping(self):
        response = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(response["channels"]["discord"]["status"], "attempted")
        url, payload = self.transport.call_args.args
        self.assertEqual(url, WEBHOOK)
        self.assertEqual(self.transport.call_args.kwargs, {"timeout": 5})
        self.assertTrue(payload["content"].startswith("<@" + USER_ID + ">"))
        self.assertIn("Sauron", payload["content"])
        self.assertIn("job-12345678", payload["content"])
        self.assertIn("Batch 1/2", payload["content"])
        self.assertIn("Packet ID: dfc-1", payload["content"])
        self.assertIn("Printed label: CLC a12b34c56d78 DFC 1/2", payload["content"])
        self.assertIn("only the 1 printed sheet", payload["content"])
        self.assertEqual(payload["username"], "Proxy Balboa")
        self.assertIn("Yo, champ!", payload["content"])
        self.assertIn("Remove blank paper from the rear feeder", payload["content"])
        self.assertIn("Reload only the matching printed paper, then confirm", payload["content"])
        self.assertNotIn("Yo, champ!", " ".join(self.runner.call_args.args[0]), "Mac notifications remain plain")
        self.assertIn("<https://clc.test/#print-station>", payload["content"])
        self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": [USER_ID], "roles": []})
        self.assertFalse(payload["tts"])
        self.assertLessEqual(len(payload["content"]), 2000)

    def test_proxy_balboa_error_message_keeps_exact_problem_and_packet_without_mac_style_changes(self):
        health = {"ok": False, "known": True, "reasons": ["media-jam"], "message": "Printer has a paper jam"}
        pending = {"artifact_id": self.artifact["id"], "phase": "backs"}
        self.alerts.printer_error(health, self.job, pending)
        payload = self.transport.call_args.args[1]
        self.assertEqual(payload["username"], "Proxy Balboa")
        for value in ("Yo, champ!", "Sauron", "job-12345678", "Printer has a paper jam", "CLC a12b34c56d78 DFC 1/2", "pass: backs", "does not pause, resume or retry printing"):
            self.assertIn(value, payload["content"])
        self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": [USER_ID], "roles": []})
        self.assertLessEqual(len(payload["content"]), 2000)
        self.assertNotIn("Yo, champ!", " ".join(self.runner.call_args.args[0]))

    def test_proxy_balboa_test_message_retains_explicit_no_print_effect_and_safe_mentions(self):
        payload = discord_test_payload(self.config)
        self.transport(WEBHOOK, payload, timeout=5)
        self.assertEqual(payload["username"], "Proxy Balboa")
        for text in ("Yo, champ!", "Discord test confirmed", "sheets to flip", "printer errors", "does not print or resume anything"):
            self.assertIn(text, payload["content"])
        self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": [USER_ID], "roles": []})
        self.assertLessEqual(len(payload["content"]), 2000)
        self.assertFalse(payload["tts"])
        self.runner.assert_not_called()

    def test_deck_text_cannot_add_user_role_or_everyone_mentions(self):
        self.job["deckName"] = "@everyone @here <@123456789> <@&987654321> **name**\n# fake heading"
        self.alerts.notify(self.job, self.artifact)
        payload = self.transport.call_args.args[1]
        content = payload["content"]
        self.assertNotIn("@everyone", content)
        self.assertNotIn("@here", content)
        self.assertNotIn("<@123456789>", content)
        self.assertNotIn("<@&987654321>", content)
        self.assertNotIn("**name**", content)
        self.assertEqual(content.count("<@"), 1)
        self.assertEqual(payload["allowed_mentions"]["users"], [USER_ID])

    def test_no_configured_user_means_no_mentions_and_no_server_url_means_no_link(self):
        self.config["refeed_discord_user_id"] = ""
        self.config.pop("server_url")
        self.alerts.notify(self.job, self.artifact)
        payload = self.transport.call_args.args[1]
        self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": [], "roles": []})
        self.assertNotIn("<@", payload["content"])
        self.assertNotIn("https://", payload["content"])

    def test_mac_disabled_does_not_disable_discord(self):
        self.config["refeed_notifications"] = False
        response = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(response["channels"]["mac"]["status"], "disabled")
        self.assertEqual(response["channels"]["discord"]["status"], "attempted")
        self.runner.assert_not_called()
        self.transport.assert_called_once()

    def test_default_config_has_no_external_delivery(self):
        alerts = RefeedAlerts(self.ledger, {}, runner=self.runner, discord_transport=self.transport)
        response = alerts.notify(self.job, self.artifact)
        self.assertEqual(response["channels"]["discord"]["status"], "disabled")
        self.transport.assert_not_called()
        self.runner.assert_called_once()

    def test_enabling_discord_after_mac_alert_does_not_repeat_mac(self):
        self.config["refeed_discord_webhook_url"] = ""
        self.alerts.notify(self.job, self.artifact)
        self.config["refeed_discord_webhook_url"] = WEBHOOK
        response = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(response["channels"]["mac"]["status"], "duplicate")
        self.assertEqual(response["channels"]["discord"]["status"], "attempted")
        self.runner.assert_called_once()
        self.transport.assert_called_once()

    def test_mac_failure_does_not_block_discord_and_discord_failure_does_not_block_mac(self):
        self.runner.side_effect = OSError("Mac unavailable")
        first = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(first["channels"]["mac"]["status"], "failed")
        self.assertEqual(first["channels"]["discord"]["status"], "attempted")
        self.runner.side_effect = None
        self.transport.side_effect = TimeoutError("Discord unavailable")
        second = self.alerts.notify(self.job, {**self.artifact, "id": "another-packet"})
        self.assertEqual(second["channels"]["mac"]["status"], "attempted")
        self.assertEqual(second["channels"]["discord"]["status"], "failed")

    def test_discord_reservation_is_committed_before_send_and_survives_restart(self):
        def deliver(*_args, **_kwargs):
            with sqlite3.connect(self.directory / "station.sqlite3") as observer:
                row = observer.execute("SELECT job_id,artifact_id,phase,outcome FROM refeed_discord_alerts").fetchone()
            self.assertEqual(row, (self.job["id"], self.artifact["id"], "backs", "attempting"))
            return MESSAGE
        self.transport.side_effect = deliver
        self.alerts.notify(self.job, self.artifact)
        self.ledger.db.close()
        self.ledger = Ledger(self.directory)
        restarted = RefeedAlerts(self.ledger, self.config, runner=self.runner, discord_transport=self.transport)
        for _ in range(10):
            self.assertEqual(restarted.notify(self.job, self.artifact)["status"], "duplicate")
        self.transport.assert_called_once()
        self.runner.assert_called_once()

    def test_different_packets_get_distinct_discord_labels(self):
        self.alerts.notify(self.job, self.artifact)
        second = {**self.artifact, "id": "dfc-2", "packetIndex": 2, "label": "CLC a12b34c56d78 DFC 2/2"}
        self.alerts.notify(self.job, second)
        self.assertIn("Batch 2/2", self.transport.call_args.args[1]["content"])
        self.assertIn("Printed label: CLC a12b34c56d78 DFC 2/2", self.transport.call_args.args[1]["content"])
        self.assertEqual(self.transport.call_count, 2)

    def test_ambiguous_or_failed_delivery_is_not_retried_and_secrets_stay_out_of_results(self):
        for failure in [TimeoutError(WEBHOOK), urllib.error.URLError(WEBHOOK),
                        urllib.error.HTTPError(WEBHOOK, 429, "rate limit", {}, None),
                        ValueError("redirect " + WEBHOOK)]:
            with self.subTest(failure=type(failure).__name__):
                artifact = {**self.artifact, "id": "failure-" + str(self.transport.call_count)}
                self.transport.side_effect = failure
                response = self.alerts.notify(self.job, artifact)
                self.assertEqual(response["channels"]["discord"]["status"], "failed")
                self.assertNotIn(WEBHOOK, json.dumps(response))
                self.assertNotIn(WEBHOOK.rsplit("/", 1)[1], json.dumps(response))
                before = self.transport.call_count
                self.assertEqual(self.alerts.notify(self.job, artifact)["status"], "duplicate")
                self.assertEqual(self.transport.call_count, before)

    def test_invalid_webhook_cannot_call_transport_or_prevent_mac_alert(self):
        self.config["refeed_discord_webhook_url"] = "https://evil.test/api/webhooks/1/SECRET"
        response = self.alerts.notify(self.job, self.artifact)
        self.assertEqual(response["channels"]["discord"]["status"], "failed")
        self.assertEqual(response["channels"]["mac"]["status"], "attempted")
        self.assertNotIn("SECRET", json.dumps(response))
        self.transport.assert_not_called()


class DiscordTransportTests(unittest.TestCase):
    def test_local_validation_rejects_noncanonical_urls_without_echoing_secrets(self):
        for url in [WEBHOOK.replace("https:", "http:"), WEBHOOK.replace("discord.com", "discord.com.evil.test"),
                    WEBHOOK.replace("discord.com", "discordapp.com"), WEBHOOK.replace("discord.com", "user:SECRET@discord.com"),
                    WEBHOOK.replace("discord.com", "discord.com:443"), WEBHOOK + "?wait=true", WEBHOOK + "?", WEBHOOK + "#",
                    WEBHOOK + "/", WEBHOOK + "\n", WEBHOOK.replace("/api/", "/api/v10/"),
                    WEBHOOK.replace("/api/", "/%61pi/"), WEBHOOK.replace("local-test", "local%2Ftest"),
                    "https://discord.com/api/webhooks/18446744073709551616/SECRET", None, 123]:
            with self.subTest(url_type=type(url).__name__):
                with self.assertRaises(ValueError) as raised:
                    validate_alert_config({"refeed_discord_webhook_url": url})
                self.assertNotIn("SECRET", str(raised.exception))
                self.assertNotIn("local-test-token", str(raised.exception))
        validate_alert_config({})
        validate_alert_config({"refeed_discord_webhook_url": WEBHOOK, "refeed_discord_user_id": USER_ID})

    def test_only_valid_optional_snowflake_can_be_mentioned(self):
        for user_id in [None, 123, "@everyone", "<@123>", "0", "0123", "18446744073709551616", "123\n"]:
            with self.subTest(user_id=user_id):
                with self.assertRaises(ValueError):
                    validate_alert_config({"refeed_discord_user_id": user_id})
        for flag in ("refeed_notifications", "refeed_sound"):
            with self.assertRaises(ValueError):
                validate_alert_config({flag: "false"})

    @staticmethod
    def response(body, status=200):
        response = io.BytesIO(body)
        response.status = status
        return response

    def test_transport_uses_wait_receipt_bounded_read_and_no_auth_or_redirect_forwarding(self):
        opener = mock.Mock()
        opener.open.return_value = self.response(json.dumps(MESSAGE).encode())
        payload = {"content": "test", "allowed_mentions": {"parse": [], "users": [], "roles": []}}
        with mock.patch("clc_station_alerts.urllib.request.build_opener", return_value=opener) as build:
            self.assertEqual(post_discord(WEBHOOK, payload), MESSAGE)
        self.assertIsInstance(build.call_args.args[0], NoDiscordRedirect)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, WEBHOOK + "?wait=true")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), payload)
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 5})
        opener.open.assert_called_once()

    def test_redirects_are_refused_even_to_another_discord_webhook(self):
        handler = NoDiscordRedirect()
        for destination in ["https://evil.test/steal", WEBHOOK.replace(WEBHOOK_ID, "123456789012345678")]:
            with self.assertRaisesRegex(ValueError, "redirects are refused"):
                handler.redirect_request(urllib.request.Request(WEBHOOK), None, 302, "Found", {}, destination)

    def test_malformed_unrelated_or_oversized_receipts_fail_without_retry(self):
        for body, status in [(b"", 204), (b"not JSON", 200), (b"{}", 200),
                             (json.dumps({**MESSAGE, "webhook_id": "1"}).encode(), 200),
                             (json.dumps({**MESSAGE, "id": ""}).encode(), 200), (b" " * 65537, 200)]:
            with self.subTest(status=status, size=len(body)):
                opener = mock.Mock()
                opener.open.return_value = self.response(body, status)
                with mock.patch("clc_station_alerts.urllib.request.build_opener", return_value=opener):
                    with self.assertRaises(ValueError):
                        post_discord(WEBHOOK, {"content": "test"})
                opener.open.assert_called_once()


if __name__ == "__main__":
    unittest.main()
