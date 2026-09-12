# CLC UI redesign inventory and validation plan

Inventory captured from the v2.51.0 source on 2026-09-11, with the new shell and
Connections route added during the redesign. This is the coverage
baseline for the whole-app redesign, not a claim that the redesign has passed QA.
The pre-redesign component directory contained 51 JSX files. The authoritative route
definitions are `src/lib/useHashRoute.js` and the render branches in `src/App.jsx`.
No `AGENTS.md` was found in this checkout; `CLAUDE.md` applies.

The redesign must retain CLC's comparison, deck tracking, print preparation and
ManaSync integration boundaries. Collection and purchase management belong to
ManaSync; there is no native CLC collection page to restore or invent.

## Route and access matrix

Every row needs direct navigation, reload, browser back/forward, narrow-screen
layout, an accessible page heading, active navigation and useful loading/error
states. Hash routes do not encode most internal tab selections.

| ID | Current address | Access and component | Required route-specific checks |
| --- | --- | --- | --- |
| R01 | `/`, empty hash, `#`, unrecognized hashes | Public; main `App`, `DeckInput`, `ChangelogOutput` | Empty and populated comparison; signed-out and signed-in navigation; Compare keyboard shortcut; unknown-hash fallback stays intentional. |
| R02 | `#share/{id}` | Public shared comparison; same main `App` surface | Automatic comparison, invalid/expired share, slow old response after navigation, editable input versus captured comparison, share and print handoff. |
| R03 | `#deck/{id}` | Public `SharedDeckView` | Valid/missing/unshared deck; snapshot list and text; latest/manual comparison, printing-only differences, captured returned snapshot IDs, sign-in print handoff. |
| R04 | `#library` | Signed in; `DeckLibrary` | Auth-loading gate, signed-out message, tracker/overlap/notifications, account changes. |
| R05 | `#library/{deckId}` | Signed in and owned deck; `DeckPage` | Missing/forbidden/malformed IDs, empty deck, seven tabs; changing user/deck remounts captured state. |
| R06 | `#print-list` | Signed in; `PrintListPage` and standalone `PrintPanel` | Empty draft, restored draft, compared-list handoff, saved pending request, null deck/snapshot scope, all three workflow steps. |
| R07 | `#print-station` | Signed in; `PrintStationPage`; household permission for status/controls | Auth gate; household denied; ordinary household user versus admin; online/offline/stale/not-yet-seen station; no enabled control from stale data. |
| R08 | `#settings` | Signed in; `UserSettings` | Account and conditional Invites tab; privilege changes. Integration configuration has moved to Connections. |
| R09 | `#admin` and `#admin/...` | Signed in; `AdminPage` separately requires admin | Ordinary user gets Access Denied; six sections. The suffix currently does not select a section: local state starts at Dashboard. |
| R10 | `#guide` | Public; `GuidePage` | Nine sections; signed-out access, short/long content, narrow navigation. |
| R11 | `?reset={token}` with any hash | `App` intercepts before normal route rendering; `ResetPassword` | Valid, invalid/expired, mismatched passwords, pending/success/failure; token removed from address on success. |
| R12 | `?verify={token}` with normal route | `App` side effect, not a separate page | Success/failure notification, query-token cleanup and preservation of intended hash route. |
| R13 | `#connections` | Signed in; `ConnectionsPage` | Guided ManaSync connection, optional CLC token access, link to station Discord setup, existing connection preservation and per-user remount. |

## Shared shell, authentication and small components

