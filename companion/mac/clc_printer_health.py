"""Interpret read-only CUPS status without trusting driver text as alert content."""
import plistlib
import re

REASONS = {
    "media-empty": "Printer is out of paper",
    "media-needed": "Printer needs paper",
    "media-jam": "Printer has a paper jam",
    "door-open": "A printer door is open",
    "cover-open": "A printer cover is open",
    "input-tray-missing": "Printer input tray is missing",
    "output-tray-missing": "Printer output tray is missing",
    "output-area-full": "Printer output tray is full",
    "marker-supply-empty": "Printer ink or another supply is empty",
    "marker-waste-full": "Printer waste container is full",
    "toner-empty": "Printer supply is empty",
    "ink-empty": "Printer ink is empty",
    "offline": "Printer is offline or not responding",
    "connecting-to-device": "Printer connection needs attention",
    "cups-missing-filter": "Printer driver filter is missing",
    "cups-filter-error": "Printer driver filter failed",
    "paused": "Printer queue is stopped",
    "shutdown": "Printer is shut down",
    "spool-area-full": "Printer spool storage is full",
    "stopped-partly": "Printer reports a stopped component",
}
BENIGN = {"none", "moving-to-paused", "cups-waiting-for-job-completed", "processing-to-stop-point"}
LOW_SUPPLY = {"toner-low", "marker-supply-low", "marker-waste-almost-full", "media-low", "ink-low"}
# Match only known diagnostic phrases, never forward arbitrary printer text,
# device addresses, document titles or credentials into a notification.
MESSAGES = [
    (r"paper jam|media jam", "media-jam"),
    (r"out of paper|paper out|load paper|no paper", "media-empty"),
    (r"offline|not responding|unable to connect|cannot connect|could not connect|looking for printer|connection (?:failed|refused|timed out)", "offline"),
    (r"filter failed|filter error|missing filter", "cups-filter-error"),
    (r"ink (?:empty|out)|out of ink", "ink-empty"),
]


def parse_printer_health(data, active_job_state=None):
    """Require a complete successful reply; unknown status cannot clear an alert."""
    if not isinstance(data, (str, bytes, bytearray)):
        raise ValueError("Cannot read authoritative CUPS printer status")
    if len(data) > 256 * 1024:
        raise ValueError("Printer status exceeds the local response limit")
    try:
        reply = plistlib.loads(data.encode() if isinstance(data, str) else data)
        tests = reply["Tests"]
        if (not isinstance(tests, list) or len(tests) != 1 or not isinstance(tests[0], dict)
                or tests[0].get("Successful") is not True):
            raise ValueError()
        attributes = tests[0]["ResponseAttributes"]
        if not isinstance(attributes, list) or not all(isinstance(group, dict) for group in attributes):
            raise ValueError()
        groups = [group for group in attributes if "printer-state" in group]
        if len(groups) != 1:
            raise ValueError()
        attributes = groups[0]
        state = attributes["printer-state"]
        accepting = attributes["printer-is-accepting-jobs"]
        reasons = attributes["printer-state-reasons"]
        if isinstance(reasons, str):
            reasons = [reasons]
        message = attributes.get("printer-state-message", "")
        if (type(state) is not int or state not in {3, 4, 5} or type(accepting) is not bool
                or not isinstance(reasons, list) or not 1 <= len(reasons) <= 64
                or not all(isinstance(reason, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", reason) for reason in reasons)
                or not isinstance(message, str) or len(message) > 8192):
            raise ValueError()
    except (ValueError, KeyError, TypeError, plistlib.InvalidFileException):
        raise ValueError("Cannot read authoritative CUPS printer status") from None
    faults, unknown = {}, False
    for raw_reason in reasons:
        reason = raw_reason.lower().replace(".", "-").replace("_", "-")
        suffix = next((suffix for suffix in ("-error", "-warning", "-report") if reason.endswith(suffix)), "")
        key = reason if reason in REASONS else reason[:-len(suffix)] if suffix else reason
        if key in REASONS:
            if key == "connecting-to-device" and suffix != "-error":
                unknown = True  # A connection attempt may be brief; message below can confirm a fault.
            else:
                faults[key] = REASONS[key]
        elif suffix == "-error":
            faults[key] = "Printer reports " + key.replace("-", " ")
        elif key in LOW_SUPPLY:
            pass  # Supply warnings do not flood notifications.
        elif key not in BENIGN:
            unknown = True
    for expression, reason in MESSAGES:
        if re.search(expression, message, re.IGNORECASE):
            faults[reason] = REASONS[reason]
    if state == 5:
        faults["queue-stopped"] = "Printer queue is stopped"
    if not accepting:
        faults["not-accepting-jobs"] = "Printer queue is not accepting jobs"
    if active_job_state in {4, 6, 7, 8}:
        key, text = {4: ("job-held", "Active CLC print pass is held"),
                     6: ("job-stopped", "Active CLC print pass is stopped"),
                     7: ("job-canceled", "Active CLC print pass was canceled"),
                     8: ("job-aborted", "Active CLC print pass was aborted")}[active_job_state]
        faults[key] = text
    if faults:
        return {"ok": False, "known": True, "reasons": sorted(faults), "message": "; ".join(dict.fromkeys(faults.values()))[:450]}
    if unknown:
        return {"ok": False, "known": False, "reasons": [], "message": "Printer reports an unrecognized status; check the Mac printer queue"}
    return {"ok": True, "known": True, "reasons": [], "message": "Printer queue is ready" if state == 3 else "Printer queue is processing"}
