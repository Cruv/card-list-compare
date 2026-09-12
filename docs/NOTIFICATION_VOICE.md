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

Completion messages identify the **whole job name** in the factual headline and retain
the batch identity, printer and CLC link in the plain details. Say that all required passes
have completed in the Mac spooler. Do not call a finished front pass or intermediate DFC
packet a completed job, or imply that the physical cards have passed inspection or are
ready for cutting.

Example voice lines from the templates:

- Flip: “Yo. So, uh... we got the other side to do, y'know? I need a little help over here.”
- Printer fault: “Hey, somethin' ain't right over here. Come take a look for me, all right?”
- Test: “Yo, it's me, Proxy. Just makin' sure you can hear me over here, y'know?”

The voice applies to Discord only; Mac notifications remain plain. From companion
**2.54.0**, completion messages and explicit delivery tests never directly mention a user.
The configured user ID is reserved for alerts that require help, such as a paper flip or
printer fault. A completion update should inform the channel without summoning the operator.
Role/everyone mentions remain disabled; deck names and other supplied text cannot create
mentions. Secret redaction, message limits and duplicate suppression remain in force.
An alert never authorizes a back pass or retry. Automated checks use fake transports;
**Send test** in Printer settings is an explicit real notification action.

Only newly completed jobs produce completion messages. Upgrading or connecting Discord
does not replay historical completions. Delivery is best effort, with an attempt persisted
before sending and no automatic retry after a failed or ambiguous result; notification
failure never changes a job's print state.

Routine reminders do not become printer-error pings. In companion 2.53.3+, Epson's exact
ink-tank-check reminder appears as an informational advisory in CLC. It does not indicate
empty ink. Unknown vendor warnings remain unconfirmed, while simultaneous confirmed
faults still produce their normal useful alerts.

Implementation: [native alerts](../companion/mac/clc_station_alerts.py) and
[deck/price alerts](../server/lib/notificationScheduler.js). Operating instructions:
[printing workflow](PRINT_WORKFLOW.md).