| ID | Surface and source | States and interactions to retain |
| --- | --- | --- |
| G01 | Shared navigation: `App.jsx`, `AppShell.jsx`, `AuthBar.jsx` | Desktop sidebar, phone bottom navigation and More drawer; Compare, Deck library, Print studio, Print station, Connections, Account settings, Guide, Administration when permitted, Log Out; active route, skip-to-content, modal focus/scroll restoration and fixed navigation clearance. Legacy per-page back links must not strand routes. |
| G02 | Authentication: `AuthBar.jsx`, `context/AuthContext.jsx`, `PasswordRequirements.jsx` | Login dialog, registration switch, username/password fields, open/invite-only/closed registration, invite code, password requirements, pending/validation/server errors, suspended/locked/expired session, logout. Email is configured in Account. Auth check must finish before a protected page renders. |
| G03 | Account recovery: `ForgotPassword.jsx`, `ResetPassword.jsx`, `App.jsx` | Reset email form, server without email configured, generic success response, reset-token form, new/confirm password, success navigation. Simulate mail responses; do not send QA mail. |
| G04 | Theme/settings: `context/ThemeContext.jsx`, `context/AppSettingsContext.jsx`, `index.css` | Dark and light appearance, stored preference, price display enabled/disabled, theme on dialogs/tooltips/native form controls, first load without theme flash. |
| G05 | Feedback: `Toast.jsx`, `ErrorBoundary.jsx`, `Skeleton.jsx` | Success/info/warning/error toasts, dismissal, screen-reader announcements, long messages, loading skeletons and page/chunk failures; overlays must not hide critical errors. |
| G06 | Confirmation: `ConfirmModal.jsx`, `lib/useModalLayer.js`, `lib/modalLayerStack.js` | Cancel/confirm/danger variants, optional typed confirmation, initial focus, Tab/Shift+Tab trap, Escape, backdrop behavior and restored focus. Fixtures only for destructive actions. |
| G07 | Card rows: `CardLine.jsx`, `ManaCost.jsx`, `SectionChangelog.jsx` | Name, quantity, mana symbols, set/collector/foil, old/new printings, unit/total/budget prices, unknown metadata, hover art and touch image dialog. Long names/DFC names must wrap without concealing controls. |
| G08 | Copy/release: `CopyButton.jsx`, `WhatsNewModal.jsx`, `App.jsx` footer | Copy pending/success/failure, clipboard unavailable, one-shot release toast, full What's New dialog and close/back navigation. |
| G09 | Installed web app: `public/manifest.json`, `public/sw.js`, `main.jsx`, `index.html` | Browser and standalone display modes, safe-area inset, app icon/theme color, online update/reload with a previously installed service worker, offline shell. API and external responses are not cached; do not claim offline deck/inventory/station operation. |

## Compare, imports and result exports

| ID | Surface and source | Required coverage |
| --- | --- | --- |
| C01 | Before/After editors: `DeckInput.jsx`, `App.jsx` | Paste and type, independent fields, whitespace/empty input, full supported deck-text syntax, set/collector/foil/DFC/sideboard/commander metadata, long text, character selection, touch keyboard and textarea scrolling. |
| C02 | File and URL imports: `DeckInput.jsx`, `lib/fetcher.js` | File chooser and supported text/CSV content; URL panel for Archidekt, Moxfield, TappedOut, Deckstats, DeckCheck and currently supported fetcher detection; import loading, unsupported URL, provider error, empty deck and replacement of the correct editor only. Do not lose printing details. |
| C03 | Tracked import/save panels: `DeckInput.jsx` | Signed-in tracked-deck selector, expanded decks/snapshots, snapshot text load, refresh, snapshot nickname edit/delete, show-all pagination, matching-import save prompt, dismiss, manual Save Snapshot with target/nickname, empty library. Preserve draft text on failure. |
| C04 | Comparison actions: `App.jsx` | Compare Lists and Cmd/Ctrl+Enter, Swap, Clear; exact completed comparison remains stable when inputs change; edited-input notice; older metadata/shared-link responses cannot replace newer results. |
| C05 | Result overview/filter: `ChangelogOutput.jsx`, `SectionChangelog.jsx` | Commander title, counts for in/out/quantity/printing changes, unchanged percentage, mainboard/sideboard groups, type grouping, name search and clear, identical lists, removal-only changes, printing-only and foil-only cases. Filtering changes the view, not export/print intent. |
| C06 | Exports and share: `ChangelogOutput.jsx`, `CopyButton.jsx`, `lib/formatter.js` | MPCFill additions, Changelog, Archidekt complete target list, More menu, Reddit, JSON, TTS download, share link pending/error, external DeckCheck power link. Exact metadata and captured text must agree with the shown comparison. |
| C07 | Print entry: `PrintComparisonButton.jsx`, `lib/printComparisonHandoff.js` | Available for a nonempty After list including identical/removal-only comparisons; defaults to changes with full After available later; logged-out sign-in/reload handoff, scoped user, existing draft and immutable pending request preservation, storage failure, new handoff not consumed by an old screen. |

## Deck library and deck detail

