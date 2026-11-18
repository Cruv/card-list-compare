"""Run with: python3 -m unittest discover -s companion/mac -p 'test_*.py'."""
import copy
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import struct
import tempfile
import threading
import unittest
from unittest import mock

import clc_print_station as station


PDF = b"%PDF-1.7\nfixture\n%%EOF\n"


def ppd_fixture(options):
    lines = ['*PPD-Adobe: "4.3"']
    for name, choices in options.items():
        lines.append(f"*OpenUI *{name}/{name}: PickOne")
        for choice in choices.split():
            lines.append(f'*{name} {choice}/Label: ""')
        lines.append(f"*CloseUI: *{name}")
    return "\n".join(lines).encode("ascii")


def config(directory):
    return {"queue": "EPSON", "server_url": "https://clc.test", "token": "test-token-" * 4,
            "state_dir": str(directory / "state"), "approved_recipe_ids": ["household-letter-v6"],
            "recipe_verified": True, "duplex_verified": True, "refeed_notifications": False, "driver_options": {"MediaType": "Glossy"},
            "ordinary_output_order": "reverse", "dfc_front_output_order": "reverse", "dfc_back_output_order": "normal",
            "max_pdf_bytes": 1024**3, "max_job_bytes": 2 * 1024**3, "poll_seconds": 5, "retention_days": 7}


def job(kind="ordinary", job_id="job1"):
    artifact = {"id": kind, "kind": kind, "downloadUrl": "/api/print-station/jobs/" + job_id + "/artifacts/" + kind,
                "sha256": hashlib.sha256(PDF).hexdigest(), "size": len(PDF),
                "pageCount": 4 if kind == "dfc" else 2,
                "frontPages": [1, 3] if kind == "dfc" else [1, 2], "backPages": [2, 4] if kind == "dfc" else []}
    return {"id": job_id, "claimToken": "claim-token-at-least-16", "recipeId": "household-letter-v6",
            "manifestSha256": "a" * 64, "state": "claimed", "artifacts": [artifact],
            "steps": [{"artifactId": kind, "phase": phase, "state": "pending"}
                      for phase in (["fronts", "backs"] if kind == "dfc" else ["fronts"])]}


def packet_job(packet_count=2):
    value = job()
    value["deckName"] = "Sauron"
    value["artifacts"][0].update(pageCount=1, frontPages=[1], sheetCount=1, cardCount=1)
    for index in range(1, packet_count + 1):
        artifact = copy.deepcopy(job("dfc")["artifacts"][0])
        identifier = "double-faced-" + str(index).zfill(3)
        artifact.update(id=identifier, pageCount=2, sheetCount=1, cardCount=1, frontPages=[1], backPages=[2],
                        packetIndex=index, packetCount=packet_count, label=f"CLC job1 DFC {index}/{packet_count}")
        value["artifacts"].append(artifact)
        value["steps"].extend({"artifactId": identifier, "phase": phase, "state": "pending"} for phase in ["fronts", "backs"])
    return value


def mixed_job(with_ordinary=True):
    value = packet_job(2)
    ordinary, first, last = value["artifacts"]
    ordinary["id"] = "fronts"
    first.update(cardCount=7, doubleFacedCardCount=7)
    last.update(cardCount=7 if with_ordinary else 4, doubleFacedCardCount=2)
    value["artifacts"] = [first, last] + ([ordinary] if with_ordinary else [])
    value["steps"] = value["steps"][1:]
    for step in value["steps"]:
        if step["phase"] == "backs":
            step["requiresRefeed"] = True
    if with_ordinary:
        value["steps"].append({"artifactId": "fronts", "phase": "fronts", "state": "pending"})
    value["steps"].sort(key=lambda step: step["phase"] == "backs")
    value.update(workflow=station.DEFERRED_WORKFLOW, sheetPacking=station.DOUBLE_FACED_FIRST,
                 totalCopies=sum(item["cardCount"] for item in value["artifacts"]))
    return value


class FakeClient:
    def __init__(self, value):
        self.job = value
        self.claims = 0
        self.events = []
        self.replies = {}
        self.fail_state = None
        self.replay_submitting = False

    def claim(self):
        self.claims += 1
        return copy.deepcopy(self.job)

    def download(self, artifact, target, heartbeat):
        target.write_bytes(PDF)
        return target

    def get_job(self, job_id):
        return copy.deepcopy(self.job)

    def report(self, _job, event):
        self.events.append(copy.deepcopy(event))
        if event["eventId"] in self.replies:
            return {**copy.deepcopy(self.replies[event["eventId"]]), "replayed": True}
        state = event["state"]
        if self.job["state"] in station.TERMINAL and state != "reconciled":
            raise station.StationError("CLC returned HTTP 409")
        entry = next((item for item in self.job["steps"] if item["artifactId"] == event.get("artifactId")
                      and item["phase"] == event.get("phase")), None)
        if entry:
            if state == "submitting" and entry["state"] != "pending":
                raise station.StationError("Pending pass required")
            if state == "submitted" and entry["state"] not in {"submitting", "uncertain"}:
                raise station.StationError("Submission intent required")
            if state == "completed" and entry["state"] != "submitted":
                raise station.StationError("Acknowledged spooler ID required")
            if state == "uncertain" and entry["state"] not in {"submitting", "submitted", "uncertain"}:
                raise station.StationError("No submission exists to reconcile")
            if state == "reconciled":
                if entry["state"] not in {"submitting", "submitted", "uncertain"}:
                    raise station.StationError("Reconciliation requires a disputed pass")
                if event["resolution"] == "abandoned":
                    if event.get("paperCleared") is not True:
                        raise station.StationError("Paper clearance required")
                    entry["state"] = self.job["state"] = "failed"
                else:
                    entry["state"] = event["resolution"]
            elif state == "failed":
                if entry["state"] in {"submitting", "uncertain"}:
                    raise station.StationError("Submission may have happened; reconcile instead")
                if entry["state"] == "submitted" and event.get("spoolerId") != entry["spoolerId"]:
                    raise station.StationError("A failed spooler outcome must identify its acknowledged job")
                physical_attempt = any(item["state"] in {"submitted", "completed"} for item in self.job["steps"])
                entry["state"] = self.job["state"] = "uncertain" if physical_attempt else "failed"
            elif state in {"submitting", "submitted", "completed", "uncertain", "failed"}:
                entry["state"] = self.job["state"] = state
            if event.get("spoolerId"):
                entry["spoolerId"] = event["spoolerId"]
            if entry["state"] == "completed":
                dfc = next(item for item in self.job["artifacts"] if item["id"] == entry["artifactId"])["kind"] == "dfc"
                self.job["state"] = "awaiting_refeed" if entry["phase"] == "fronts" and dfc else "claimed"
                if all(item["state"] == "completed" for item in self.job["steps"]):
                    self.job["state"] = "completed"
            elif state == "refeed":
                self.job["state"] = "claimed"
                entry["refeedConfirmed"] = True
        if state == "canceled" and self.job.get("cancelRequested") and event.get("paperCleared") is True:
            for item in self.job["steps"]:
                if item["state"] not in station.PASS_TERMINAL:
                    item.update(state="canceled", cancellationClearanceId=event["clearanceId"])
            self.job.update(state="canceled", cancelRequested=None, cancelRequestId=None)
        reply = {"job": copy.deepcopy(self.job), "replayed": self.replay_submitting and state == "submitting"}
        self.replies[event["eventId"]] = copy.deepcopy(reply)
        if state == self.fail_state:
            self.fail_state = None
            raise station.StationError("connection lost after server recorded event")
        return reply


class FakeCups:
    def __init__(self):
        self.submissions, self.history = [], []
        self.recipe_ids = []
        self.after_accept_error = False
        self.before_submit = lambda: None

    def doctor(self):
        return {}

    def status(self, _spooler_id=None):
        return {"ok": True, "known": True, "reasons": [], "message": "Printer queue is ready"}

    def jobs(self, require_complete=False):
        return copy.deepcopy(self.history)

    def submit(self, artifact, phase, title, path, recipe_id=station.LETTER_RECIPE):
        self.before_submit()
        self.recipe_ids.append(recipe_id)
        spooler_id = "EPSON-" + str(len(self.submissions) + 1)
        self.submissions.append((artifact["id"], phase, title, path))
        self.history.append({"id": spooler_id, "title": title, "state": 3})
        if self.after_accept_error:
            raise subprocess.TimeoutExpired("lp", 30)
        return spooler_id


class Response(io.BytesIO):
    def __init__(self, body, content_type="application/pdf"):
        super().__init__(body)
        self.headers = {"Content-Type": content_type}


class StationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.config = config(self.directory)
        self.client, self.cups = FakeClient(job()), FakeCups()
        self.station = station.Station(self.config, self.client, self.cups)

    def tearDown(self):
        self.station.ledger.db.close()
        self.temp.cleanup()

    def test_standalone_list_fronts_recover_with_no_deck_or_snapshot(self):
        self.client.job.update(deckId=None, mode="adhoc", deckName="Friday proxy replacements", source=None, target=None,
                               list={"name": "Friday proxy replacements", "textHash": "f" * 64})
        self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "completed")
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 1)
        saved = json.loads(self.station.ledger.db.execute("SELECT payload FROM jobs WHERE id='job1'").fetchone()[0])
        self.assertIsNone(saved["deckId"])
        self.assertIsNone(saved["source"])
        self.assertIsNone(saved["target"])
        self.assertEqual(saved["mode"], "adhoc")

    def test_standalone_dfc_keeps_manual_refeed_and_batch_alert_identity(self):
        self.client.job = packet_job(1)
        self.client.job["artifacts"] = self.client.job["artifacts"][1:]
        self.client.job["steps"] = self.client.job["steps"][1:]
        self.client.job.update(deckId=None, mode="adhoc", deckName="Friday proxy replacements", source=None, target=None,
                               list={"name": "Friday proxy replacements", "textHash": "f" * 64})
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.config["refeed_notifications"] = True
        self.station.alerts = station.RefeedAlerts(self.station.ledger, self.config, runner=runner)
        self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "awaiting_refeed")
        self.assertEqual(len(self.cups.submissions), 1)
        runner.assert_called_once()
        self.assertIn("Friday proxy replacements", runner.call_args.args[0][3])
        self.assertIn("Packet 1/1", runner.call_args.args[0][3])
        self.station.resume("job1")
        self.assertEqual(self.station.poll_once(), "submitted EPSON-2")
        self.assertEqual([entry[:2] for entry in self.cups.submissions], [
            ("double-faced-001", "fronts"), ("double-faced-001", "backs")])
        self.assertTrue(any(event["state"] == "refeed" for event in self.client.events))

    def completion_transport(self):
        self.config.update(refeed_discord_webhook_url="https://discord.com/api/webhooks/1234567890/FIXTURE_SECRET",
                           refeed_discord_user_id="123456789")
        transport = mock.Mock()
        self.station.alerts.discord_transport = transport
        return transport

    def test_new_completion_notifies_by_name_without_mention_and_never_replays_history(self):
        self.client.job.update(deckName="Friday replacements", totalCopies=8)
        transport = self.completion_transport()
        self.station.poll_once()
        transport.assert_not_called()  # Submitted is not completed.
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "completed")
        transport.assert_called_once()
        payload = transport.call_args.args[1]
        self.assertIn("Friday replacements", payload["content"])
        self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": [], "roles": []})
        self.assertNotIn("<@", payload["content"])
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.station.alerts.discord_transport = transport
        self.assertEqual(self.station.poll_once(), "already processed")
        transport.assert_called_once()
        self.assertEqual(len(self.cups.submissions), 1)

    def test_completion_recovered_after_lost_ack_notifies_once_even_when_paused(self):
        transport = self.completion_transport()
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.client.fail_state = "completed"
        with self.assertRaises(station.StationError):
            self.station.poll_once()
        transport.assert_not_called()
        self.cups.history = []
        self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','1')")
        self.assertEqual(self.station.poll_once(allow_submit=False), "completed")
        transport.assert_called_once()
        self.assertTrue(self.station.ledger.paused())
        self.assertEqual(self.station.poll_once(), "paused")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_completion_waits_for_every_packet_back(self):
        self.client.job = packet_job(2)
        transport = self.completion_transport()
        phases = [("ordinary", "fronts"), ("double-faced-001", "fronts"),
                  ("double-faced-001", "backs"), ("double-faced-002", "fronts"),
                  ("double-faced-002", "backs")]
        for index, phase in enumerate(phases):
            if phase[1] == "backs":
                self.assertEqual(self.station.poll_once(), "awaiting_refeed")
                flip = transport.call_args.args[1]
                self.assertIn("Paper flip needed", flip["content"])
                self.assertEqual(flip["allowed_mentions"]["users"], ["123456789"])
                self.station.resume("job1")
            self.assertTrue(self.station.poll_once().startswith("submitted"))
            self.assertEqual(self.cups.submissions[-1][:2], phase)
            self.cups.history[-1]["state"] = 9
            self.assertEqual(self.station.poll_once(), "reconciled")
            self.assertFalse(any("Print job complete" in call.args[1]["content"] for call in transport.call_args_list))
        self.assertEqual(self.station.poll_once(), "completed")
        completions = [call.args[1] for call in transport.call_args_list if "Print job complete" in call.args[1]["content"]]
        self.assertEqual(len(completions), 1)
        self.assertIn("Sauron", completions[0]["content"])
        self.assertEqual(completions[0]["allowed_mentions"]["users"], [])

    def test_completion_alert_exception_does_not_block_the_next_batch(self):
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        with mock.patch.object(self.station.alerts, "job_completed", side_effect=RuntimeError("private transport error")):
            self.assertEqual(self.station.poll_once(), "completed")
        self.assertIsNone(self.station.ledger.current())
        self.client.job = job(job_id="next-job")
        self.assertEqual(self.station.poll_once(), "submitted EPSON-2")

    def test_failed_or_uncertain_pass_never_sends_completion_message(self):
        transport = self.completion_transport()
        self.station.poll_once()
        self.cups.history[0]["state"] = 8
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "paper clearance required")
        self.assertEqual(self.station.ledger.current()["state"], "uncertain")
        transport.assert_not_called()

    def test_unverified_station_does_not_claim_without_explicit_boolean_test_mode(self):
        self.config.update(recipe_verified=False, duplex_verified=False)
        for value in (None, False, "true", 1):
            with self.subTest(value=value):
                self.config.pop("allow_unverified_printing", None)
                if value is not None:
                    self.config["allow_unverified_printing"] = value
                self.assertIn("proof", self.station.poll_once())
                self.assertEqual(self.client.claims, 0)
                self.assertEqual(self.cups.submissions, [])

    def test_dfc_still_requires_duplex_proof_when_test_mode_is_off(self):
        self.config.update(duplex_verified=False, allow_unverified_printing=False)
        self.client.job = job("dfc")
        with self.assertRaisesRegex(station.StationError, "DFC page order"):
            self.station.poll_once()
        self.assertEqual(self.cups.submissions, [])
        self.assertFalse(any(event["state"] == "submitting" for event in self.client.events))

    def test_explicit_test_mode_submits_fronts_without_marking_recipe_verified(self):
        self.config.update(recipe_verified=False, duplex_verified=False)
        fingerprint = station.recipe_fingerprint(self.config)
        self.config["allow_unverified_printing"] = True
        with mock.patch.object(self.cups, "doctor", wraps=self.cups.doctor) as doctor:
            self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
            doctor.assert_called_once()
        self.assertEqual(self.cups.submissions[0][:2], ("ordinary", "fronts"))
        self.assertFalse(self.config["recipe_verified"])
        self.assertFalse(self.config["duplex_verified"])
        self.assertEqual(station.recipe_fingerprint(self.config), fingerprint)

    def test_test_mode_still_respects_pause_management_connection_and_native_printer_checks(self):
        self.config.update(recipe_verified=False, duplex_verified=False, allow_unverified_printing=True)
        self.station.ledger.write("INSERT OR REPLACE INTO settings VALUES('paused','1')")
        self.assertEqual(self.station.poll_once(), "paused")
        self.assertEqual(self.client.claims, 0)
        self.station.ledger.write("UPDATE settings SET value='0' WHERE key='paused'")
        self.assertIn("connection", self.station.poll_once(allow_submit=False))
        self.assertEqual(self.client.claims, 0)
        with mock.patch.object(self.cups, "doctor", side_effect=station.StationError("Printer unavailable")):
            with self.assertRaisesRegex(station.StationError, "Printer unavailable"):
                self.station.poll_once()
        self.assertEqual(self.cups.submissions, [])
        self.assertFalse(any(event["state"] == "submitting" for event in self.client.events))

    def test_test_mode_dfc_requires_matching_manual_refeed_after_restart_and_never_reprints(self):
        self.config.update(recipe_verified=False, duplex_verified=False, allow_unverified_printing=True)
        self.client.job = packet_job(1)
        self.client.job["artifacts"] = self.client.job["artifacts"][1:]
        self.client.job["steps"] = self.client.job["steps"][1:]
        self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
        self.station.poll_once()  # A processing front page cannot enable the back pass.
        self.assertEqual(len(self.cups.submissions), 1)
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "awaiting_refeed")
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.assertEqual(self.station.poll_once(), "awaiting_refeed")
        self.assertEqual(len(self.cups.submissions), 1)
        self.station.resume("job1")
        self.assertEqual(self.station.poll_once(), "submitted EPSON-2")
        self.assertEqual([entry[:2] for entry in self.cups.submissions], [
            ("double-faced-001", "fronts"), ("double-faced-001", "backs")])
        self.assertTrue(self.client.job["steps"][1]["refeedConfirmed"])
        self.cups.history[1]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "completed")
        self.station.poll_once()  # A replayed claim remains a completed tombstone.
        self.assertEqual(len(self.cups.submissions), 2)
        self.assertFalse(self.config["recipe_verified"])
        self.assertFalse(self.config["duplex_verified"])

    def test_test_mode_recovers_uncertain_submission_without_sending_another_copy(self):
        self.config.update(recipe_verified=False, duplex_verified=False, allow_unverified_printing=True)
        self.cups.after_accept_error = True
        self.assertEqual(self.station.poll_once(), "uncertain")
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.assertEqual(self.station.poll_once(), "reconciled")
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "submitted")

    def test_intent_and_server_boundary_are_durable_before_lp(self):
        def boundary():
            ledger = station.Ledger(self.config["state_dir"])
            try:
                self.assertEqual(ledger.passes("job1")[0]["state"], "intent")
                self.assertEqual(ledger.passes("job1")[0]["cups_started"], 1)
                self.assertEqual(self.client.job["steps"][0]["state"], "submitting")
            finally:
                ledger.db.close()
        self.cups.before_submit = boundary
        self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
        self.assertEqual(self.station.ledger.passes("job1")[0]["spooler_id"], "EPSON-1")

    def test_restart_after_lp_timeout_reconciles_title_without_resubmitting(self):
        self.cups.after_accept_error = True
        self.assertEqual(self.station.poll_once(), "uncertain")
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "submitted")
        self.assertTrue(any(event["state"] == "reconciled" for event in self.client.events))

    def test_unknown_history_never_auto_retries_or_claims_another_job(self):
        self.client.fail_state = "submitting"
        self.assertEqual(self.station.poll_once(), "uncertain")
        for _ in range(3):
            self.station.poll_once()
        self.assertEqual(self.cups.submissions, [])
        self.assertEqual(self.client.claims, 1)
        self.assertEqual(self.station.ledger.current()["state"], "uncertain")

    def test_admin_cancel_at_authorization_boundary_retires_without_spooling_and_allows_next_job(self):
        original_report = self.client.report
        def cancel_before_authorization(value, event):
            if event["state"] == "submitting":
                self.client.job["state"] = "canceled"
            return original_report(value, event)
        with mock.patch.object(self.client, "report", side_effect=cancel_before_authorization):
            self.assertEqual(self.station.poll_once(), "canceled before submission")
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(self.cups.submissions, [])
        self.assertTrue(all(step["state"] == "pending" for step in self.client.job["steps"]))
        self.assertEqual(self.station.ledger.passes("job1")[0]["cups_started"], 0)
        self.client.job = job(job_id="job2")
        self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_canceled_pre_cups_intent_survives_process_exit_before_response(self):
        original_report = self.client.report
        def cancel_and_exit(value, event):
            if event["state"] == "submitting":
                self.client.job["state"] = "canceled"
                raise KeyboardInterrupt("process stopped before reading cancellation")
            return original_report(value, event)
        with mock.patch.object(self.client, "report", side_effect=cancel_and_exit):
            with self.assertRaises(KeyboardInterrupt):
                self.station.poll_once()
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "intent")
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.assertEqual(self.station.poll_once(), "canceled before submission")
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(self.cups.submissions, [])

    def test_cancellation_requires_successful_lookup_but_can_recover_after_restart(self):
        original_report, original_get = self.client.report, self.client.get_job
        def cancel_before_authorization(value, event):
            if event["state"] == "submitting":
                self.client.job["state"] = "canceled"
            return original_report(value, event)
        def unavailable_after_cancellation(identifier):
            if self.client.job["state"] == "canceled":
                raise station.StationError("CLC connection failed")
            return original_get(identifier)
        with mock.patch.object(self.client, "report", side_effect=cancel_before_authorization), \
                mock.patch.object(self.client, "get_job", side_effect=unavailable_after_cancellation):
            self.assertEqual(self.station.poll_once(), "uncertain")
        self.assertIsNotNone(self.station.ledger.current())
        self.station.ledger.db.close()
        self.station = station.Station(self.config, self.client, self.cups)
        self.assertEqual(self.station.poll_once(), "canceled before submission")
        self.assertEqual(self.cups.submissions, [])

    def test_cancellation_cannot_retire_mismatched_partial_or_legacy_uncertain_state(self):
        self.client.job = job("dfc")
        self.station.adopt(copy.deepcopy(self.client.job))
        self.station.ledger.set_pass(self.station.ledger.passes("job1")[0], "intent")
        canceled = {**copy.deepcopy(self.client.job), "state": "canceled"}
        bad_replies = [
            {**canceled, "manifestSha256": "b" * 64}, {**canceled, "id": "another"},
            {**canceled, "claimToken": "another-claim-token"}, {**canceled, "state": "claimed"},
            {**canceled, "steps": []}, {**canceled, "steps": [canceled["steps"][0]] * 2},
            {**canceled, "steps": [{**step, "state": "submitting"} for step in canceled["steps"]]},
            {**canceled, "steps": [{**step, "spoolerId": "EPSON-1"} for step in canceled["steps"]]},
        ]
        for bad in bad_replies:
            with self.subTest(reply=bad):
                self.assertFalse(self.station.retire_canceled_before_cups(self.client.job, bad))
                self.assertIsNotNone(self.station.ledger.current())
        self.station.ledger.write("UPDATE passes SET cups_started=NULL WHERE job_id='job1'")
        self.assertFalse(self.station.retire_canceled_before_cups(self.client.job, canceled))
        self.assertIsNotNone(self.station.ledger.current())

    def test_cancel_report_cannot_erase_a_possible_cups_attempt_without_spooler_id(self):
        self.cups.after_accept_error = True
        self.assertEqual(self.station.poll_once(), "uncertain")
        self.cups.history = []
        # Even an inconsistent canceled response is not proof once lp was called.
        self.client.job["state"] = "canceled"
        for step in self.client.job["steps"]:
            step["state"] = "pending"
            step.pop("spoolerId", None)
        self.assertEqual(self.station.poll_once(), "paper clearance required")
        self.assertEqual(self.station.ledger.passes("job1")[0]["cups_started"], 1)
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertEqual(self.client.claims, 1)

    def test_successful_authorization_receipt_still_blocks_retirement_after_older_bundle_use(self):
        original = copy.deepcopy(self.client.job)
        self.station.adopt(original)
        entry = self.station.ledger.passes("job1")[0]
        self.station.ledger.set_pass(entry, "intent")
        self.station.report(original, entry, "submitting")
        canceled = {**original, "state": "canceled"}
        self.assertFalse(self.station.retire_canceled_before_cups(original, canceled))
        self.assertIsNotNone(self.station.ledger.current())
        self.assertEqual(self.cups.submissions, [])

    def test_legacy_ledger_migration_leaves_old_cups_boundary_unknown(self):
        directory = self.directory / "legacy"
        directory.mkdir(mode=0o700)
        db = station.sqlite3.connect(str(directory / "station.sqlite3"))
        db.execute("CREATE TABLE passes (job_id TEXT,artifact_id TEXT,phase TEXT,state TEXT,title TEXT,spooler_id TEXT,detail TEXT,resume_requested INTEGER DEFAULT 0)")
        db.execute("INSERT INTO passes(job_id,artifact_id,phase,state,title) VALUES('old','ordinary','fronts','uncertain','CLC-old')")
        db.commit()
        db.close()
        legacy = station.Ledger(directory)
        try:
            self.assertIsNone(legacy.passes("old")[0]["cups_started"])
        finally:
            legacy.db.close()

    def test_replayed_submission_authorization_does_not_spool(self):
        self.client.replay_submitting = True
        self.assertEqual(self.station.poll_once(), "uncertain")
        self.assertEqual(self.cups.submissions, [])

    def test_network_loss_after_spooler_ack_retries_same_event_only(self):
        self.client.fail_state = "submitted"
        with self.assertRaises(station.StationError):
            self.station.poll_once()
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 1)
        events = [event for event in self.client.events if event["state"] == "submitted"]
        self.assertEqual(len({event["eventId"] for event in events}), 1)

    def test_reconciliation_response_loss_preserves_recovery_state(self):
        self.cups.after_accept_error = True
        self.station.poll_once()
        self.client.fail_state = "reconciled"
        with self.assertRaises(station.StationError):
            self.station.poll_once()
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "uncertain")
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 1)
        events = [event for event in self.client.events if event["state"] == "reconciled"]
        self.assertEqual(len({event["eventId"] for event in events}), 1)

    def test_completed_history_is_required_absence_does_not_mean_printed(self):
        self.station.poll_once()
        self.cups.history = []
        self.station.poll_once()
        self.assertEqual(self.station.ledger.current()["state"], "uncertain")

    def test_successful_spooler_completion_is_reported_once_and_tombstoned(self):
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "completed")
        self.station.poll_once()  # Even a stale claim of the same ID cannot reprint.
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertIsNone(self.station.ledger.current())

    def test_lost_final_completion_ack_recovers_durable_server_completion(self):
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.client.fail_state = "completed"
        with self.assertRaises(station.StationError):
            self.station.poll_once()
        self.cups.history = []  # Durable completion survives expired CUPS history.
        self.assertEqual(self.station.poll_once(), "completed")
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertIsNone(self.station.ledger.current())

    def test_lost_dfc_front_completion_ack_recovers_before_expired_history(self):
        self.client.job = job("dfc")
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.client.fail_state = "completed"
        with self.assertRaises(station.StationError):
            self.station.poll_once()
        self.cups.history = []
        self.assertEqual(self.station.poll_once(), "awaiting_refeed")
        self.assertEqual(self.station.ledger.passes("job1")[0]["state"], "completed")
        self.assertEqual(len(self.cups.submissions), 1)
        self.station.resume("job1")
        self.station.poll_once()
        self.assertEqual([entry[1] for entry in self.cups.submissions], ["fronts", "backs"])

    def test_server_restart_uncertainty_reconciles_known_local_spooler_id(self):
        self.station.poll_once()
        self.client.job["state"] = "uncertain"
        self.client.job["steps"][0]["state"] = "uncertain"
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "completed")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_repeated_uncertainty_cycles_use_new_reconciliation_events(self):
        self.cups.after_accept_error = True
        self.station.poll_once()
        self.station.poll_once()  # Reconcile accepted submission.
        for _ in range(2):
            known = self.cups.history
            self.cups.history = []
            self.station.poll_once()
            self.cups.history = known
            self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "completed")
        self.assertEqual(self.client.job["state"], "completed")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_ambiguous_duplicate_titles_stop_the_station(self):
        self.station.poll_once()
        self.cups.history.append({**self.cups.history[0], "id": "EPSON-42"})
        self.station.poll_once()
        self.assertEqual(self.station.ledger.current()["state"], "uncertain")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_dfc_backs_require_explicit_refeed_and_block_other_claims(self):
        self.client.job = job("dfc")
        self.station.poll_once()
        with self.assertRaises(station.StationError):
            self.station.resume("job1")
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), "awaiting_refeed")
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertEqual(self.client.claims, 1)
        self.station.resume("job1")
        self.station.poll_once()
        self.assertEqual([call[1] for call in self.cups.submissions], ["fronts", "backs"])
        self.assertTrue(any(event["state"] == "refeed" for event in self.client.events))

    def test_numbered_packets_print_one_sheet_then_wait_for_that_sheet_across_restart(self):
        self.client.job = packet_job()
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.config["refeed_notifications"] = True
        self.station.alerts = station.RefeedAlerts(self.station.ledger, self.config, runner=runner)
        expected = [("ordinary", "fronts"), ("double-faced-001", "fronts"), ("double-faced-001", "backs"),
                    ("double-faced-002", "fronts"), ("double-faced-002", "backs")]
        for artifact_id, phase in expected:
            self.assertTrue(self.station.poll_once().startswith("submitted EPSON-"))
            self.assertEqual(self.cups.submissions[-1][:2], (artifact_id, phase))
            if phase == "fronts" and artifact_id.startswith("double-faced"):
                prior = runner.call_count
                self.station.poll_once()  # CUPS still processing: no flip request yet.
                self.assertEqual(runner.call_count, prior)
            self.cups.history[-1]["state"] = 9
            self.station.poll_once()
            if phase == "fronts" and artifact_id.startswith("double-faced"):
                self.assertEqual(self.station.poll_once(), "awaiting_refeed")
                self.assertEqual(self.station.ledger.current()["state"], "awaiting_refeed")
                submitted = len(self.cups.submissions)
                self.station.ledger.db.close()
                self.station = station.Station(self.config, self.client, self.cups)
                self.station.alerts = station.RefeedAlerts(self.station.ledger, self.config, runner=runner)
                self.assertEqual(self.station.poll_once(), "awaiting_refeed")
                self.assertEqual(len(self.cups.submissions), submitted)
                self.assertEqual(runner.call_count, int(artifact_id[-3:]))
                self.assertEqual(self.client.claims, 1)
                self.station.resume("job1")
        self.assertEqual(self.station.poll_once(), "completed")
        self.assertEqual([entry[:2] for entry in self.cups.submissions], expected)
        self.assertEqual(runner.call_count, 2)

    def test_durable_front_attention_survives_pause_and_management_disconnect(self):
        self.client.job = job("dfc")
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.config["refeed_notifications"] = True
        self.station.alerts = station.RefeedAlerts(self.station.ledger, self.config, runner=runner)
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.station.ledger.write("INSERT OR REPLACE INTO settings(key,value) VALUES('paused','1')")
        with mock.patch.object(self.client, "get_job", side_effect=station.StationError("offline")):
            with self.assertRaises(station.StationError):
                self.station.poll_once(allow_submit=False)
        self.assertEqual(self.station.ledger.current()["state"], "awaiting_refeed")
        self.assertEqual(runner.call_count, 1)
        self.assertEqual(self.station.poll_once(allow_submit=False), "awaiting_refeed")
        self.station.resume("job1")
        self.assertEqual(self.station.poll_once(), "paused")
        self.assertEqual(len(self.cups.submissions), 1)

    def test_maximum_packet_job_and_corrupt_packet_identity(self):
        value = packet_job(42)
        self.assertEqual(len(station.checked_job(value, self.config)["artifacts"]), 43)
        for changes in [{"packetIndex": 2}, {"packetCount": 35}, {"sheetCount": 2}, {"cardCount": 8}, {"label": "bad\nlabel"}]:
            bad = copy.deepcopy(value)
            bad["artifacts"][1].update(changes)
            with self.assertRaisesRegex(station.StationError, "packet"):
                station.checked_job(bad, self.config)
        with self.assertRaisesRegex(station.StationError, "43"):
            station.checked_job(packet_job(43), self.config)

    def test_mixed_packing_requires_exact_packet_counts_and_manual_back_steps(self):
        for value in (mixed_job(), mixed_job(False)):
            self.assertIs(station.checked_job(value, self.config), value)
        exact_fill = mixed_job()
        exact_fill["artifacts"][1]["doubleFacedCardCount"] = 7
        self.assertIs(station.checked_job(exact_fill, self.config), exact_fill)
        for label, tamper in {
            "unknown packing": lambda value: value.update(sheetPacking="different-packing"),
            "legacy workflow": lambda value: value.pop("workflow"),
            "legacy marker": lambda value: value.pop("sheetPacking"),
            "packet order": lambda value: value["artifacts"].insert(0, value["artifacts"].pop()),
            "missing count": lambda value: value["artifacts"][1].pop("doubleFacedCardCount"),
            "too many backs": lambda value: value["artifacts"][1].update(doubleFacedCardCount=8),
            "boolean count": lambda value: value["artifacts"][1].update(doubleFacedCardCount=True),
            "padding before the last packet": lambda value: value["artifacts"][0].update(doubleFacedCardCount=2),
            "ordinary has backs": lambda value: value["artifacts"][-1].update(doubleFacedCardCount=1),
            "step order": lambda value: value["steps"].reverse(),
            "manual refeed": lambda value: value["steps"][-1].pop("requiresRefeed"),
            "early refeed": lambda value: value.update(backRequest={"id": "early", "artifactId": "double-faced-001"}),
            "total": lambda value: value.update(totalCopies=13),
        }.items():
            with self.subTest(label=label), self.assertRaises(station.StationError):
                value = mixed_job()
                tamper(value)
                station.checked_job(value, self.config)

    def test_mixed_saved_identity_pins_packing_and_artifact_metadata(self):
        original = mixed_job()
        self.station.adopt(original)
        for changes in (lambda value: value.pop("sheetPacking"),
                        lambda value: value["artifacts"][1].update(doubleFacedCardCount=3)):
            with self.subTest(changes=changes):
                current = copy.deepcopy(original)
                changes(current)
                self.client.job = current
                with self.assertRaisesRegex(station.StationError, "identity changed"):
                    self.station.refresh_job(original)
        self.assertEqual(self.cups.submissions, [])

    def test_canceled_cups_job_requires_paper_clearance_not_automatic_next_job(self):
        self.station.poll_once()
        self.cups.history[0]["state"] = 7
        self.station.poll_once()
        self.assertEqual(self.station.ledger.current()["state"], "uncertain")
        self.assertEqual(self.station.poll_once(), "paper clearance required")
        self.assertEqual(self.client.claims, 1)
        self.station.release("job1", True)
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(self.client.job["state"], "failed")

    def test_missing_cancellation_history_requires_exact_explicit_clearance(self):
        self.client.job = job("dfc")
        self.client.job.update(workflow=station.DEFERRED_WORKFLOW, backRequest=None)
        self.assertEqual(self.station.poll_once(), "submitted EPSON-1")
        submission = copy.deepcopy(self.client.events[-1])
        original = self.cups.history.pop()
        request_id = "f3042e49-3395-47e4-9f39-04350b101e41"
        self.client.job.update(cancelRequested="all", cancelRequestId=request_id)
        boundary = "cancel:" + request_id
        with self.assertRaisesRegex(station.StationError, "exact CUPS cancellation"):
            self.station.poll_once()
        self.assertEqual(self.station.ledger.current()["state"], "awaiting_clearance")
        with self.assertRaisesRegex(station.StationError, "exact CUPS cancellation"):
            self.station.clear_paper("job1", boundary)
        with self.assertRaises(station.StationError):
            self.station.release("job1", True)

        self.assertEqual(self.station.missing_cancellation_spooler(self.client.job), "EPSON-1")
        with mock.patch.object(self.cups, "jobs", side_effect=station.StationError("CUPS unavailable")):
            with self.assertRaisesRegex(station.StationError, "CUPS unavailable"):
                self.station.clear_paper("job1", boundary, missing_spooler_id="EPSON-1", command_id="command123")
        for collision in (original, {**original, "id": "EPSON-2"}, {**original, "title": "Different title"}):
            self.cups.history = [collision]
            with self.assertRaises(station.StationError):
                self.station.clear_paper("job1", boundary, missing_spooler_id="EPSON-1", command_id="command123")
        self.cups.history = []
        with self.assertRaises(station.StationError):
            self.station.clear_paper("job1", boundary, missing_spooler_id="EPSON-2", command_id="command123")
        self.station.clear_paper("job1", boundary, missing_spooler_id="EPSON-1", command_id="command123")
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(len(self.cups.submissions), 1)
        front, back = self.station.ledger.passes("job1")
        self.assertEqual((front["state"], front["spooler_id"], back["state"], back["cups_started"]),
                         ("canceled", "EPSON-1", "canceled", 0))
        self.assertIn(submission, self.client.events)
        self.assertEqual(self.client.events[-1]["missingCupsHistory"], True)
        self.assertEqual(self.client.events[-1]["clearanceId"], boundary)

    def test_canceled_ambiguous_submission_can_be_abandoned_only_after_clearance(self):
        self.cups.after_accept_error = True
        self.station.poll_once()
        self.cups.history[0]["state"] = 8
        self.station.poll_once()
        self.assertEqual(self.client.job["state"], "uncertain")
        with self.assertRaises(station.StationError):
            self.station.release("job1", False)
        self.station.release("job1", True)
        self.assertEqual(self.client.events[-1]["resolution"], "abandoned")
        self.assertIs(self.client.events[-1]["paperCleared"], True)
        self.assertEqual(self.client.job["state"], "failed")
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(len(self.cups.submissions), 1)

    def test_release_rejected_submission_with_no_server_intent(self):
        self.station.adopt(copy.deepcopy(self.client.job))
        entry = self.station.ledger.passes("job1")[0]
        self.station.ledger.set_pass(entry, "uncertain")
        self.station.ledger.set_job("job1", "uncertain")
        self.station.release("job1", True)
        self.assertEqual(self.client.events[-1]["state"], "failed")
        self.assertEqual(self.client.job["state"], "failed")
        self.assertEqual(self.cups.submissions, [])

    def test_release_pending_back_pass_also_clears_earlier_physical_output_hold(self):
        self.client.job = job("dfc")
        self.station.poll_once()
        self.cups.history[0]["state"] = 9
        self.station.poll_once()
        self.station.poll_once()
        self.station.ledger.set_job("job1", "uncertain", "Back-pass authorization was rejected")
        self.station.release("job1", True)
        self.assertEqual(self.client.events[-2]["state"], "failed")
        self.assertEqual(self.client.events[-1]["resolution"], "abandoned")
        self.assertEqual(self.client.job["state"], "failed")
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(len(self.cups.submissions), 1)

    def test_release_retries_after_abandon_ack_loss_without_resubmitting(self):
        self.client.fail_state = "submitting"
        self.station.poll_once()
        self.client.fail_state = "reconciled"
        with self.assertRaises(station.StationError):
            self.station.release("job1", True)
        self.assertIsNotNone(self.station.ledger.current())
        self.station.release("job1", True)
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(self.cups.submissions, [])

    def test_changed_local_options_do_not_change_an_inflight_recipe(self):
        self.station.poll_once()
        self.config["driver_options"]["MediaType"] = "Plain"
        with self.assertRaisesRegex(station.StationError, "changed during"):
            self.station.poll_once()

    def test_fixed_orientation_change_blocks_an_already_adopted_job(self):
        self.station.adopt(copy.deepcopy(self.client.job))
        with mock.patch.dict(station.FIXED_OPTIONS, {"orientation-requested": "3"}):
            with self.assertRaisesRegex(station.StationError, "changed during"):
                self.station.poll_once()
        self.assertEqual(self.cups.submissions, [])

    def test_worker_lock_serializes_processes(self):
        other = station.Ledger(self.config["state_dir"])
        try:
            with self.station.ledger.worker_lock():
                with self.assertRaisesRegex(station.StationError, "already running"):
                    with other.worker_lock():
                        self.fail("Second worker entered lock")
        finally:
            other.db.close()

    def test_dry_run_does_not_claim_download_or_submit(self):
        with mock.patch.object(station.Client, "claim", side_effect=AssertionError("must not claim")), \
                mock.patch.object(station.Cups, "submit", side_effect=AssertionError("must not spool")):
            result = station.dry_run(self.config, job("dfc"))
        self.assertEqual(result["claimed_jobs"], 0)
        self.assertEqual(result["spooler_submissions"], 0)
        self.assertTrue(result["commands"][1]["requires_operator_refeed"])

    def test_mixed_dry_run_shows_front_order_before_manual_backs(self):
        result = station.dry_run(self.config, mixed_job())
        self.assertEqual([(entry["artifact"], entry["phase"]) for entry in result["commands"]], [
            ("double-faced-001", "fronts"), ("double-faced-002", "fronts"), ("fronts", "fronts"),
            ("double-faced-001", "backs"), ("double-faced-002", "backs"),
        ])


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.config = config(self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def test_claim_advertises_packet_capacity_before_server_assigns_work(self):
        opener = mock.Mock()
        opener.open.return_value = Response(b'{"job": null}')
        self.assertIsNone(station.Client(self.config, opener).claim())
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, self.config["server_url"] + "/api/print-station/claim")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {"maxArtifacts": 43, "deferredBacks": True, "printRecovery": True,
                                                   "mixedPrintSheets": True,
                                                   "loadedPaperSize": "letter", "supportedRecipeIds": [station.LETTER_RECIPE]})

    def test_checksums_stream_and_promote_download_atomically(self):
        opener = mock.Mock()
        opener.open.return_value = Response(PDF)
        target = self.directory / "deck.pdf"
        client = station.Client(self.config, opener)
        client.download(job()["artifacts"][0], target)
        self.assertEqual(target.read_bytes(), PDF)
        self.assertEqual(list(self.directory.iterdir()), [target])
        request = opener.open.call_args[0][0]
        self.assertEqual(request.full_url, "https://clc.test/api/print-station/jobs/job1/artifacts/ordinary")
        self.assertTrue(request.headers["Authorization"].startswith("Bearer "))

    def test_wrong_checksum_and_oversized_download_leave_no_pdf_or_temp(self):
        for body in (PDF.replace(b"fixture", b"corrupt"), PDF + b"extra"):
            opener = mock.Mock()
            opener.open.return_value = Response(body)
            with self.assertRaises(station.StationError):
                station.Client(self.config, opener).download(job()["artifacts"][0], self.directory / "deck.pdf")
            self.assertEqual(list(self.directory.iterdir()), [])

    def test_credentials_never_follow_off_origin_artifact_urls_or_redirects(self):
        client = station.Client(self.config)
        for url in ("https://other.test/file.pdf", "//other.test/file.pdf", "file:///etc/passwd"):
            with self.assertRaises(station.StationError):
                client.url(url)
        with self.assertRaises(station.StationError):
            station.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test")

    def test_bad_page_pairs_and_oversized_artifacts_are_rejected_before_print(self):
        value = job("dfc")
        value["artifacts"][0]["backPages"] = [1, 3]
        with self.assertRaises(station.StationError):
            station.checked_job(value, self.config)
        value = job()
        value["artifacts"][0]["size"] = self.config["max_pdf_bytes"] + 1
        with self.assertRaises(station.StationError):
            station.checked_job(value, self.config)

    def test_cups_command_uses_local_options_single_copy_and_explicit_page_range(self):
        artifact = job("dfc")["artifacts"][0]
        artifact["options"] = {"copies": "999", "media": "A3"}  # ignored untrusted server data
        args = station.Cups(self.config).args(artifact, "backs", "CLC-safe", self.directory / "a file.pdf")
        self.assertEqual(args[0:3], ["/usr/bin/lp", "-h", "/private/var/run/cupsd"])
        self.assertEqual(args[args.index("-n") + 1], "1")
        self.assertEqual(args[args.index("-P") + 1], "2,4")
        self.assertIn("sides=one-sided", args)
        self.assertIn("outputorder=normal", args)
        self.assertNotIn("media=A3", args)
        self.assertEqual(args[-1], str(self.directory / "a file.pdf"))

    def test_every_print_pass_uses_explicit_landscape_actual_size_and_one_copy(self):
        for kind, phase in (("ordinary", "fronts"), ("dfc", "fronts"), ("dfc", "backs")):
            with self.subTest(kind=kind, phase=phase):
                artifact = job(kind)["artifacts"][0]
                # Even a direct API caller bypassing load_config cannot replace
                # the fixed orientation with a conflicting driver value.
                config = {**self.config, "driver_options": {**self.config["driver_options"], "orientation-requested": "3"}}
                args = station.Cups(config).args(artifact, phase, "CLC-proof", self.directory / "page.pdf")
                self.assertEqual(args.count("orientation-requested=4"), 1)
                self.assertNotIn("orientation-requested=3", args)
                self.assertFalse(any(item.lower() == "landscape" or item.lower().startswith("landscape=") for item in args))
                self.assertEqual(args.count("-n"), 1)
                self.assertEqual(args[args.index("-n") + 1], "1")
                self.assertIn("media=Letter", args)
                self.assertIn("number-up=1", args)
                self.assertIn("print-scaling=none", args)
                self.assertIn("fit-to-page=false", args)
                self.assertIn("sides=one-sided", args)

    def test_a4_batch_preserves_legacy_letter_settings_and_overrides_both_media_options(self):
        config = {**self.config, "loaded_paper_size": "a4",
                  "a4_enabled": True,
                  "driver_options": {"MediaType": "Glossy", "PageSize": "Letter", "EPIJ_Size": "4"}}
        old_config = {key: value for key, value in config.items() if key != "loaded_paper_size"}
        legacy_hash = station.recipe_fingerprint(old_config)
        self.assertEqual(station.recipe_fingerprint(config, station.LETTER_RECIPE), legacy_hash)
        self.assertNotEqual(station.recipe_fingerprint(config, station.A4_RECIPE), legacy_hash)
        self.assertEqual(station.recipe_fingerprint(config, station.A4_RECIPE),
                         station.recipe_fingerprint(old_config, station.A4_RECIPE))

        value = job("dfc")
        value["recipeId"] = station.A4_RECIPE
        desired = station.dry_run(config, value)
        self.assertEqual([entry["phase"] for entry in desired["commands"]], ["fronts", "backs"])
        for entry, wanted in zip(desired["commands"], ["1,3", "2,4"]):
            args = entry["argv"]
            self.assertEqual(args[args.index("-P") + 1], wanted)
            self.assertIn("media=A4", args)
            self.assertIn("PageSize=A4", args)
            self.assertIn("EPIJ_Size=1", args)
            self.assertIn("print-scaling=none", args)
            self.assertNotIn("PageSize=Letter", args)
            self.assertNotIn("EPIJ_Size=4", args)
        for entry in station.dry_run(config, job("dfc"))["commands"]:
            self.assertIn("media=Letter", entry["argv"])
            self.assertIn("PageSize=Letter", entry["argv"])
            self.assertIn("EPIJ_Size=4", entry["argv"])

    def test_native_submit_blocks_wrong_stock_before_calling_cups(self):
        runner = mock.Mock(return_value="request id is EPSON-42 (1 file(s))")
        cups = station.Cups(self.config, runner)
        artifact = job()["artifacts"][0]
        with self.assertRaisesRegex(station.StationError, "requires A4"):
            cups.submit(artifact, "fronts", "CLC-safe", self.directory / "page.pdf", station.A4_RECIPE)
        runner.assert_not_called()
        self.config["loaded_paper_size"] = "a4"
        with self.assertRaisesRegex(station.StationError, "requires US Letter"):
            cups.submit(artifact, "fronts", "CLC-safe", self.directory / "page.pdf", station.LETTER_RECIPE)
        runner.assert_not_called()

    def test_crowned_profile_sets_portrait_rear_feed_and_thick_paper_on_both_faces(self):
        self.config.update(crowned_a4_enabled=True, loaded_paper_size="a4", loaded_print_preset="crowned-a4")
        self.config["driver_options"].update(PageSize="Letter", EPIJ_Size="4", EPIJ_FdSo="2",
                                             EPIJ_PGEx="0", EPIJ_PSrc="3", EPIJ_RmMg="1", EPIJ_DbSidBin="1")
        value = packet_job(1)
        value.update(recipeId=station.CROWNED_RECIPE, printPreset=station.CROWNED_PRESET, paperSize="a4")
        value["artifacts"][1]["cardCount"] = 9
        result = station.dry_run(self.config, value)
        self.assertEqual([entry["phase"] for entry in result["commands"]], ["fronts", "fronts", "backs"])
        for entry in result["commands"]:
            args = entry["argv"]
            for option in ("media=A4", "PageSize=A4", "EPIJ_Size=1", "EPIJ_FdSo=0", "EPIJ_PGEx=1",
                           "EPIJ_PSrc=2", "EPIJ_RmMg=0", "EPIJ_DbSidBin=0",
                           "orientation-requested=3", "print-scaling=none", "sides=one-sided"):
                self.assertEqual(args.count(option), 1)
            self.assertNotIn("orientation-requested=4", args)
        ordinary_a4 = {**self.config, "a4_enabled": True, "loaded_print_preset": None}
        self.assertEqual(station.recipe_fingerprint(ordinary_a4, station.A4_RECIPE),
                         station.recipe_fingerprint(self.config, station.A4_RECIPE))
        self.assertEqual(station.recipe_fingerprint(ordinary_a4), station.recipe_fingerprint(self.config))
        with self.assertRaisesRegex(station.StationError, "requires Crowned A4"):
            station.Cups(ordinary_a4).submit(value["artifacts"][1], "backs", "CLC-proof",
                                             self.directory / "page.pdf", station.CROWNED_RECIPE)
        value["printPreset"] = None
        with self.assertRaisesRegex(station.StationError, "preset does not match"):
            station.checked_job(value, self.config)

    def test_crowned_landscape_retains_saved_orientation_and_disables_bidirectional_on_both_passes(self):
        self.config.update(crowned_a4_enabled=True, crowned_a4_landscape_enabled=True, loaded_paper_size="a4",
                           loaded_print_preset=station.CROWNED_LANDSCAPE_PRESET)
        self.config["driver_options"].update(EPIJ_OPT_Bi_D="1", epij_opt_bi_d="1", EPIJ_PGEx="0")
        self.assertEqual(station.loaded_recipe(self.config), station.CROWNED_LANDSCAPE_RECIPE)
        original = station.recipe_fingerprint(self.config, station.CROWNED_RECIPE)
        value = mixed_job()
        value.update(printPreset=station.CROWNED_LANDSCAPE_PRESET, paperSize="a4")
        value["artifacts"][0].update(cardCount=8, doubleFacedCardCount=8)
        value["artifacts"][1]["cardCount"] = 8
        value["totalCopies"] = 17
        for recipe, orientation in ((station.CROWNED_LANDSCAPE_V1_RECIPE, 3), (station.CROWNED_LANDSCAPE_RECIPE, 4)):
            with self.subTest(recipe=recipe):
                value["recipeId"] = recipe
                station.require_loaded_paper(self.config, recipe)
                for entry in station.dry_run(self.config, value)["commands"]:
                    args = entry["argv"]
                    for option in ("media=A4", "PageSize=A4", "EPIJ_PSrc=2", "EPIJ_FdSo=0", "EPIJ_PGEx=1", "EPIJ_RmMg=0",
                                   f"orientation-requested={orientation}", "print-scaling=none", "fit-to-page=false", "sides=one-sided", "EPIJ_OPT_Bi_D=0"):
                        self.assertEqual(args.count(option), 1)
                    self.assertNotIn("EPIJ_OPT_Bi_D=1", args)
                    self.assertNotIn("epij_opt_bi_d=1", args)
        self.assertNotIn("EPIJ_OPT_Bi_D", station.fixed_options(self.config, station.CROWNED_RECIPE))
        old_fingerprint_doc = {key: self.config.get(key) for key in ("queue", "driver_options", "ordinary_output_order",
                                                                    "dfc_front_output_order", "dfc_back_output_order")}
        old_fingerprint_doc["fixed_options"] = {**station.FIXED_OPTIONS, "media": "A4", "orientation-requested": "3",
                                                **station.CROWNED_BIDIRECTIONAL_OFF_OPTIONS}
        old_hash = hashlib.sha256(json.dumps(old_fingerprint_doc, sort_keys=True).encode()).hexdigest()
        self.assertEqual(station.recipe_fingerprint(self.config, station.CROWNED_LANDSCAPE_V1_RECIPE), old_hash)
        self.assertNotEqual(station.recipe_fingerprint(self.config, station.CROWNED_LANDSCAPE_RECIPE), old_hash)
        self.assertNotEqual(station.recipe_fingerprint(self.config, station.CROWNED_LANDSCAPE_RECIPE), original)
        self.assertEqual(station.recipe_fingerprint({**self.config, "loaded_print_preset": station.CROWNED_PRESET}, station.CROWNED_RECIPE), original)
        value["artifacts"][0].update(cardCount=9, doubleFacedCardCount=9)
        for recipe in (station.CROWNED_LANDSCAPE_V1_RECIPE, station.CROWNED_LANDSCAPE_RECIPE):
            value["recipeId"] = recipe
            with self.assertRaisesRegex(station.StationError, "packet identity or page count"):
                station.checked_job(value, self.config)

    def test_crowned_landscape_requires_independent_local_opt_in(self):
        token = self.directory / "token"
        token.write_text("t" * 40)
        token.chmod(0o600)
        path = self.directory / "config.json"
        path.touch(mode=0o600)
        value = {**self.config, "station_token_file": str(token), "loaded_paper_size": "a4",
                 "loaded_print_preset": station.CROWNED_LANDSCAPE_PRESET, "crowned_a4_enabled": True}
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(station.StationError, "must be locally approved"):
            station.load_config(path)
        value["crowned_a4_landscape_enabled"] = True
        path.write_text(json.dumps(value))
        self.assertEqual(station.loaded_recipe(station.load_config(path)), station.CROWNED_LANDSCAPE_RECIPE)
        value["loaded_paper_size"] = "letter"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(station.StationError, "with A4 paper"):
            station.load_config(path)

    def test_crowned_portrait_six_freezes_the_six_slot_portrait_ticket(self):
        self.config.update(crowned_a4_enabled=True, crowned_a4_portrait_six_enabled=True, loaded_paper_size="a4",
                           loaded_print_preset=station.CROWNED_PORTRAIT_SIX_PRESET)
        recipe = station.CROWNED_PORTRAIT_SIX_RECIPE
        self.assertEqual(station.loaded_recipe(self.config), recipe)
        self.assertEqual(station.fixed_options(self.config, recipe), {
            **station.fixed_options(self.config, station.CROWNED_RECIPE), "EPIJ_OPT_Bi_D": "0",
        })
        value = packet_job(42)
        value.update(recipeId=recipe, printPreset=station.CROWNED_PORTRAIT_SIX_PRESET, paperSize="a4")
        value["artifacts"][1]["cardCount"] = 6
        for entry in station.dry_run(self.config, value)["commands"]:
            self.assertIn("orientation-requested=3", entry["argv"])
            self.assertIn("EPIJ_OPT_Bi_D=0", entry["argv"])
        value["artifacts"][1]["cardCount"] = 7
        with self.assertRaisesRegex(station.StationError, "packet identity or page count"):
            station.checked_job(value, self.config)
        with self.assertRaisesRegex(station.StationError, "Crowned A4 Portrait 3×3"):
            station.require_loaded_paper(self.config, station.CROWNED_RECIPE)

    def test_job_paper_size_must_match_the_approved_recipe(self):
        self.config["a4_enabled"] = True
        value = job()
        station.checked_job(value, self.config)  # Legacy Letter has no paperSize.
        value["paperSize"] = "a4"
        with self.assertRaisesRegex(station.StationError, "does not match its saved recipe"):
            station.checked_job(value, self.config)
        value["recipeId"] = station.A4_RECIPE
        station.checked_job(value, self.config)
        self.config["a4_enabled"] = False
        with self.assertRaisesRegex(station.StationError, "not locally approved"):
            station.checked_job(value, self.config)

    def test_changed_recipe_cannot_replace_the_saved_batch_identity(self):
        self.config["a4_enabled"] = True
        client, cups = FakeClient(job()), FakeCups()
        worker = station.Station(self.config, client, cups)
        self.addCleanup(worker.ledger.db.close)
        worker.adopt(client.job)
        client.job["recipeId"] = station.A4_RECIPE
        with self.assertRaisesRegex(station.StationError, "identity changed"):
            worker.poll_once()
        self.assertEqual(cups.submissions, [])

    def test_ipptool_job_states_and_titles_are_parsed_without_inferring_absence(self):
        body = {"Tests": [{"Successful": True, "ResponseAttributes": [
            {"attributes-charset": "utf-8"},
            {"job-id": 42, "job-name": "CLC-title", "job-state": 9, "job-printer-uri": "ipp://localhost/printers/EPSON"},
        ]}]}
        self.assertEqual(station.parse_ipp_jobs(plistlib.dumps(body), "EPSON"), [{"id": "EPSON-42", "title": "CLC-title", "state": 9}])
        body["Tests"][0]["Successful"] = False
        with self.assertRaises(station.StationError):
            station.parse_ipp_jobs(plistlib.dumps(body), "EPSON")

    def test_missing_active_spooler_receipt_stays_unknown_and_preserves_ink_reminder(self):
        response = plistlib.dumps({"Tests": [{"Successful": True, "ResponseAttributes": [{
            "printer-state": 4, "printer-is-accepting-jobs": True,
            "printer-state-reasons": ["com.epson.INKCHECKALERT_005-warning"],
            "printer-state-message": "Printing...",
        }]}]})
        runner = mock.Mock(return_value=response)
        cups = station.Cups(self.config, runner)
        cups.jobs = mock.Mock(return_value=[])
        self.assertEqual(cups.status("EPSON-42"), {
            "ok": False, "known": False, "reasons": [],
            "message": "Active print pass is not visible in CUPS; reconcile its receipt in CLC",
            "advisories": ["Regularly check ink levels in the actual ink tanks."],
        })
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(runner.call_args.args[0][0], "/usr/bin/ipptool")
        cups.jobs.assert_called_once_with()

    def test_cups_commands_ignore_shell_destination_and_port_overrides(self):
        with mock.patch.dict(os.environ, {"CUPS_SERVER": "remote.test", "IPP_PORT": "9999", "LPDEST": "remote", "PRINTER": "remote"}), \
                mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "ok", "")) as run:
            station.command(["/usr/bin/lpstat", "-h", station.LOCAL_CUPS_SERVER, "-e"])
        environment = run.call_args.kwargs["env"]
        self.assertTrue({"CUPS_SERVER", "IPP_PORT", "LPDEST", "PRINTER"}.isdisjoint(environment))
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_cancel_and_resume_target_exact_job_through_local_socket(self):
        runner = mock.Mock()
        cups = station.Cups(self.config, runner)
        cups.cancel("EPSON-42")
        cups.resume_held("EPSON-42")
        self.assertEqual(runner.call_args_list, [
            mock.call(["/usr/bin/cancel", "-h", "/private/var/run/cupsd", "EPSON-42"]),
            mock.call(["/usr/bin/lp", "-h", "/private/var/run/cupsd", "-i", "EPSON-42", "-H", "resume"]),
        ])

    def test_doctor_rejects_an_option_not_exposed_by_installed_driver(self):
        def runner(args):
            self.assertEqual(args[0], "/usr/bin/lpstat")
            if "-e" in args:
                return "EPSON\n"
            return "EPSON accepting requests\n"
        with self.assertRaisesRegex(station.StationError, "does not advertise"):
            station.Cups(self.config, runner, ppd_reader=lambda queue: ppd_fixture({"MediaType": "Plain Photo"})).doctor()

    def test_doctor_requires_captured_epson_a4_size_options_before_submission(self):
        self.config.update(loaded_paper_size="a4", driver_options={"PageSize": "Letter", "EPIJ_Size": "4"})
        advertised = {"PageSize": "Letter A4", "EPIJ_Size": "4"}

        def runner(args):
            self.assertEqual(args[0], "/usr/bin/lpstat")
            if "-e" in args:
                return "EPSON\n"
            return "EPSON accepting requests\n"

        cups = station.Cups(self.config, runner, ppd_reader=lambda queue: ppd_fixture(advertised))
        cups.jobs = mock.Mock(return_value=[])
        with self.assertRaisesRegex(station.StationError, "EPIJ_Size=1"):
            cups.doctor()
        cups.jobs.assert_not_called()
        advertised["EPIJ_Size"] = "4 1"
        self.assertEqual(cups.doctor()["fixed_options"]["EPIJ_Size"], "1")

    def test_crowned_doctor_rejects_missing_thick_paper_option(self):
        self.config.update(crowned_a4_enabled=True, loaded_paper_size="a4", loaded_print_preset="crowned-a4",
                           driver_options={})
        def runner(args):
            self.assertEqual(args[0], "/usr/bin/lpstat")
            if "-e" in args:
                return "EPSON\n"
            return "EPSON accepting requests\n"
        advertised = {key: value for key, value in station.CROWNED_DRIVER_OPTIONS.items() if key != "EPIJ_PGEx"}
        # A lone keyword line outside the advertised UI must not count as support.
        cups = station.Cups(self.config, runner,
                            ppd_reader=lambda queue: ppd_fixture(advertised) + b'\n*EPIJ_PGEx 1/Enabled: ""')
        with self.assertRaisesRegex(station.StationError, "Crowned A4 option EPIJ_PGEx=1"):
            cups.doctor()

    def test_crowned_landscape_and_portrait_six_doctor_require_driver_bidirectional_off(self):
        def runner(args):
            self.assertEqual(args[0], "/usr/bin/lpstat")
            if "-e" in args:
                return "EPSON\n"
            return "EPSON accepting requests\n"

        self.config.update(crowned_a4_landscape_enabled=True, crowned_a4_portrait_six_enabled=True,
                           loaded_paper_size="a4", driver_options={})
        for preset in (station.CROWNED_LANDSCAPE_PRESET, station.CROWNED_PORTRAIT_SIX_PRESET):
            with self.subTest(preset=preset):
                self.config["loaded_print_preset"] = preset
                advertised = {**station.CROWNED_DRIVER_OPTIONS, "EPIJ_OPT_Bi_D": "1"}
                cups = station.Cups(self.config, runner, ppd_reader=lambda queue: ppd_fixture(advertised))
                cups.jobs = mock.Mock(return_value=[])
                with self.assertRaisesRegex(station.StationError, "Crowned A4 option EPIJ_OPT_Bi_D=0"):
                    cups.doctor()
                cups.jobs.assert_not_called()
                advertised["EPIJ_OPT_Bi_D"] = "0 1"
                self.assertEqual(cups.doctor()["fixed_options"]["EPIJ_OPT_Bi_D"], "0")

    def test_installed_ppd_reader_rejects_unsafe_or_missing_local_driver(self):
        directory = self.directory / "ppd"
        directory.mkdir(mode=0o755)
        ppd = directory / "EPSON.ppd"
        content = ppd_fixture({"MediaType": "Glossy"})
        fstat = os.fstat

        def owned_by_root(fd):
            info = fstat(fd)
            result = list(info)
            result[4] = 0  # st_uid
            return os.stat_result(result)

        with mock.patch.object(station, "LOCAL_CUPS_PPD_DIR", str(directory)), mock.patch.object(os, "fstat", side_effect=owned_by_root):
            with self.assertRaisesRegex(station.StationError, "Cannot read"):
                station.read_installed_ppd("EPSON")
            target = self.directory / "elsewhere.ppd"
            target.write_bytes(content)
            ppd.symlink_to(target)
            with self.assertRaisesRegex(station.StationError, "Cannot read"):
                station.read_installed_ppd("EPSON")
            ppd.unlink()
            ppd.write_bytes(content)
            ppd.chmod(0o666)
            with self.assertRaisesRegex(station.StationError, "unsafe"):
                station.read_installed_ppd("EPSON")
            ppd.chmod(0o644)
            self.assertEqual(station.read_installed_ppd("EPSON"), content)
        with self.assertRaisesRegex(station.StationError, "Invalid CUPS queue"):
            station.read_installed_ppd("../EPSON")

    def test_token_permissions_and_reserved_options_are_rejected(self):
        token = self.directory / "token"
        token.write_text("t" * 40)
        token.chmod(0o644)
        with self.assertRaises(station.StationError):
            station.private_file(token)
        token.chmod(0o600)
        value = {**self.config, "station_token_file": str(token), "driver_options": {"copies": "10"}}
        path = self.directory / "config.json"
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        with self.assertRaisesRegex(station.StationError, "controls option"):
            station.load_config(path)

    def test_orientation_and_landscape_alias_cannot_override_the_fixed_recipe(self):
        token = self.directory / "token"
        token.write_text("t" * 40)
        token.chmod(0o600)
        path = self.directory / "config.json"
        for key, value in (("orientation-requested", "3"), ("landscape", "false"), ("Landscape", "true")):
            with self.subTest(option=key):
                config = {**self.config, "station_token_file": str(token), "driver_options": {key: value}}
                path.write_text(json.dumps(config))
                path.chmod(0o600)
                with self.assertRaisesRegex(station.StationError, "controls option"):
                    station.load_config(path)

    def test_proof_flags_require_real_booleans_not_truthy_strings(self):
        path = self.directory / "config.json"
        for field in ("allow_http", "recipe_verified", "duplex_verified", "a4_enabled", "a4_recipe_verified",
                      "a4_duplex_verified", "allow_unverified_printing", "refeed_notifications", "refeed_sound"):
            path.write_text(json.dumps({**self.config, field: "false"}))
            path.chmod(0o600)
            with self.assertRaisesRegex(station.StationError, "must be the JSON boolean"):
                station.load_config(path)

    def test_local_test_mode_defaults_false_and_requires_a_json_boolean(self):
        token = self.directory / "token"
        token.write_text("t" * 40)
        token.chmod(0o600)
        path = self.directory / "config.json"
        base = {**self.config, "station_token_file": str(token), "recipe_verified": False, "duplex_verified": False}
        path.write_text(json.dumps(base))
        path.chmod(0o600)
        self.assertIs(station.load_config(path)["allow_unverified_printing"], False)
        for value in (False, True, "true", 1, None, []):
            with self.subTest(value=value):
                path.write_text(json.dumps({**base, "allow_unverified_printing": value}))
                if type(value) is bool:
                    loaded = station.load_config(path)
                    self.assertIs(loaded["allow_unverified_printing"], value)
                    self.assertIs(loaded["recipe_verified"], False)
                    self.assertIs(loaded["duplex_verified"], False)
                else:
                    with self.assertRaisesRegex(station.StationError, "must be the JSON boolean"):
                        station.load_config(path)

    @unittest.skipUnless(Path('/usr/bin/ipptool').is_file() and os.access('/usr/bin/ipptool', os.X_OK),
                         'Native CUPS ipptool is unavailable')
    def test_native_ipptool_contract_against_local_fake_ipp_server(self):
        # This speaks only to a disposable loopback HTTP fixture. It never
        # contacts cupsd or a printer and proves the installed tool's plist shape.
        def attribute(tag, name, value):
            name = name.encode()
            value = value.encode() if isinstance(value, str) else value
            return bytes([tag]) + struct.pack('>H', len(name)) + name + struct.pack('>H', len(value)) + value

        class FakeIpp(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                response = body[:2] + b'\x00\x00' + body[4:8] + b'\x01'
                response += attribute(0x47, 'attributes-charset', 'utf-8')
                response += attribute(0x48, 'attributes-natural-language', 'en') + b'\x02'
                response += attribute(0x21, 'job-id', struct.pack('>i', 42))
                response += attribute(0x42, 'job-name', 'CLC-fixture')
                response += attribute(0x23, 'job-state', struct.pack('>i', 9))
                response += attribute(0x45, 'job-printer-uri', 'ipp://localhost/printers/EPSON') + b'\x03'
                self.send_response(200)
                self.send_header('Content-Type', 'application/ipp')
                self.send_header('Content-Length', str(len(response)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeIpp)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            result = subprocess.run(['/usr/bin/ipptool', '-X', '-L', '-T', '5', '-d', 'clc_user=fixture',
                                     'ipp://127.0.0.1:' + str(server.server_port) + '/printers/EPSON',
                                     str(station.HERE / 'get-jobs.test')], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            document = plistlib.loads(result.stdout)
            self.assertEqual(document['Tests'][0]['RequestAttributes'][0]['requesting-user-name'], 'fixture')
            self.assertEqual(station.parse_ipp_jobs(result.stdout, 'EPSON'), [{'id': 'EPSON-42', 'title': 'CLC-fixture', 'state': 9}])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
