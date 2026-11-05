"""Exact Bonjour identity and stale CUPS paper faults; no real device I/O."""
import plistlib
import subprocess
import unittest
from unittest import mock

import clc_print_station as native
from clc_printer_health import parse_printer_health, stale_paper_status
from test_printer_health import reply


UUID = "cfe92100-67c4-11d4-a45f-64c6d25c000f"
URI = "dnssd://EPSON%20ET-8550%20Series._ipps._tcp.local./?uuid=" + UUID
DISCOVERY = ("EPSON ET-8550 Series._ipps._tcp.local. can be reached at EPSON5C000F.local.:631 (interface 14)\n"
             "rp=ipp/print ty=EPSON UUID=" + UUID + "\n")
STALE = reply(["media-empty", "media-needed", "com.epson.er06_005-error"])


def device_reply(identity="urn:uuid:" + UUID, **kwargs):
    data = plistlib.loads(reply(**kwargs))
    if identity is not None:
        data["Tests"][0]["ResponseAttributes"][0]["printer-uuid"] = identity
    return plistlib.dumps(data)


class DeviceHealthTests(unittest.TestCase):
    def cups(self, local=STALE, direct=None):
        self.local = local
        self.direct = direct if direct is not None else device_reply()
        self.discovery = mock.Mock(return_value=DISCOVERY)
        self.calls = []

        def runner(args, **kwargs):
            self.calls.append((args, kwargs))
            if args[0] == "/usr/bin/lpstat":
                return "device for EPSON: " + URI + "\n"
            if args[4].startswith("ipp://localhost/"):
                return self.local
            if isinstance(self.direct, Exception):
                raise self.direct
            return self.direct

        cups = native.Cups({"queue": "EPSON"}, runner, self.discovery)
        cups.jobs = mock.Mock(return_value=[{"id": "EPSON-23", "state": 7, "title": "CLC-old"}])
        return cups

    def test_same_device_ready_clears_only_terminal_paper_fault(self):
        cups = self.cups()
        health = cups.status()
        self.assertEqual(health, {"ok": True, "known": True, "reasons": [],
                                  "message": "Printer device is ready (verified directly)", "advisories": []})
        self.discovery.assert_called_once_with("EPSON ET-8550 Series", "_ipps._tcp")
        direct = next(call for call in self.calls if call[0][4].startswith("ipps://"))
        self.assertEqual(direct, (["/usr/bin/ipptool", "-X", "-T", "8",
                                   "ipps://EPSON5C000F.local.:631/ipp/print", str(native.HERE / "get-printer.test")], {"timeout": 10}))
        self.assertEqual(cups.jobs.call_count, 2)

    def test_canceled_and_aborted_receipts_remain_actionable_when_device_ready(self):
        for state, reason in ((7, "job-canceled"), (8, "job-aborted")):
            cups = self.cups()
            cups.jobs.return_value[0]["state"] = state
            health = cups.status("EPSON-23")
            self.assertFalse(health["ok"])
            self.assertEqual(health["reasons"], [reason])
            self.assertIn("verified directly", health["message"])

    def test_missing_target_receipt_cannot_become_healthy(self):
        cups = self.cups()
        health = cups.status("EPSON-99")
        self.assertFalse(health["known"])
        self.assertFalse(health["ok"])

    def test_uuid_mismatch_missing_malformed_and_ambiguous_identity_do_not_clear(self):
        for identity in (None, "urn:uuid:ffffffff-67c4-11d4-a45f-64c6d25c000f",
                         UUID, "urn:uuid:invalid", ["urn:uuid:" + UUID]):
            with self.subTest(identity=identity):
                cups = self.cups(direct=device_reply(identity))
                self.assertEqual(cups.status(), parse_printer_health(STALE))

    def test_device_fault_unknown_busy_stopped_or_not_accepting_do_not_clear(self):
        for kwargs in ({"reasons": ["media-empty"]}, {"reasons": ["vendor-unknown"]},
                       {"state": 4}, {"state": 5}, {"accepting": False},
                       {"message": "Out of ink"}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.cups(direct=device_reply(**kwargs)).status(), parse_printer_health(STALE))

    def test_network_timeout_failure_and_discovery_failure_preserve_old_fault(self):
        for error in (subprocess.TimeoutExpired("ipptool", 10), native.StationError("unreachable"), OSError("offline")):
            with self.subTest(error=type(error).__name__):
                self.assertEqual(self.cups(direct=error).status(), parse_printer_health(STALE))
        cups = self.cups()
        self.discovery.side_effect = subprocess.TimeoutExpired("dns-sd", 4)
        self.assertEqual(cups.status(), parse_printer_health(STALE))

    def test_scheduler_fault_unknown_and_busy_queue_never_probe_device(self):
        for data in (reply(state=5, reasons=["media-empty"]), reply(accepting=False, reasons=["media-needed"]),
                     reply(state=4, reasons=["media-empty"]), reply(["media-empty", "cups-filter-error"]),
                     reply(["media-empty", "spool-area-full"]), reply(["media-empty", "vendor-unknown"]),
                     reply(["media-empty"], message="Out of ink"), reply(["media-jam"]), reply()):
            with self.subTest(local=plistlib.loads(data)):
                cups = self.cups(local=data)
                self.assertEqual(cups.status(), parse_printer_health(data))
                self.discovery.assert_not_called()
                cups.jobs.assert_not_called()

    def test_any_active_or_unknown_physical_job_blocks_fallback_including_non_clc(self):
        for state in (3, 4, 5, 6, 0, None):
            cups = self.cups()
            cups.jobs.return_value.append({"id": "EPSON-24", "state": state, "title": "Other application"})
            self.assertEqual(cups.status(), parse_printer_health(STALE))
            self.discovery.assert_not_called()
        cups = self.cups()
        cups.jobs.return_value = []
        self.assertEqual(cups.status(), parse_printer_health(STALE))
        self.discovery.assert_not_called()

    def test_jobs_and_scheduler_are_rechecked_after_network_probe(self):
        cups = self.cups()
        cups.jobs.side_effect = [[{"id": "EPSON-23", "state": 7}], [{"id": "EPSON-24", "state": 3}]]
        self.assertEqual(cups.status(), parse_printer_health(STALE))
        cups = self.cups()
        def discover(*_args):
            self.local = reply(state=5, reasons=["paused"])
            return DISCOVERY
        self.discovery.side_effect = discover
        self.assertIn("queue-stopped", cups.status()["reasons"])

    def test_lpstat_job_missing_from_ipp_prevents_terminal_history_proof(self):
        history = plistlib.dumps({"Tests": [{"Successful": True, "ResponseAttributes": [{
            "job-id": 23, "job-name": "CLC-old", "job-state": 7,
            "job-printer-uri": "ipp://localhost/printers/EPSON"}]}]})
        def runner(args, **_kwargs):
            if args[0] == "/usr/bin/lpstat":
                return "EPSON-23 owner 1024\nEPSON-24 owner 2048\n"
            return history if args[-1].endswith("get-jobs.test") else STALE
        discovery = mock.Mock()
        cups = native.Cups({"queue": "EPSON"}, runner, discovery)
        self.assertEqual(cups.status(), parse_printer_health(STALE))
        discovery.assert_not_called()
        with self.assertRaisesRegex(native.StationError, "history changed"):
            cups.jobs(require_complete=True)

    def test_exact_known_paper_codes_only_not_similar_vendor_codes(self):
        self.assertTrue(stale_paper_status(STALE))
        self.assertTrue(stale_paper_status(reply(["media-needed-error"])))
        for reason in ("com.epson.er06_006-error", "com.epson.er06_005", "unknown", "media-low"):
            self.assertFalse(stale_paper_status(reply(["media-empty", reason])))

    def test_exact_queue_service_resolves_but_invalid_discovery_never_becomes_endpoint(self):
        discovery = mock.Mock(return_value=DISCOVERY)
        self.assertEqual(native.discovered_printer(URI, discovery),
                         ("ipps://EPSON5C000F.local.:631/ipp/print", UUID))
        for uri in (URI.replace("dnssd:", "https:"), URI.replace("local.", "example.com."),
                    URI.replace("?uuid=", "?password="), URI + "&uuid=" + UUID, URI + "#fragment"):
            with self.subTest(uri=uri), self.assertRaises((native.StationError, ValueError)):
                native.discovered_printer(uri, discovery)
        for output in ("", DISCOVERY.replace("EPSON ET-8550 Series", "Different printer"),
                       DISCOVERY.replace("EPSON5C000F.local.", "other.example.com."),
                       DISCOVERY.replace(":631 ", ":65536 "), DISCOVERY.replace("rp=ipp/print", "rp=../evil"),
                       DISCOVERY + "rp=other/print\n", "x" * (64 * 1024 + 1)):
            with self.subTest(output=output[:100]), self.assertRaises(native.StationError):
                native.discovered_printer(URI, lambda *_args: output)

    def test_real_dns_sd_timestamp_and_decimal_escaped_service_name_are_matched_exactly(self):
        output = "Lookup EPSON ET-8550 Series._ipps._tcp.local.\n17:06:40.800  " + DISCOVERY.replace("EPSON ET-8550 Series", r"EPSON\032ET-8550\032Series")
        self.assertEqual(native.discovered_printer(URI, lambda *_args: output),
                         ("ipps://EPSON5C000F.local.:631/ipp/print", UUID))
        with self.assertRaises(native.StationError):
            native.discovered_printer(URI, lambda *_args: output.replace(r"\032", r"\999"))

    def test_dns_sd_lookup_is_bounded_exact_and_kills_resolver(self):
        process = mock.Mock()
        process.communicate.side_effect = [subprocess.TimeoutExpired("dns-sd", 4), (DISCOVERY, "")]
        process.poll.return_value = -9
        with mock.patch.object(native.subprocess, "Popen", return_value=process) as popen:
            self.assertEqual(native.dns_sd_lookup("EPSON ET-8550 Series", "_ipps._tcp"), DISCOVERY)
        self.assertEqual(popen.call_args.args[0], ["/usr/bin/dns-sd", "-L", "EPSON ET-8550 Series", "_ipps._tcp", "local."])
        self.assertEqual(process.communicate.call_args_list, [mock.call(timeout=4), mock.call(timeout=2)])
        process.kill.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