| ID | Surface and source | Required coverage |
| --- | --- | --- |
| L01 | Deck Tracker: `DeckLibrary.jsx`, `DeckGridCard.jsx` | Add/remove Archidekt owner, expand available owner decks, track/untrack, refresh all/single/bulk, search, clear, tags, collapse owner groups, selected cards, all/none selection, bulk export/removal, empty/loading/error; grid cards via pointer and keyboard. Manual/provider-tracked decks both render. |
| L02 | Overlap tab: `DeckLibrary.jsx` | Fewer than two eligible decks, populated matrix, horizontal containment, selected pair/shared-card drilldown, clear/back, multiple identities and long deck names. This is deck overlap, not a collection manager. |
| L03 | Notifications tab: `DeckLibrary.jsx` | Empty/populated/failed history, pagination, card/deck-change summaries, timestamps and long messages. No real email or webhook test during visual QA. |
| D01 | Deck header: `DeckPage.jsx` | Back, name, provider/source link/status, refresh/refreshing, untrack confirmation, commanders edit/add/remove, pin, tags, price/budget when enabled, snapshot/date/status badges, notes summary, long/missing metadata. |
| D02 | Snapshots tab: `DeckPage.jsx` | Empty/one/many snapshots, nickname editor, lock/unlock, Paper marker, locked-delete restrictions, delete confirmation, newest-first order, Paper vs Latest, two selectors/manual Compare, identical/printing-only/normal inline results, close result, copy/print from captured response despite changed selectors. |
| D03 | Changelog tab: `DeckPage.jsx`, `SectionChangelog.jsx`, delta components | Lazy loading, fewer than two snapshots, identical results, search, print CTA outside no-change guards, MPCFill/Changelog/Archidekt/Reddit/JSON exports, mana/color deltas, exact captured latest pair. |
| D04 | Timeline tab: `DeckPage.jsx` and its timeline item helpers | Empty/baseline/changed entries, added/removed/printing badges, selected snapshot, opening and closing timeline overlay, refreshed snapshots. |
| D05 | Full Deck tab: `DeckPage.jsx`, `DeckListView.jsx` | Loading/empty/populated deck, commander/mainboard/sideboard, name search and card ordering/grouping; exact printing images; collapse/expand analytics; power estimate, mana curve, card types, colors and deck-analysis summaries. Copy Archidekt/raw/TTS, MPCFill overlay, Scryfall ZIP progress/completion/failure/dismissal. |
| D06 | Printing tab: `DeckPage.jsx`, tracked `PrintPanel.jsx` | Full snapshot versus changes, Latest resolution, baseline/Paper defaults, Scryfall/saved MPC source, actual snapshot IDs; shared print workflow below. No standalone handoff may silently replace this deck's saved pending request. |
| D07 | Analytics tab: `DeckPage.jsx`, `PriceHistoryOverlay.jsx`, `RecommendationsOverlay.jsx` | Check Prices pending/error, exact and budget totals, prior-price delta, expensive-card summary, clear result, price-display policy, history and suggestions overlays. |
| D08 | Settings tab: `DeckPage.jsx` | Share/copy/unshare, email notification toggle and unavailable-email hint, auto-refresh choices/manual-source hint, deck Discord webhook edit/save/remove, price alert threshold and pricing mode, notes create/edit/save. Use fake mutations and never expose real webhook values. |
| D09 | Source review: `SourceSyncReview.jsx`, shown with deck content | Provider/manual status; no pending change, unchanged/upstream/local/diverged/error; saved basis/current/provider text disclosures, keep/use source/merge choices, reviewed checkbox, stale basis rebase, preserved merge draft, saved-decision retry, permission/session failure. |
| D10 | ManaSync proposals: `ProposalReview.jsx`, shown with deck content | Collapsed list/empty/refresh/error, pending/stale/terminal proposals, saved base/proposed/current text, replacement edit, reviewed checkbox, accept/revise/reject, character limit, stale rebase with edits, switching proposal/account, pending and recovered decisions, immutable replay. |
| D11 | Ownership and physical queue: `ManaSyncOwnership.jsx`, `PrintQueue.jsx`, `PrintQueueArtwork.jsx` | See ManaSync/printing sections below; full-deck ownership has additional queue-one/queue-deck controls. |

## Printing, station and ManaSync

