"""State-machine tests: saved backs never occupy the physical printer until selected."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import clc_print_station as native
from clc_station_control import StationControl
from test_print_station import FakeClient, FakeCups, config, job, packet_job


class DeferredClient(FakeClient):
    def __init__(self, value):
        super().__init__(value)
        self.values = {value['id']: value}
        self.claim_queue = [value['id']]

    def claim(self):
        self.claims += 1
        if not self.claim_queue:
            return None
        value = self.values[self.claim_queue.pop(0)]
        if value.get('backRequest'):
            value['state'] = 'awaiting_refeed'
        self.job = value
        return copy.deepcopy(value)

    def get_job(self, job_id):
        return copy.deepcopy(self.values[job_id])

    def report(self, value, event):
        self.job = self.values[value['id']]
        if self.job.get('workflow') != native.DEFERRED_WORKFLOW:
            return super().report(value, event)
        if event['eventId'] in self.replies:
            return {**copy.deepcopy(self.replies[event['eventId']]), 'replayed': True}
        self.events.append(copy.deepcopy(event))
        step = next((entry for entry in self.job['steps'] if entry['artifactId'] == event.get('artifactId') and entry['phase'] == event.get('phase')), None)
        kind = event['state']
        if kind == 'canceled':
            scope = self.job.get('cancelRequested')
            if not scope or event.get('paperCleared') is not True:
                raise native.StationError('Cancellation needs operator paper clearance')
            for item in self.job['steps']:
                if item['state'] != 'completed' and (scope == 'all' or item['phase'] == 'backs'):
                    item['state'] = 'canceled'
            self.job['cancelRequested'] = None
            self.job['backRequest'] = None
            self.settle()
        elif kind == 'paper_ready':
            if self.job['state'] != 'awaiting_paper_reset' or event.get('paperCleared') is not True:
                raise native.StationError('Paper reset requires confirmation')
            self.job['backRequest'] = None
            self.settle()
        elif step:
            if kind == 'submitting':
                if self.job.get('cancelRequested') or step['state'] != 'pending':
                    raise native.StationError('Submission denied')
                if step['phase'] == 'backs' and not step.get('refeedConfirmed'):
                    raise native.StationError('Must confirm selected refeed')
                step['state'] = 'submitting'
                self.job['state'] = 'submitting'
            elif kind in {'submitted', 'completed', 'uncertain'}:
                step['state'] = kind
                self.job['state'] = kind
            elif kind == 'reconciled':
                step['state'] = event['resolution']
                if event['resolution'] == 'abandoned':
                    if event.get('paperCleared') is not True:
                        raise native.StationError('Paper clearance required')
                    step['state'] = self.job['state'] = 'failed'
            elif kind == 'refeed':
                if (self.job.get('backRequest') or {}).get('artifactId') != step['artifactId']:
                    raise native.StationError('Not the selected back')
                step['refeedConfirmed'] = True
                self.job['state'] = 'claimed'
            if event.get('spoolerId'):
                step['spoolerId'] = event['spoolerId']
            if step['state'] == 'completed':
                if step['phase'] == 'backs':
                    self.job['state'] = 'awaiting_paper_reset'
                else:
                    self.settle()
        result = {'job': copy.deepcopy(self.job), 'replayed': False}
        self.replies[event['eventId']] = copy.deepcopy(result)
        if kind == self.fail_state:
            self.fail_state = None
            raise native.StationError('Reply lost after durable server commit')
        return result

    def settle(self):
        unresolved = [item for item in self.job['steps'] if item['state'] not in native.PASS_TERMINAL]
        if not unresolved:
            self.job['state'] = 'canceled' if any(item['state'] == 'canceled' for item in self.job['steps']) else 'completed'
        elif any(item['phase'] == 'fronts' for item in unresolved):
            self.job['state'] = 'claimed'
        else:
            self.job['state'] = 'backs_pending'

    def prepare(self, job_id, artifact_id):
        value = self.values[job_id]
        value['backRequest'] = {'id': 'reservation-' + artifact_id, 'artifactId': artifact_id, 'requestedAt': '2026-09-12T00:00:00Z', 'requesterId': 1}
        self.claim_queue.append(job_id)


class CancelCups(FakeCups):
    def __init__(self):
        super().__init__()
        self.cancellations = []
        self.cancel_finishes = True

    def cancel(self, spooler_id):
        self.cancellations.append(spooler_id)
        if self.cancel_finishes:
            next(item for item in self.history if item['id'] == spooler_id)['state'] = 7


class DeferredBacksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.config = config(self.directory)
        value = packet_job(2)
        value.update(workflow=native.DEFERRED_WORKFLOW, backRequest=None, cancelRequested=None, cancelRequestId='cancel-fixture-request')
        self.client, self.cups = DeferredClient(value), CancelCups()
        self.station = native.Station(self.config, self.client, self.cups)
        self.transport = mock.Mock()
        self.config.update(refeed_discord_webhook_url='https://discord.com/api/webhooks/1234567890/FIXTURE', refeed_discord_user_id='123456789')
        self.station.alerts.discord_transport = self.transport

    def tearDown(self):
        self.station.ledger.db.close()
        self.temp.cleanup()

    def restart(self):
        self.station.ledger.db.close()
        self.station = native.Station(self.config, self.client, self.cups)
        self.station.alerts.discord_transport = self.transport

    def finish_fronts(self):
        for artifact in ['ordinary', 'double-faced-001', 'double-faced-002']:
            self.assertTrue(self.station.poll_once().startswith('submitted'))
            self.assertEqual(self.cups.submissions[-1][:2], (artifact, 'fronts'))
            self.cups.history[-1]['state'] = 9
            self.assertEqual(self.station.poll_once(), 'reconciled')
        self.assertEqual(self.station.poll_once(), 'backs_pending')

    def reserve(self, artifact='double-faced-002'):
        self.client.prepare('job1', artifact)
        self.assertEqual(self.station.poll_once(), 'awaiting_refeed')

    def test_every_front_finishes_then_other_jobs_run_and_later_back_is_exact(self):
        self.finish_fronts()
        self.assertIsNone(self.station.ledger.current())
        self.transport.assert_called_once()
        notice = self.transport.call_args.args[1]
        self.assertIn('Fronts printed', notice['content'])
        self.assertEqual(notice['allowed_mentions']['users'], [])
        self.assertNotIn('<@', notice['content'])
        self.client.values['next-job'] = job(job_id='next-job')
        self.client.claim_queue.append('next-job')
        self.assertEqual(self.station.poll_once(), 'submitted EPSON-4')
        self.cups.history[-1]['state'] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), 'completed')
        self.restart()
        self.reserve()
        flip = self.transport.call_args.args[1]
        self.assertIn('packet 2/2', flip['content'])
        self.assertEqual(flip['allowed_mentions']['users'], ['123456789'])
        self.assertEqual(len(self.cups.submissions), 4)
        self.station.resume('job1')
        self.assertEqual(self.station.poll_once(), 'submitted EPSON-5')
        self.assertEqual(self.cups.submissions[-1][:2], ('double-faced-002', 'backs'))
        self.cups.history[-1]['state'] = 9
        self.station.poll_once()
        self.assertEqual(self.station.poll_once(), 'awaiting_paper_reset')
        self.assertEqual(self.station.poll_once(), 'awaiting_paper_reset')
        reset = self.transport.call_args.args[1]
        self.assertIn('Return blank paper', reset['content'])
        self.assertEqual(reset['allowed_mentions']['users'], ['123456789'])
        self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(len(self.cups.submissions), 5)
        self.assertEqual(self.station.poll_once(), 'idle')
        self.assertEqual(len([call for call in self.transport.call_args_list if 'Fronts printed' in call.args[1]['content']]), 1)

    def test_all_backs_require_separate_confirmation_and_whole_completion_after_reset(self):
        self.finish_fronts()
        for artifact in ['double-faced-002', 'double-faced-001']:
            self.reserve(artifact)
            self.station.resume('job1')
            self.station.poll_once()
            self.cups.history[-1]['state'] = 9
            self.station.poll_once()
            self.station.poll_once()
            self.assertFalse(any('Print job complete' in call.args[1]['content'] for call in self.transport.call_args_list))
            self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertEqual(self.client.values['job1']['state'], 'completed')
        self.assertIsNone(self.station.ledger.current())
        complete = [call.args[1] for call in self.transport.call_args_list if 'Print job complete' in call.args[1]['content']]
        self.assertEqual(len(complete), 1)
        self.assertEqual(complete[0]['allowed_mentions']['users'], [])

    def test_saved_back_pdf_survives_retention_and_restart(self):
        self.finish_fronts()
        self.station.ledger.write("UPDATE jobs SET updated=0 WHERE id='job1'")
        self.station.cleanup()
        self.assertTrue((self.station.ledger.directory / 'job1' / 'double-faced-002.pdf').exists())
        self.restart()
        self.assertIsNone(self.station.ledger.current())
        self.reserve()
        self.station.resume('job1')
        self.station.poll_once()
        self.assertEqual(len(self.cups.submissions), 4)

    def test_canceled_backs_do_not_block_remaining_fronts_or_announce_false_completion(self):
        self.station.poll_once()
        value = self.client.values['job1']
        for step in value['steps']:
            if step['phase'] == 'backs':
                step['state'] = 'canceled'
        for index in range(3):
            self.cups.history[-1]['state'] = 9
            self.station.poll_once()
            if index < 2:
                self.station.poll_once()
        self.assertEqual(self.station.poll_once(), 'canceled')
        self.assertEqual(len(self.cups.submissions), 3)
        self.transport.assert_not_called()

    def test_cancel_active_front_only_exact_cups_job_then_clearance(self):
        self.station.poll_once()
        self.cups.history.append({'id': 'EPSON-999', 'title': 'Someone else', 'state': 5})
        self.client.values['job1']['cancelRequested'] = 'all'
        self.assertEqual(self.station.poll_once(), 'awaiting_clearance')
        self.assertEqual(self.cups.cancellations, ['EPSON-1'])
        self.assertEqual(self.cups.history[-1]['state'], 5)
        self.assertEqual(len(self.cups.submissions), 1)
        self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertEqual(self.client.values['job1']['state'], 'canceled')
        self.assertIsNone(self.station.ledger.current())
        self.transport.assert_called_once()
        payload = self.transport.call_args.args[1]
        self.assertIn('Canceled print needs paper clearance', payload['content'])
        self.assertEqual(payload['allowed_mentions']['users'], ['123456789'])
        self.assertNotIn('Backs finished', payload['content'])
        self.assertNotIn('Packet 1/1', payload['content'])

    def test_cancel_cannot_clear_until_cups_stops(self):
        self.station.poll_once()
        self.cups.cancel_finishes = False
        self.client.values['job1']['cancelRequested'] = 'all'
        self.station.poll_once()
        with self.assertRaisesRegex(native.StationError, 'still active'):
            self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertEqual(self.station.ledger.current()['state'], 'awaiting_clearance')

    def test_cups_completes_between_cancel_and_clearance_preserves_printed_receipt(self):
        self.station.poll_once()
        self.cups.cancel_finishes = False
        self.client.values['job1']['cancelRequested'] = 'all'
        self.station.poll_once()
        self.cups.history[0]['state'] = 9
        self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        ordinary = self.station.ledger.passes('job1')[0]
        self.assertEqual(ordinary['state'], 'completed')
        self.assertEqual(ordinary['spooler_id'], 'EPSON-1')
        self.assertEqual(self.client.values['job1']['steps'][0]['state'], 'completed')
        self.assertEqual(self.client.values['job1']['state'], 'canceled')

    def test_server_canceled_saved_backs_retire_local_cache_without_claim_or_alert(self):
        self.finish_fronts()
        for step in self.client.values['job1']['steps']:
            if step['phase'] == 'backs':
                step['state'] = 'canceled'
        self.client.values['job1']['state'] = 'canceled'
        self.station.last_parked_sync = None
        self.assertEqual(self.station.poll_once(), 'idle')
        self.assertEqual(self.station.ledger.db.execute("SELECT state FROM jobs WHERE id='job1'").fetchone()[0], 'canceled')
        self.assertEqual(len(self.cups.submissions), 3)
        self.transport.assert_called_once()

    def test_cancel_ambiguous_or_mismatched_cups_never_targets_other_jobs(self):
        self.station.poll_once()
        self.client.values['job1']['cancelRequested'] = 'all'
        self.cups.history[0]['id'] = 'EPSON-999'
        with self.assertRaisesRegex(native.StationError, 'exact CUPS'):
            self.station.poll_once()
        self.assertEqual(self.cups.cancellations, [])
        with self.assertRaises(native.StationError):
            self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertEqual(len(self.cups.submissions), 1)

    def test_cancel_prepared_back_requires_clearance_but_no_cups_cancel(self):
        self.finish_fronts()
        self.reserve()
        self.client.values['job1']['cancelRequested'] = 'backs'
        self.station.poll_once()
        self.assertEqual(self.station.ledger.current()['state'], 'awaiting_clearance')
        self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertEqual(self.client.values['job1']['state'], 'canceled')
        self.assertEqual(self.cups.cancellations, [])
        self.assertEqual(len(self.cups.submissions), 3)
        self.assertFalse(any('Print job complete' in call.args[1]['content'] for call in self.transport.call_args_list))

    def test_cancel_clearance_lost_reply_recovers_without_print_or_second_confirmation(self):
        self.station.poll_once()
        self.client.values['job1']['cancelRequested'] = 'all'
        self.station.poll_once()
        self.client.fail_state = 'canceled'
        with self.assertRaises(native.StationError):
            self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.restart()
        self.assertEqual(self.station.poll_once(), 'canceled')
        self.assertIsNone(self.station.ledger.current())
        self.assertEqual(len(self.cups.submissions), 1)

    def test_back_completion_lost_ack_keeps_reset_boundary_without_cups_history(self):
        self.finish_fronts()
        self.reserve()
        self.station.resume('job1')
        self.station.poll_once()
        self.cups.history[-1]['state'] = 9
        self.client.fail_state = 'completed'
        with self.assertRaises(native.StationError):
            self.station.poll_once()
        self.cups.history = []
        self.restart()
        self.assertEqual(self.station.poll_once(), 'awaiting_paper_reset')
        self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.assertEqual(len(self.cups.submissions), 4)

    def test_paper_reset_lost_reply_releases_without_reprint(self):
        self.finish_fronts()
        self.reserve()
        self.station.resume('job1')
        self.station.poll_once()
        self.cups.history[-1]['state'] = 9
        self.station.poll_once()
        self.station.poll_once()
        self.client.fail_state = 'paper_ready'
        with self.assertRaises(native.StationError):
            self.station.clear_paper('job1', native.clearance_id(self.client.values['job1']))
        self.restart()
        self.assertEqual(self.station.poll_once(), 'backs_pending')
        self.assertEqual(len(self.cups.submissions), 4)

    def test_stale_same_job_clearance_cannot_release_another_packet(self):
        self.finish_fronts()
        first_clearance = None
        for artifact in ['double-faced-002', 'double-faced-001']:
            self.reserve(artifact)
            self.station.resume('job1')
            self.station.poll_once()
            self.cups.history[-1]['state'] = 9
            self.station.poll_once()
            self.station.poll_once()
            if first_clearance:
                with self.assertRaisesRegex(native.StationError, 'different packet'):
                    self.station.clear_paper('job1', first_clearance)
                self.assertEqual(self.station.ledger.current()['state'], 'awaiting_paper_reset')
            else:
                first_clearance = native.clearance_id(self.client.values['job1'])
                self.station.clear_paper('job1', first_clearance)

    def test_cancel_expansion_invalidates_already_open_paper_confirmation(self):
        self.finish_fronts()
        self.reserve()
        self.client.values['job1']['cancelRequested'] = 'backs'
        self.station.poll_once()
        previous = native.clearance_id(self.client.values['job1'])
        self.client.values['job1'].update(cancelRequested='all', cancelRequestId='cancel-expanded-request')
        with self.assertRaisesRegex(native.StationError, 'different packet'):
            self.station.clear_paper('job1', previous)
        self.assertEqual(self.station.ledger.current()['state'], 'awaiting_clearance')

    def test_release_reconciles_exact_later_packet_not_an_earlier_saved_back(self):
        self.finish_fronts()
        self.reserve('double-faced-002')
        self.station.resume('job1')
        self.station.poll_once()
        self.cups.history = []
        self.station.poll_once()
        self.assertEqual(self.station.ledger.current()['state'], 'uncertain')
        self.station.release('job1', True)
        abandoned = [event for event in self.client.events if event.get('resolution') == 'abandoned']
        self.assertEqual(len(abandoned), 1)
        self.assertEqual(abandoned[0]['artifactId'], 'double-faced-002')
        earlier = next(entry for entry in self.client.values['job1']['steps'] if entry['artifactId'] == 'double-faced-001' and entry['phase'] == 'backs')
        self.assertEqual(earlier['state'], 'pending')
        self.assertEqual(len(self.cups.submissions), 4)

    def test_notification_failure_does_not_block_next_front_job(self):
        with mock.patch.object(self.station.alerts, 'fronts_completed', side_effect=RuntimeError('broken alert storage')):
            self.finish_fronts()
        self.assertIsNone(self.station.ledger.current())

    def test_snapshot_identifies_selected_packet_even_if_later_than_pending_back(self):
        self.finish_fronts()
        self.reserve()
        controls = StationControl(self.station, native.COMPANION_VERSION, manager=mock.Mock(managed_status=lambda _: {'supported': False}))
        state = controls.snapshot()['activeJob']
        self.assertEqual(state['artifactId'], 'double-faced-002')
        self.assertEqual(state['state'], 'awaiting_refeed')


if __name__ == '__main__':
    unittest.main()
