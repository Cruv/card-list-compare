"""Movie flavor cannot alter a print receipt or authorize a physical action."""

import copy
import unittest
from unittest import mock

import clc_station_alerts as alerts


class BalboaDialogueTests(unittest.TestCase):
    def setUp(self):
        self.config = {"queue": "EPSON", "server_url": "https://clc.test", "refeed_discord_user_id": "456"}
        self.artifact = {"id": "dfc-1", "kind": "dfc", "frontPages": [1, 3], "backPages": [2, 4],
                         "packetIndex": 1, "packetCount": 2, "label": "CLC batch packet 1/2"}
        self.job = {"id": "12345678-1234-4234-8234-123456789abc", "deckName": "Friday replacements",
                    "totalCopies": 12, "artifacts": [self.artifact]}

    def test_each_mood_spans_six_films_with_short_credited_sourced_excerpts(self):
        self.assertEqual(len({entry["text"] for entry in alerts.BALBOA_DIALOGUE}), 18)
        for mood in set(alerts.BALBOA_EVENTS.values()):
            entries = [entry for entry in alerts.BALBOA_DIALOGUE if mood in entry["moods"]]
            self.assertEqual(len(entries), 6)
            self.assertEqual({entry["film"] for entry in entries}, set(alerts.BALBOA_FILMS))
        for film, (title, source) in alerts.BALBOA_FILMS.items():
            entries = [entry for entry in alerts.BALBOA_DIALOGUE if entry["film"] == film]
            self.assertLessEqual(sum(len(entry["text"]) for entry in entries), 90)
            self.assertTrue(title.startswith("Rocky"))
            self.assertTrue(source.startswith("https://"))
            for entry in entries:
                self.assertIn(entry["speaker"], {"Rocky", "Mickey", "Apollo", "Duke"})
                self.assertNotIn("\n", entry["text"])
                self.assertNotIn("@", entry["text"])

    def test_same_event_identity_is_stable_and_other_batches_cover_the_pool(self):
        for event, mood in alerts.BALBOA_EVENTS.items():
            line = alerts.balboa_line(event, self.job["id"], self.artifact["id"])
            self.assertEqual(line, alerts.balboa_line(event, self.job["id"], self.artifact["id"]))
            variants = {alerts.balboa_line(event, str(index), "packet") for index in range(200)}
            expected = {f'“{entry["text"]}” — {entry["speaker"]}, *{alerts.BALBOA_FILMS[entry["film"]][0]}*'
                        for entry in alerts.BALBOA_DIALOGUE if mood in entry["moods"]}
            self.assertEqual(variants, expected)
            self.assertIn(line, expected)

    def test_batch_rename_does_not_change_its_flavor(self):
        for builder in (alerts.discord_completion_payload, alerts.discord_fronts_payload):
            original = builder(self.job, self.config)["content"].splitlines()[1]
            renamed = builder({**self.job, "deckName": "Renamed @everyone"}, self.config)
            self.assertEqual(renamed["content"].splitlines()[1], original)
        before = alerts.discord_payload(self.job, self.artifact, self.config)["content"].splitlines()[1]
        renamed = alerts.discord_payload({**self.job, "deckName": "Another name"},
                                         {**self.artifact, "label": "Another label"}, self.config)
        self.assertEqual(renamed["content"].splitlines()[1], before)

    def test_variant_builders_do_not_replace_user_labels_or_inherit_wrong_actions(self):
        label = "Print job complete / Paper flip needed / Return blank paper / Packet ID:"
        job = {**self.job, "deckName": label}
        artifact = {**self.artifact, "label": label}
        fronts = alerts.discord_fronts_payload(job, self.config)["content"]
        self.assertIn("Job: " + label, fronts)
        self.assertIn("Matching backs are saved for later", fronts)
        self.assertIn("None right now. Leave blank paper loaded", fronts)
        self.assertNotIn("No paper flip is needed for this job", fronts)
        for builder, event, instruction in (
            (alerts.discord_paper_reset_payload, "paper_reset", "then confirm paper cleared"),
            (alerts.discord_cancel_clearance_payload, "cancel_clearance", "Check that printing has stopped"),
        ):
            payload = builder(job, artifact, self.config)
            self.assertEqual(payload["content"].splitlines()[1], alerts.balboa_line(event, job["id"], artifact["id"]))
            self.assertIn(label, payload["content"].split("**Print details**", 1)[1])
            self.assertIn(instruction, payload["content"])
            self.assertNotIn("Flip only the", payload["content"])

    def test_ordinary_cancellation_preserves_packet_like_user_text_without_inventing_packet(self):
        artifact = {"id": "ordinary", "kind": "ordinary", "sheetCount": 2,
                    "label": "Packet ID: Return blank paper · packet 1/1"}
        payload = alerts.discord_cancel_clearance_payload(self.job, artifact, self.config)
        self.assertNotIn(" · packet", payload["content"].splitlines()[0])
        self.assertIn("Pass artifact: ordinary", payload["content"])
        self.assertIn(artifact["label"], payload["content"])

    def test_every_eligible_excerpt_fits_events_and_preserves_details_mentions_and_inputs(self):
        job = {**self.job, "id": "b" * 96, "deckName": "@everyone **deck** " + "N" * 200}
        artifact = {**self.artifact, "id": "p" * 96, "label": "L" * 180}
        notice = {"jobId": job["id"], "deckName": job["deckName"], "requesterName": "@here " + "R" * 120,
                  "totalCopies": 12, "queuedAt": "2026-10-11T12:00:00.000Z"}
        before = copy.deepcopy((job, artifact, notice, self.config))
        cases = {
            "queued": (lambda: alerts.discord_queued_payload(notice, self.config), False, "does not mean the printer has started"),
            "completed": (lambda: alerts.discord_completion_payload(job, self.config), False, "All print passes completed"),
            "fronts_saved": (lambda: alerts.discord_fronts_payload(job, self.config), False, "Matching backs are saved for later"),
            "flip": (lambda: alerts.discord_payload(job, artifact, self.config), True, "only the 2 printed sheets"),
            "paper_reset": (lambda: alerts.discord_paper_reset_payload(job, artifact, self.config), True, "load blank paper"),
            "cancel_clearance": (lambda: alerts.discord_cancel_clearance_payload(job, artifact, self.config), True, "remove partially printed paper"),
            "fault": (lambda: alerts.printer_discord_payload("CLC: printer needs attention", "Deck", "Printer has a paper jam. Inspect output.", self.config,
                                                             job=job, fault="Printer has a paper jam"), True, "Printer has a paper jam. Inspect output."),
            "monitoring": (lambda: alerts.printer_discord_payload("CLC: print status unavailable", "Deck", "Spooler job: EPSON-42. Completion is not confirmed.", self.config,
                                                                  job=job, fault="Status unavailable", category="monitoring"), True, "Completion is not confirmed"),
            "test": (lambda: alerts.discord_test_payload(self.config), False, "does not print or resume anything"),
        }
        for event, (builder, mention, fact) in cases.items():
            for entry in alerts.BALBOA_DIALOGUE:
                if alerts.BALBOA_EVENTS[event] not in entry["moods"]:
                    continue
                with self.subTest(event=event, film=entry["film"]), mock.patch.object(alerts, "BALBOA_DIALOGUE", (entry,)):
                    payload = builder()
                    self.assertLessEqual(len(payload["content"]), 2000)
                    self.assertIn(fact, payload["content"])
                    self.assertIn("Printer: EPSON", payload["content"])
                    self.assertIn(entry["text"], payload["content"].splitlines()[1])
                    self.assertIn(alerts.BALBOA_FILMS[entry["film"]][0], payload["content"].splitlines()[1])
                    self.assertEqual(payload["allowed_mentions"], {"parse": [], "users": ["456"] if mention else [], "roles": []})
                    self.assertNotIn("@everyone", payload["content"])
                    self.assertNotIn("@here", payload["content"])
                    if event != "test":
                        self.assertIn("Batch ID: " + job["id"], payload["content"])
        self.assertEqual((job, artifact, notice, self.config), before)


if __name__ == "__main__":
    unittest.main()