| ID | Surface and source | Required coverage |
| --- | --- | --- |
| P01 | Choose cards: `PrintListPage.jsx`, `PrintPanel.jsx` | Three-step navigation and single clear next action; standalone text/name/file/URL import, per-user saved draft, compared Before/After disclosure and changes/full mode, existing/previous draft restore, basic lands excluded and replacement off by default, optional sideboard, tracked source options. |
| P02 | Review: `PrintPanel.jsx`, `PrintListReview.jsx`, `PrintPlanArtwork.jsx` | Compact card rows, exact front/back images and failed-thumbnail retry, counts and sheet estimate, remove suggested copies/reinclude, extras merged without losing base/extra distinction, basic/sideboard/replacement options, dirty review blocks generation and shopping, source edit/back; all source deck text stays intact. |
| P03 | Review filters/shopping: `PrintListReview.jsx`, `PrintPlanOwnership.jsx`, `ManaSyncOwnership.jsx` | Name/set/collector search; all/single/double/unresolved faces; all/owned/incoming/not-owned/unknown ownership; list/name/copy/DFC sorting. View filters must not change PDF quantities. One original of any printing, even allocated elsewhere or incoming, covers unlimited proxies; proxies alone do not count. Failed refresh becomes unknown with no false shopping suggestion. Filtered Mana Pool list deduplicates one missing original and never places an order. |
| P04 | Art picker: `PrintArtPicker.jsx`, `lib/printArtPicker.js` | Dialog, current/new printing, paired faces, set/collector/artist filter, bounded load-more, retry/timeout/abort, missing/wrong-card/digital results rejected, choose exact UUID, reset original art, fresh review required, failed thumbnail, phone modal and focus restoration. |
| P05 | Generate/recovery: `PrintPanel.jsx`, `lib/printReview.js`, `lib/printSelection.js` | PDFs-only and Generate & print, generator unavailable, household permission, preparation progress, durable request saved before POST, response loss/timeout/auth expiry, reload and same-key retry, exact art/edits/comparison/hash preserved, new comparison cannot overwrite unresolved request. |
| P06 | Batch status/history: `PrintPanel.jsx` | Preparing/ready/queued/claimed/submitting/submitted/awaiting_refeed/completed/uncertain/failed/canceled/expired, prominent current batch and collapsed others, PDF/manifest downloads, manual queue, safe cancellation/expiry affordances, expired artifact record, prepare another batch, optional help. Standalone history uses human label and null deck/snapshots. |
| P07 | Manual DFC handling: `PrintPanel.jsx`, `PrintStationPage.jsx` | Exact packet label/index/count and sheet count, matching fronts/backs, separate completed paper, remove unused blank paper/reload matching sheet, default proof flags and explicit test-mode wording. Resume must bind both job and artifact; changing pass invalidates the checkbox. Simulator/browser QA must mock all spooler/station mutations. |
| P08 | Station status/controls: `PrintStationPage.jsx` | Household denied, never seen, online/offline/stale/error, last seen, queue/version, health, recipe/proof/test flags, active job, enable/pause, pending/applied/rejected/expired command lists, same-request retry, recent events, terminal/uncertain states. Poll only while visible. Do not change the live enabled station during QA. |
| P09 | Station updates: `PrintStationPage.jsx` | Admin versus member, unsupported/checking/available/updating/rollback/failed, idle requirement, current/available/previous version, captured target version, error/recovery; fixture-only update commands. |
| P10 | Discord flip alerts: `PrintStationPage.jsx` | Admin connect/save/test/disconnect; member read-only; old companion capability gate, pending/offline/connected, webhook validation, optional one-user mention, uncertain configure needs same secret reentry, no secret in status/storage/logs. Never send actual test messages during QA. |
| M01 | ManaSync connection: `ManaSyncSettings.jsx` inside `ConnectionsPage.jsx` | Guided default `manasync.net`, Other server disclosure, external ManaSync link and integration-token instructions; missing/configured/connected/disconnected/error, custom base URL/path and token form, save/check/error, disconnect, contact timestamps/account identity, masked secret, queued reports tied to original account. |
| M02 | CLC access tokens: `IntegrationAccess.jsx` inside Connections disclosure | Token name, read/propose/create scopes, create pending/error, one-time token display/copy/hide, active/revoked list, revoke; no broad permission changes or real token screenshots. Existing integrations survive moving the UI from Account. |
| M03 | Pending physical confirmations: `PrintQueue.jsx`, `PrintQueueArtwork.jsx` | Whole-deck/card queue when available, batch-scoped pending list/art, destination, quantity boundaries, confirm/dismiss, partial/complete/unavailable/disconnected, refresh, operation statuses/retry/rebind, inspect receipts, adjust/move correction, reason/revision/conflict. Confirm only simulated quantities; standalone job must not create a fake deck. |

