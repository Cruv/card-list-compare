"""Printer interruptions keep immutable PDFs and use explicit, idempotent recovery attempts."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import clc_print_station as native
from clc_station_control import StationControl
from test_print_station import FakeClient, FakeCups, config, job


class RecoveryClient(FakeClient):
    def report(self, value, event):
        if event['state'] != 'recovery':
            return super().report(value, event)
        if event['eventId'] in self.replies:
            return {**copy.deepcopy(self.replies[event['eventId']]), 'replayed': True}
        self.events.append(copy.deepcopy(event))
        step = next(item for item in self.job['steps'] if item['artifactId'] == event['artifactId'] and item['phase'] == event['phase'])
        old = copy.deepcopy(step)
        old['recoveryCommandId'] = event['commandId']
        attempts = old.pop('attempts', [])
        for key in ('spoolerId', 'submittingAt', 'submittedAt', 'completedAt', 'submissionEventId', 'spoolerOutcome'):
            step.pop(key, None)
        step.update(state='pending', attemptId=event['commandId'], pages=event['pages'], attempts=[*attempts, old])
        self.job['state'] = 'claimed'
        reply = {'job': copy.deepcopy(self.job), 'replayed': False}
        self.replies[event['eventId']] = reply
        if self.fail_state == 'recovery':
            self.fail_state = None
            raise native.StationError('acknowledgement lost after recovery accepted')
        return copy.deepcopy(reply)


class RecoveryCups(FakeCups):
    def __init__(self):
        super().__init__()
        self.selected_pages = []
        self.resumed = []
        self.canceled = []

    def submit(self, artifact, phase, title, path):
        self.selected_pages.append(artifact.get('_selected_pages'))
        return super().submit(artifact, phase, title, path)

    def resume_held(self, spooler_id):
        self.resumed.append(spooler_id)
        next(item for item in self.history if item['id'] == spooler_id)['state'] = 3

    def cancel(self, spooler_id):
        self.canceled.append(spooler_id)
        next(item for item in self.history if item['id'] == spooler_id)['state'] = 7


class PrintRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cfg = config(Path(self.temp.name))
        value = job()
        value['artifacts'][0].update(pageCount=4, frontPages=[1, 2, 3, 4])
        self.client, self.cups = RecoveryClient(value), RecoveryCups()
        self.station = native.Station(self.cfg, self.client, self.cups)

    def tearDown(self):
        self.station.ledger.db.close()
        self.temp.cleanup()

    def interrupt(self, state=7):
        self.assertEqual(self.station.poll_once(), 'submitted EPSON-1')
        self.cups.history[0]['state'] = state
        self.station.poll_once()
        return self.station.recovery_summary()

    def request(self, boundary, **extra):
        return {'id': 'recovery-command-12345678', 'jobId': self.client.job['id'],
                'type': 'recover_print', 'paperReady': True,
                **{key: boundary[key] for key in ('recoveryId', 'artifactId', 'phase', 'spoolerId')}, **extra}

    def test_canceled_reverse_pass_keeps_old_receipt_and_only_prints_remaining_sheets(self):
        boundary = self.interrupt()
        self.assertEqual(boundary['physicalPages'], [4, 3, 2, 1])
        self.assertEqual(boundary['mode'], 'reprint_remaining')
        old_title = self.cups.history[0]['title']
        self.station.recover_print(self.request(boundary, firstUnprintedSheet=2))
        self.assertEqual(len(self.cups.submissions), 1, 'Recovery itself never submits a PDF')
        self.assertEqual(self.station.poll_once(), 'submitted EPSON-2')
        self.assertEqual(self.cups.selected_pages, [None, [1, 2, 3]])
        self.assertNotEqual(old_title, self.cups.history[1]['title'])
        old = json.loads(self.station.ledger.db.execute('SELECT receipt FROM pass_attempts').fetchone()[0])
        self.assertEqual(old['spooler_id'], 'EPSON-1')
        self.assertEqual(self.client.job['steps'][0]['attempts'][0]['spoolerId'], 'EPSON-1')
        event = next(event for event in self.client.events if event.get('spoolerId') == 'EPSON-2')
        self.assertEqual(event['attemptId'], 'recovery-command-12345678')
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 2)

    def test_lost_recovery_acknowledgement_reconciles_without_duplicate_submission(self):
        boundary = self.interrupt()
        self.client.fail_state = 'recovery'
        self.station.recover_print(self.request(boundary, firstUnprintedSheet=2))
        self.station.poll_once()
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 2)
        self.assertEqual(len([event for event in self.client.events if event['state'] == 'recovery']), 1)

    def test_recovery_of_recovery_counts_only_current_attempt_and_retains_both_receipts(self):
        first = self.interrupt()
        self.station.recover_print(self.request(first, firstUnprintedSheet=2))
        self.station.poll_once()
        self.cups.history[-1]['state'] = 7
        self.station.poll_once()
        second = self.station.recovery_summary()
        self.assertEqual(second['physicalPages'], [3, 2, 1])
        self.assertEqual(second['attemptId'], 'recovery-command-12345678')
        self.station.recover_print(self.request(second, id='recovery-command-23456789', firstUnprintedSheet=2))
        self.station.poll_once()
        self.assertEqual(self.cups.selected_pages, [None, [1, 2, 3], [1, 2]])
        self.assertEqual(len({item['title'] for item in self.cups.history}), 3)
        saved = self.station.ledger.db.execute('SELECT receipt FROM pass_attempts ORDER BY rowid').fetchall()
        self.assertEqual([json.loads(row[0])['spooler_id'] for row in saved], ['EPSON-1', 'EPSON-2'])
        self.assertEqual([item['spoolerId'] for item in self.client.job['steps'][0]['attempts']], ['EPSON-1', 'EPSON-2'])

    def test_recovery_intent_lost_before_spooler_ack_does_not_duplicate_replacement(self):
        boundary = self.interrupt()
        self.station.recover_print(self.request(boundary, firstUnprintedSheet=2))
        self.cups.after_accept_error = True
        self.assertEqual(self.station.poll_once(), 'uncertain')
        self.assertEqual(len(self.cups.submissions), 2)
        self.station.ledger.db.close()
        self.station = native.Station(self.cfg, self.client, self.cups)
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 2)
        self.assertEqual(self.station.ledger.passes('job1')[0]['spooler_id'], 'EPSON-2')

    def test_crash_after_server_authorization_adopts_same_attempt_once(self):
        boundary = self.interrupt()
        with mock.patch.object(self.station, 'adopt_recovery_attempt', side_effect=SystemExit('crash')):
            with self.assertRaises(SystemExit):
                self.station.recover_print(self.request(boundary, firstUnprintedSheet=3))
        self.station.ledger.db.close()
        self.station = native.Station(self.cfg, self.client, self.cups)
        self.station.poll_once()
        self.assertEqual(self.cups.selected_pages, [None, [1, 2]])
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 2)

    def test_held_pass_resumes_same_cups_id_without_new_attempt(self):
        boundary = self.interrupt(4)
        self.station.recover_print(self.request(boundary))
        self.assertEqual(self.cups.resumed, ['EPSON-1'])
        self.assertEqual(len(self.cups.submissions), 1)
        self.assertIsNone(self.station.ledger.passes('job1')[0]['attempt_id'])

    def test_pending_and_processing_passes_are_retained_without_submission_or_cancel(self):
        for state in (3, 5):
            with self.subTest(state=state):
                if not self.cups.submissions:
                    self.station.poll_once()
                self.cups.history[0]['state'] = state
                self.station.poll_once()
                boundary = self.station.recovery_summary()
                self.station.recover_print(self.request(boundary))
                self.assertEqual(len(self.cups.submissions), 1)
                self.assertEqual(self.cups.canceled, [])

    def test_stopped_pass_ends_only_exact_old_attempt_before_selected_new_range(self):
        boundary = self.interrupt(6)
        self.station.recover_print(self.request(boundary, firstUnprintedSheet=2))
        self.assertEqual(self.cups.canceled, ['EPSON-1'])
        self.station.poll_once()
        self.assertEqual(self.cups.selected_pages[-1], [1, 2, 3])

    def test_bad_checkpoint_stale_identity_or_unresolved_fault_cannot_recover(self):
        boundary = self.interrupt()
        requests = [self.request(boundary), self.request(boundary, firstUnprintedSheet=0),
                    self.request(boundary, firstUnprintedSheet=True), self.request(boundary, firstUnprintedSheet=5),
                    self.request(boundary, firstUnprintedSheet=2, spoolerId='EPSON-999'),
                    self.request(boundary, firstUnprintedSheet=2, recoveryId='recover-stale')]
        for request in requests:
            with self.subTest(request=request), self.assertRaises(native.StationError):
                self.station.recover_print(request)
        self.cups.status = mock.Mock(return_value={'ok': False, 'known': True, 'message': 'Printer needs paper'})
        with self.assertRaises(native.StationError):
            self.station.recover_print(self.request(boundary, firstUnprintedSheet=2))
        self.assertEqual(len(self.cups.submissions), 1)

    def test_active_cups_identity_change_rejects_stale_recovery(self):
        boundary = self.interrupt()
        self.cups.history[0]['state'] = 9
        with self.assertRaises(native.StationError):
            self.station.recover_print(self.request(boundary, firstUnprintedSheet=2))
        self.assertEqual(len(self.cups.submissions), 1)

    def test_paper_out_preflight_leaves_pending_pass_and_printing_enabled(self):
        self.cups.status = mock.Mock(return_value={'ok': False, 'known': True, 'message': 'Printer needs paper'})
        self.assertEqual(self.station.poll_once(), 'waiting for printer attention')
        self.assertEqual(self.station.ledger.passes('job1')[0]['state'], 'pending')
        self.assertFalse(self.station.ledger.paused())
        self.assertEqual(self.cups.submissions, [])
        self.cups.status.return_value = {'ok': True, 'known': True, 'message': 'Ready'}
        self.assertEqual(self.station.poll_once(), 'submitted EPSON-1')

    def test_timeout_override_is_fixed_positive_and_recovery_page_order_is_preserved(self):
        cups = native.Cups(self.cfg)
        artifact = {**self.client.job['artifacts'][0], '_selected_pages': [1, 2, 3]}
        args = cups.args(artifact, 'fronts', 'CLC-proof', Path(self.temp.name) / 'a.pdf')
        self.assertIn('job-cancel-after=2147483647', args)
        self.assertIn('job-error-policy=stop-printer', args)
        self.assertIn('outputorder=reverse', args)
        self.assertEqual(args[args.index('-P') + 1], '1,2,3')
        self.assertNotIn('-H', args)

    def test_remote_artifact_cannot_supply_private_recovery_selection(self):
        value = copy.deepcopy(self.client.job)
        value['artifacts'][0]['_selected_pages'] = [1]
        with self.assertRaisesRegex(native.StationError, 'private recovery'):
            native.checked_job(value, self.cfg)

    def test_control_replay_cannot_repeat_recovery(self):
        boundary = self.interrupt()
        control = StationControl(self.station, '2.56.0', manager=mock.Mock(managed_status=lambda _cfg: {'supported': False}))
        request = {**self.request(boundary, firstUnprintedSheet=2), 'expiresAt': '2099-01-01T00:00:00Z'}
        control.apply(request)
        control.apply(request)
        self.assertEqual(len([event for event in self.client.events if event['state'] == 'recovery']), 1)
        receipt = self.station.ledger.db.execute('SELECT state FROM control_receipts').fetchone()[0]
        self.assertEqual(receipt, 'applied')
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 2)

    def test_control_crash_after_saved_authorization_reports_applied_without_second_attempt(self):
        boundary = self.interrupt()
        manager = mock.Mock(managed_status=lambda _cfg: {'supported': False})
        control = StationControl(self.station, '2.57.0', manager=manager)
        request = {**self.request(boundary, firstUnprintedSheet=2), 'expiresAt': '2099-01-01T00:00:00Z'}
        with mock.patch.object(control, 'finish', side_effect=SystemExit('crash before control receipt')):
            with self.assertRaises(SystemExit):
                control.apply(request)
        StationControl(self.station, '2.57.0', manager=manager)
        self.assertEqual(self.station.ledger.db.execute('SELECT state FROM control_receipts').fetchone()[0], 'applied')
        self.station.poll_once()
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 2)

    def test_backs_require_explicit_matching_front_reload(self):
        self.client.job = job('dfc')
        self.station.poll_once()
        self.cups.history[0]['state'] = 9
        self.station.poll_once()
        self.station.poll_once()
        self.station.resume('job1')
        self.station.poll_once()
        self.cups.history[-1]['state'] = 7
        self.station.poll_once()
        boundary = self.station.recovery_summary()
        self.assertEqual(boundary['phase'], 'backs')
        with self.assertRaises(native.StationError):
            self.station.recover_print(self.request(boundary, firstUnprintedSheet=1))
        self.station.recover_print(self.request(boundary, firstUnprintedSheet=1, paperReloaded=True))
        self.station.poll_once()
        self.assertEqual(self.cups.selected_pages[-1], [2, 4])


if __name__ == '__main__':
    unittest.main()
