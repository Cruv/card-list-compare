# Proxy Balboa notifications

Proxy Balboa is CLC's Discord persona. From companion **2.57.3**, native print webhooks
use curated pools of short, sourced Rocky film excerpts. Each message displays the movie
and speaker attribution beside its excerpt. Keep excerpts verbatim and attributed; do
not substitute invented dialogue, long speeches or claims about job progress.

This change applies only to native print webhooks. Deck/price notifications and signed
`/proxy` replies retain their existing original Rocky-inspired wording. Mac notifications
remain plain.

Every ping has three parts:

1. **Factual headline first.** Phone previews identify the event, relevant deck or actual
   printer problem before the flavor text.
2. **One short voice line.** Native print webhooks show a sourced film excerpt and its
   attribution. It adds personality without becoming an instruction to interpret.
3. **Plain details and action.** Native printer alerts use a labeled details block. Deck
   and price alerts retain their factual embed and link directly to the affected deck.

Flip details identify the printer, full batch ID, packet number and ID, printed label,
physical sheet count and exact reload instructions. A packet is a subdivision of a batch;
PDF pages and physical sheets are different counts. Never invent a flip edge or paper
orientation that has not been calibrated. Printer faults retain the actual reported error,
affected batch/packet/pass when available, and where to check it. Test messages explicitly
say that they do not print or resume a job. Prices retain direction, amount, previous/current
totals and selected-versus-budget mode. Deck changes use provider-neutral wording and
preserve added, removed and quantity-changed cards.

Saved-back workflows use distinct events so channel members can tell progress from an
operator request:

| Event | What the message means | Direct mention |
| --- | --- | --- |
| Print job queued | A new batch joined CLC's queue. Name its requester, saved label, copy count and queue time; Epson may not have started. | No |
| Fronts printed · backs saved | All fronts completed; keep the labeled sheets for later. Leave blank paper loaded and let other jobs continue. | No |
| Paper flip needed | The operator selected this exact saved packet and the station now holds its reload reservation. Match the printed batch/packet label before reloading. | Configured operator, if any |
| Return blank paper | The selected back pass finished. Remove its output, load blanks, then confirm clearance for the current packet in CLC. Other printing waits. | Configured operator, if any |
| Canceled print needs paper clearance | Check that the exact canceled pass stopped, remove partial output and load blank paper, then confirm this cancellation in CLC. | Configured operator, if any |
| Print job complete | Every required pass completed and the final paper clearance is recorded. | No |
| Printer fault | The identified printer/pass needs inspection. | Configured operator, if any |
| Print status unavailable | Repeated reads cannot verify an already-spooled pass; inspect its exact job/pass/ID. Status remains unknown. Idle read failures stay in CLC. | Configured operator, if any |
| Delivery test | An explicit notification test with no printer action. | No |
| `/proxy status` reply | Private response with exact batch/pass, device condition and available recovery instructions. | No |
| `/proxy continue` reply | Private acknowledgement of a durable recovery request. It does not claim printing resumed or completed. | No |

Saving backs never sends an unsolicited flip request. A requested packet that is still
waiting for other printing must not tell someone to load its sheets yet. A reload prompt
must identify the physical reservation, and a clearance prompt must identify the packet
or cancellation being cleared. Do not invent a timer for saved backs or imply that they
must be finished before the next front-only batch.

Completion messages identify the **whole job name** in the factual headline and retain
the batch identity, printer and CLC link in the plain details. Say that all required passes
have completed in the Mac spooler. Do not call a finished front pass or intermediate DFC
packet a completed job, or imply that the physical cards have passed inspection or are
ready for cutting. Canceling pending backs does not make a partly printed job an
all-passes-completed job. Preserve completed-pass receipts, and tell the operator to inspect
any partial output after cancellation instead of claiming the sheets were never printed.