## Account and administrative panels

| ID | Surface and source | Required coverage |
| --- | --- | --- |
| A01 | Account: `UserSettings.jsx` | Username/member date, optional email add/change/remove, verified/unverified/resend, server email capability, password current/new/confirm and requirements, success/error. Connections now owns ManaSync and integration access. |
| A02 | Invites: `UserSettings.jsx` | Tab visible only for invite permission/admin; empty/loading/list, max uses, create/copy/delete, consumed/remaining usage; permission loss. |
| A03 | Account deletion: `UserSettings.jsx`, `ConfirmModal.jsx` | Typed username gate, cancel, pending/error and signed-out result; fixture-only deletion. |
| A04 | Admin Dashboard: `admin/AdminDashboard.jsx` | Loading/error/refresh, users/activity/suspension/decks/snapshots/shares/database/process statistics, recent activity, backup and users CSV downloads, expired-token cleanup, audit retention cleanup, emergency lockdown and its confirmation. |
| A05 | Admin Users: `admin/AdminUserList.jsx` | Search/debounce/sort/page, user badges and dates, current-user restrictions, inline password reset, force logout, promote/demote, grant/revoke invite, suspend/unsuspend, unlock, typed delete confirmation; fixture-only mutations. |
| A06 | Admin Invites: `admin/AdminInvites.jsx` | Empty/loading/populated table, creator/usage/date information and delete. Creation is in the account Invites surface. |
| A07 | Admin Settings: `admin/AdminSettings.jsx` | Registration open/invite/closed, price display, deck notifications, check interval, snapshot cap and locked-snapshot cap; numeric validation, pending/save/failure feedback. |
| A08 | Admin Shares: `admin/AdminShares.jsx` | Shared-comparison list, owner/title/date/count information, open/copy link and deletion, empty/loading/error. |
| A09 | Admin Audit: `admin/AdminAuditLog.jsx` | Action filter, timestamps/actor/target/IP details, descriptive badges, empty/loading and pagination. Never publish live user/IP evidence in screenshots. |

## Overlays and public guide

| ID | Surface and source | Required coverage |
| --- | --- | --- |
| O01 | Timeline overlay: `TimelineOverlay.jsx` | Baseline versus Changes/Full Deck tabs, loading/empty, search, all export/print controls, correct captured snapshot text, analytics/deck view, nested MPC overlay. |
| O02 | MPC proxy overlay: `MpcOverlay.jsx` | Loading/results/unmatched/service failure; front/back selections and DFC pairs; alternate-art subview; search settings subview with precise/fuzzy, min/max DPI, max size, languages, include/exclude tags, ordered sources enable/disable/reorder, reset/cancel/save and re-search; save selected print art, cardstock/foil, XML and ZIP downloads/progress. Preserve existing search semantics and durable saved choices. |
| O03 | Recommendations: `RecommendationsOverlay.jsx` | Analysis summary, category tabs All/Ramp/Card Draw/Removal/Board Wipe/Protection/Lands/Recursion, search, empty/error/loading, card preview, prices, banned/game-changer indicators. |
| O04 | Price history: `PriceHistoryOverlay.jsx`, `PriceHistoryChart.jsx` | Empty/one/many points, SVG chart labels/hover or touch, current/change/high/low/first/count, loading/error, narrow chart and close. |
| O05 | Card image: `CardLine.jsx` | Desktop hover preview and touch full-image portal; loading/missing image, no clipping, dismiss and return focus. |
| O06 | Print art, confirmation and release dialogs | `PrintArtPicker.jsx`, `ConfirmModal.jsx`, `WhatsNewModal.jsx`; all shared focus/Escape/backdrop rules, nested-dialog order and scroll-lock restoration. |
| H01–H09 | `GuidePage.jsx` sections | Getting Started; Deck Comparison; Importing Decks; Deck Library; Deck Analytics; Proxy Printing; Export Formats; Recommendations; FAQ. Every section is a real navigation destination inside Guide and must be checked, including lists/tables/code samples and updated UI terminology. |

