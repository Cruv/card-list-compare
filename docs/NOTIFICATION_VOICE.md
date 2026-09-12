# Proxy Balboa notifications

Proxy Balboa is CLC's Discord persona. Messages use original dialogue inspired by Rocky's
plainspoken, slightly hesitant, earnest manner. Use occasional “Yo”, “y'know”, “ya” or
“all right”; avoid generic hype, constant boxing metaphors or a catchphrase on every line.
Do not copy film speeches or let the persona invent job progress, recovery or success.

Every ping has three parts:

1. **Factual headline first.** Phone previews identify the event, relevant deck or actual
   printer problem before the flavor text.
2. **One short voice line.** It adds personality without becoming an instruction the
   operator must interpret.
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
| Fronts printed · backs saved | All fronts completed; keep the labeled sheets for later. Leave blank paper loaded and let other jobs continue. | No |
| Paper flip needed | The operator selected this exact saved packet and the station now holds its reload reservation. Match the printed batch/packet label before reloading. | Configured operator, if any |
| Return blank paper | The selected back pass finished. Remove its output, load blanks, then confirm clearance for the current packet in CLC. Other printing waits. | Configured operator, if any |
| Canceled print needs paper clearance | Check that the exact canceled pass stopped, remove partial output and load blank paper, then confirm this cancellation in CLC. | Configured operator, if any |
| Print job complete | Every required pass completed and the final paper clearance is recorded. | No |
| Printer fault | The identified printer/pass needs inspection. | Configured operator, if any |
| Delivery test | An explicit notification test with no printer action. | No |

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

Example voice lines from the templates:

- Flip: “Yo. So, uh... we got the other side to do, y'know? I need a little help over here.”
- Fronts saved: “Yo, the fronts are done, y'know? We got the other sides saved for when you're ready.”
- Return blanks: “Yo, that side's done. I need you over here a second—get the blank paper back in, y'know?”
- Printer fault: “Hey, somethin' ain't right over here. Come take a look for me, all right?”
- Test: “Yo, it's me, Proxy. Just makin' sure you can hear me over here, y'know?”

The voice applies to Discord only; Mac notifications remain plain. From companion
**2.54.0**, completion messages and explicit delivery tests never directly mention a user.
The configured user ID is reserved for alerts that require help, such as a selected paper
flip, returning blank paper, clearing canceled output, or a printer fault. From **2.55.0**, the fronts-finished update
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

Routine reminders do not become printer-error pings. In companion 2.53.3+, Epson's exact
ink-tank-check reminder appears as an informational advisory in CLC. It does not indicate
empty ink. Unknown vendor warnings remain unconfirmed, while simultaneous confirmed
faults still produce their normal useful alerts.

Implementation: [native alerts](../companion/mac/clc_station_alerts.py) and
[deck/price alerts](../server/lib/notificationScheduler.js). Operating instructions:
[printing workflow](PRINT_WORKFLOW.md).