Native pools match the event: queued work, delivery tests and flip requests use
training/readiness; whole-job completion, fronts completed and returning blank paper use
success; faults, cancellation and unavailable monitoring use setback/defeat. Monitoring
keeps its explicit unknown-status headline and details. A success excerpt on a
fronts-finished message does not change its factual **backs saved for later** status.
The [native catalog](../companion/mac/clc_station_alerts.py) holds 18 short excerpts and
released-film transcript references across the first five Rocky films and *Rocky Balboa*
(2006). Messages credit the actual speaker—Rocky, Mickey, Apollo or Duke—and film/year.
Dialogue stays in the implementation rather than being duplicated in this document.

A deterministic SHA-256 selection uses the event and batch identity. Packet events include
the packet ID; fault/monitoring events include controlled fault context. Tests use the
printer queue identity. Different batches can select different excerpts; the same event keeps its selection across retries
and restarts. Finite pools can repeat. Selection uses no clock or randomness and changes
only message text: it creates no extra notification and does not replay historical events.

From companion **2.54.0**, completion messages and explicit delivery tests never directly mention a user.
The configured user ID is reserved for alerts that require help, such as a selected paper
flip, returning blank paper, clearing canceled output, a printer fault or unavailable
monitoring of an already-spooled pass. From **2.55.0**, the fronts-finished update
also informs the channel without summoning the operator. Legacy active jobs retain their
existing alternating front/back flip prompts until finished.
Role/everyone mentions remain disabled; deck names and other supplied text cannot create
mentions. Secret redaction, message limits and duplicate suppression remain in force.
An alert never authorizes a back pass or retry. Automated checks use fake transports;
**Send test** in Printer settings is an explicit real notification action.

Only newly completed jobs produce completion messages. Upgrading or connecting Discord
does not replay historical completions. Delivery is best effort, with an attempt persisted
before sending and no automatic retry after a failed or ambiguous result; notification
failure never changes a job's print state. Fronts-finished and whole-job completion have
separate durable delivery records. Reload and return-blanks alerts have separate records
per packet, so acknowledging one event cannot suppress the other. Neither a delivered
message nor a dismissal can authorize printing, satisfy paper clearance, or unpause CLC.

From **2.57.0**, signed application commands provide an explicit control path separate
from webhook notifications. Keep their voice line short and preserve the full batch UUID,
exact pass, physical page order, required first-unprinted-sheet option and control receipt.
`/proxy continue` confirms that the operator fixed the printer and loaded the correct paper;
it may release an exact retained pass or request only inspected remaining fronts. Back-side
recovery still requires the matching-front paper check in CLC. A private acknowledgement
must say the request was queued and the Mac still checks its exact spooler state. Never
promise that a canceled pass can resume its old spooler ID or infer printed pages from
flavor text, counters or a generic “fixed” message. The existing webhook cannot receive
commands. Only the configured Discord application/operator/server/channel and active
linked CLC administrator can authorize these requests. Replies disable all mentions.

From companion **2.56.0**, new-job queue announcements use the same channel with all
mentions disabled, including mentions embedded in a requester name or batch label. A
queue announcement means CLC accepted the prepared job, not that Epson has begun or that
the operator should change the paper. The Mac receives these independently of print
claims, including while busy or paused. Queue retries and saved-back requests do not
create another announcement. Existing jobs are not backfilled on upgrade. Pending events
survive a server or Mac restart; after a delivery attempt, ambiguous outcomes are not
automatically retried. Events observed with Discord disconnected are skipped rather than replayed on reconnect.

Routine reminders do not become printer-error pings. In companion 2.53.3+, Epson's exact
ink-tank-check reminder appears as an informational advisory in CLC. It does not indicate
empty ink. Unknown vendor warnings remain unconfirmed, while simultaneous confirmed
faults still produce their normal useful alerts.

Implementation: [native alerts](../companion/mac/clc_station_alerts.py) and
[deck/price alerts](../server/lib/notificationScheduler.js), plus
[signed command replies](../server/lib/discordPrintBot.js). Operating instructions:
[printing workflow](PRINT_WORKFLOW.md).