## Validation foundation and evidence ledger

Use disposable users/data and intercept or disable outbound side effects. No
production account edits, source saves, station pause/resume, updates, print jobs,
mail, webhooks, inventory confirmations or cleanup jobs belong in visual QA.
Any real live read-only proof should be recorded separately from fixture proof.

For every surface ID above, record: route and internal tab, role/data fixture,
viewport/engine, light/dark, loading/empty/ready/error where applicable, completed
actions, console errors, screenshot path and pass/fail. An initial screen alone
does not validate the controls hidden in menus, disclosures or dialogs.

Minimum browser matrix:

- Desktop 1440×1000 and intermediate/tablet width around 768–1024 pixels.
- Phone 375×812/900 and a wider modern phone profile; portrait and landscape.
- Keyboard traversal, visible focus, accessible labels, correct button semantics,
  Escape/back behavior, long names/text, 200% text/zoom and no document overflow.
- Fresh browser context plus existing persisted theme/draft/service-worker state.
- Auth absent/loading/member/admin/household-denied, expired token and switched
  account. Mock data must use real DTO shapes (`isAdmin`, not DB `is_admin`).
- Screenshot open navigation, tables, editable forms, drawer/modal and the software
  keyboard on real iOS Simulator once available. Check sticky controls and focused
  fields against keyboard/safe-area obstruction.

Existing automated tests are semantic guards, not full visual coverage:

| Domain | Current tests to keep running |
| --- | --- |
| Compare/import/export/identity | `src/lib/{parser,differ,formatter,fetcher,deckcheck,deckBridgeLines,scryfall,scryfall.identity}.test.js`; invariants test. |
| Printing and handoff | `src/lib/{printReview,printSelection,printArtPicker,printComparisonHandoff,printPlanOwnership,api.printArtwork,api.printLists}.test.js`; server `printQueuePlan`, `printQueueImages`, `printGenerator`, `scryfallImages`, `printJobBridge`, route `print` tests. |
| Station/Discord | `src/lib/api.print-station.test.js`, `server/routes/print-station-management.test.js`, native fake-printer/control/alerts tests under `companion/mac`. |
| ManaSync/reviews | `src/lib/{manasync,proposalReview,sourceSync,mpcOverrides,operationId}.test.js`; server `manasyncBridge`, `pendingProxyPlans`, `deckProposals`, `sourceSync`, `sourceTracking`, integration-route tests. |
| Layout-independent safety | `src/lib/modalLayerStack.test.js`; `server/routes/{deckLifecycle,admin.export}.test.js`; database persistence, image-budget and security tests; full test/lint/build/audits before release. |

Prior v2.51.0 browser scripts under `/tmp/clc-print-flow-qa.mjs` and
`/tmp/clc-compare-print-qa.mjs` provide disposable-DB fixtures for printing and
comparison, including intercepted APIs and synthetic artwork. They are local
working artifacts, not repository tests or proof that redesigned screens passed.
Expand the coverage ledger beyond those flows to the complete route matrix above.

## iOS Simulator and browser tooling availability

Read-only inspection on this Mac at inventory time:

| Tool/runtime | Observed state | Consequence |
| --- | --- | --- |
| Active developer directory | `xcode-select -p` → `/Library/Developer/CommandLineTools` | Only CLT is selected. |
| `simctl` | `xcrun simctl list --json devices runtimes` fails: utility not found | No native Simulator inventory, boot, Safari navigation or screenshot proof is currently possible. |
| Full Xcode | No `Xcode*.app` in `/Applications` or `~/Applications`; Spotlight found no `com.apple.dt.Xcode` bundle | A full Xcode installation must be located/installed before treating Simulator work as available. |
| CoreSimulator | Neither user nor system CoreSimulator directory exists; no running `Simulator` process | No installed runtime/device or active user Simulator was discovered. No device was changed. |
| Desktop Safari | `safaridriver --version` reports Safari 26.5.2 | Native desktop Safari exists. Remote Automation permission has not been changed or verified; it is not iOS Simulator proof. |
| Playwright | Bundled Node module and iPhone device descriptors available; system Chrome usable | Existing isolated Chromium browser QA is available via the explicit Chrome executable. Phone descriptors emulate dimensions/touch/user agent only. |
| Bundled browser downloads | Playwright's expected Chromium, WebKit and Firefox executables are absent | WebKit/Firefox require separate installation before claiming those engines were tested. |
| Native automation | CUA native-app/browser tool is available; no dedicated simulator automation connector found | After Xcode/runtime setup, inspect the actual Simulator surface and available CLI before choosing native actions. No UI automation/device mutation was attempted during inventory. |
| Other iOS CLI tooling | `ios-deploy`, `idb` and `maestro` not found in PATH | Do not assume a preconfigured iOS test driver. |

A later native proof must record actual Xcode version, iOS runtime, simulated
device, Safari URL, viewport/orientation and screenshots. Use a disposable
Simulator and isolated test server; keep real household data and active devices
untouched. Desktop Chrome with an iPhone viewport, desktop Safari and Playwright
WebKit are useful additional tests but cannot substitute for the requested
native iOS Simulator validation.

## Completed browser checks for the comparison and print surfaces

On 2026-09-11, isolated system Chrome contexts exercised the redesigned source
with synthetic artwork, intercepted APIs and disposable databases. Desktop and
375-pixel phone screenshots were inspected. The following suites overlap; their
assertion counts are not counts of unique product features.

| Suite | Assertions | Scope |
| --- | --- | --- |
| Compare/import/results | 23 passed | Before/After controls, exact File/URL/tracked imports, snapshot save panel, result categories, pricing/mana, full-copy despite filtering, clipboard denial, keyboard preview and focus restoration, touch targets, no horizontal overflow, captured comparison across sign-in and identical-list print action. |
| Print mobile layout | 16 passed | Sticky print action clears bottom navigation, two-column printing picker with paired faces, readable inputs, unchanged reviewed plan, basic station/refeed visibility and stale-state controls. |
| Comparison-to-print regression | 42 passed | Changes versus full After, captured source across main/tracked/public views, draft preservation and quota failures, chosen exact art, dirty review, durable creation and same-key lost-response retry. |
| Standalone edited-print regression | 59 passed | Per-user drafts, imports, removals/extras and option retention, original ownership and view filters, missing-original shopping, failure→unknown, immutable creation, downloads, null-deck confirmation scope and tracked printing replacement opt-in. |
| Navigation resize regression | 6 passed | More drawer open at 375 pixels, desktop transition at 1024 pixels, scroll release, focus release, closed state on returning to phone, reopen and Escape. |

The source-wide test run at this checkpoint passed 1,029 tests across 56 files.
ESLint reported zero errors and seven existing warnings. These checks made no
actual station commands, native printing, Discord sends or live inventory edits.
Fixture job creation/confirmation was confined to the disposable harness.

Inventory status: complete for the source surfaces listed above. Whole-app visual
coverage is tracked by the release review; native iOS Simulator validation remains
pending until the runtime and a real Simulator proof are available.


## Full workspace review for v2.52.0

The redesigned scope includes the persistent shell, authentication and reset flows,
public comparison/shared-deck screens, library and all seven deck sections, standalone
and tracked printing, station/Discord controls, guided Connections, Account/Invites,
all six Administration sections, all nine Guide topics and the inventory's overlays.
Scryfall illustration crops are decorative; exact front/back printing images are unchanged.

Additional browser proof (separate overlapping suites):

| Engine | Suite | Passed assertions |
| --- | --- | --- |
| System Chrome | Account/auth, Connections, all Guide/Admin sections, public shared deck, mobile navigation and themes | 39 |
| System Chrome | Deck/library and nested artwork/Timeline/MPC/price/recommendation overlays | 50 |
| System Chrome | Station permissions, online/offline/stale/refeed/uncertain states, Discord and update recovery | 36 |
| Playwright WebKit 26.5 | Account/auth, Connections, Guide/Admin, public deck, navigation/themes | 39 |
| Playwright WebKit 26.5 | Comparison-to-print / standalone edited printing / station | 42 / 59 / 36 |
| Playwright WebKit 26.5 | Deck/library, nested overlays, explicit native-dialog centering and focus restoration | 51 |

The WebKit print/station phone cases use mobile/touch emulation. Screenshots cover
375px phones and 1440px desktops in light/dark themes. These are engine checks,
not native iOS Simulator tests. Safari-style pointer clicks exposed missing launcher
focus; affected navigation/auth/deck overlay launchers now focus before opening so
closing restores the originating control. Desktop resize also unmounts the mobile drawer.

The native companion's fake-spooler suite passed 121 tests. Both dependency audits
reported zero vulnerabilities. The real running station remains enabled; visual QA
never sent a live print job, station command, Discord message or inventory mutation.

Native iOS Simulator is still pending. App Store installation of Xcode stalled on
an empty confirmation sheet; the owner was asked to complete installation. The release
must not be described as having passed native iOS checks until an actual runtime/device
is booted and its Safari/keyboard/orientation proof is recorded.

## Live deployment checkpoint

The source was committed and pushed as `a6d9eeb` and deployed as **v2.52.0** to the
household `CardListCompare` container on 2026-09-11 (local time). The source and isolated
Docker checks preceded deployment; this is additional read-only production evidence.

- The signed-in household browser displayed the new Print studio, Connections and
  Print Station surfaces and v2.52.0 navigation. Connections had no console errors.
- Connections correctly displayed **Not connected**, the default `manasync.net` address,
  the personal-token setup steps and the separate optional CLC deck-access disclosure.
  No real token was created or saved. ManaSync account authorization is still pending.
- Print Station displayed **Online**, **Enabled**, **Ready**, native companion **2.49.0**
  and no active batch. No live station control, print or Discord action was invoked.
- Local/public HTTP responses matched the Docker image's index and all 24 frontend
  assets. Hash evidence is `/tmp/clc-2520-live-assets.json`.
- Database checks preserved three users, two owners, 14 decks, 72 snapshots and one
  completed batch, with unchanged existing foreign-key findings. Deployment and backup
  locations are recorded in [OPERATIONS.md](OPERATIONS.md).

These checks do not establish a connected ManaSync account or native iOS Simulator
coverage. Both remain explicitly pending user sign-in/token or Xcode setup respectively.

## Remaining native iOS acceptance

A follow-up inspection still found no Xcode bundle or `simctl`. The App Store remained
at its Xcode confirmation sheet, with no installation progress established. This is a
setup dependency, not a passed or failed CLC rendering check.

Once Xcode is installed and its first-launch setup is complete, install an iOS Simulator
runtime in **Xcode → Settings → Components**. Apple also documents
`xcodebuild -downloadPlatform iOS` in its
[additional-components guide](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).
Record the actual `xcodebuild -version`, `xcrun simctl list runtimes` and available device
types before creating a dedicated **CLC UI QA** device. Do not reuse or erase an existing
user Simulator. Use that new device's explicit UDID for boot, URL and screenshot commands.

Native Safari needs a dedicated local fixture server. The previous Playwright route
interceptors apply only to their controlled browser contexts; they do not protect
Simulator Safari. Do not point native QA at Vite's default API proxies, the household
origin, or a backend configured with household data or credentials.

| Native check | Required evidence | Current status |
| --- | --- | --- |
| Identity and isolation | Actual iOS runtime/device/UDID, local fixture URL, fixture-only mutation log | Pending |
| Shared navigation and routes | Compare, library, deck, Print studio, station, Connections, Account, Guide, Admin and public shared-deck screenshots; More drawer and browser back behavior | Pending |
| Software keyboard | Login, comparison text, print extras, art search and connection-token fields remain readable and reachable with the on-screen keyboard open | Pending |
| Safe areas and orientation | Portrait/landscape screenshots showing bottom navigation, sticky generation controls, drawer and dialogs clear of system insets | Pending |
| Modal interaction | Artwork, Timeline/MPC, art picker and confirmation dialogs scroll and close correctly, returning focus to the launcher | Pending |
| Account and settings | Account/Invites, all Guide topics, Admin sections and Connections expand correctly at phone width in both themes | Pending |
| Print handling | Review/removal/filter/art selection, separate DFC indication, durable retry and exact-packet reload confirmation using fixtures only | Pending |
| Session continuity | Refresh, route return and per-user draft persistence without viewport or keyboard obstruction | Pending |

Do not replace these statuses with browser-emulation results. Any unsupported fixture
state must be stated explicitly and supplied before claiming that native case passed.
