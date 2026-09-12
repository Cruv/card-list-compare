import { useEffect, useState } from 'react';
import './GuidePage.css';

const SECTIONS = [
  { key: 'getting-started', label: 'Start here', component: GettingStarted },
  { key: 'compare', label: 'Compare lists', component: CompareLists },
  { key: 'decks', label: 'Decks and changes', component: Decks },
  { key: 'printing', label: 'Print cards', component: Printing },
  { key: 'connections', label: 'Connect ManaSync', component: Connections },
  { key: 'account', label: 'Account and administration', component: Account },
  { key: 'reference', label: 'Formats and tools', component: Reference },
];
const LEGACY_TOPICS = {
  'deck-comparison': 'compare', 'importing-decks': 'reference', 'deck-library': 'decks',
  'deck-analytics': 'decks', 'proxy-printing': 'printing', 'export-formats': 'reference',
  recommendations: 'reference', faq: 'reference',
};
function topicFromHash() {
  const requested = window.location.hash.split('/')[1];
  const key = LEGACY_TOPICS[requested] || requested;
  return SECTIONS.some(section => section.key === key) ? key : 'getting-started';
}

function GettingStarted() {
  return <div className="guide-section">
    <h2>Start here</h2>
    <p>Choose a task. Compare works without an account; saved decks, connections and print batches require a login.</p>
    <div className="guide-task-links">
      <a href="#guide/compare"><strong>See what changed</strong><span>Compare two lists, copy the changes or print new copies.</span></a>
      <a href="#guide/decks"><strong>Keep a deck up to date</strong><span>Save versions and compare your paper deck with the latest list.</span></a>
      <a href="#guide/printing"><strong>Prepare a print batch</strong><span>Review artwork, make PDFs and follow the printer.</span></a>
      <a href="#guide/connections"><strong>Use your collection</strong><span>Connect ManaSync for ownership and missing originals.</span></a>
    </div>
    <h3>Find your way around</h3>
    <p>The main navigation is <strong>Compare</strong>, <strong>Decks</strong> and <strong>Print</strong>. Print has a new-list page and <strong>Printer</strong> controls. On a phone, <strong>More</strong> opens Connections, Guide and Account. Administration appears only for admins.</p>
    <h3>When you are offline</h3>
    <p>After an online visit finishes preparing the app, Compare and this Guide can reopen offline. Saved decks, URL imports, artwork, ownership and printing require a connection. A temporary connection failure preserves your login credential and saved print draft so you can reconnect.</p>
  </div>;
}

function CompareLists() {
  return <div className="guide-section">
    <h2>Compare lists</h2>
    <ol className="guide-steps">
      <li>Enter the older list in <strong>Before</strong> and the newer list in <strong>After</strong>. Paste text, choose <strong>Import URL</strong>, <strong>Load saved</strong> or <strong>Upload file</strong>.</li>
      <li>Choose <strong>Compare Lists</strong>, or press <kbd className="guide-kbd">Ctrl+Enter</kbd> / <kbd className="guide-kbd">⌘+Enter</kbd>.</li>
      <li>Review added, removed, changed quantities and printing swaps, grouped by card type. Search narrows the visible results. Hover or open a card to inspect its artwork and printing.</li>
    </ol>
    <p>CLC keeps the text used for the displayed comparison. Editing either input does not change its exports or print request until you compare again. Exact set, collector number and foil details are preserved when supplied; unavailable exact artwork does not silently become another printing.</p>
    <h3>Copy, print or share the result</h3>
    <p><strong>Copy changes</strong> copies the changelog. <strong>Print cards</strong> opens a review of new copies; you can choose the full After list instead. <strong>Export</strong> groups other copy formats, downloads and public sharing. A public comparison link can be opened without a login.</p>
    <p>The print handoff retains both compared lists. If you already have a print draft, choose whether to keep it or use the compared lists. The previous draft stays recoverable. An unresolved batch-creation request must be recovered before another list replaces it.</p>
    <h3>Save a version</h3>
    <p>When signed in, use the input’s <strong>Save version</strong> panel. An unchanged URL import can use its provider name automatically. <strong>Load saved</strong> only loads a version; rename, delete, lock and paper-marker actions live in the deck’s <strong>Changes</strong> tab.</p>
    <p>See <a href="#guide/reference">Formats and tools</a> for supported imports and printing metadata.</p>
  </div>;
}

function Decks() {
  return <div className="guide-section">
    <h2>Decks and changes</h2>
    <p>Open <a href="#library">Decks</a> to find your saved decks. Search, tags, pins and owner groups help organize them. <strong>Add decks</strong> starts with untracked decks from your configured Archidekt accounts. Choose <strong>Track deck</strong> beside a list to save it and check for future updates. Add another account inside the dialog, or use <strong>Manage sources</strong> in the library to manage existing accounts.</p>
    <p><strong>Paste a list</strong> saves a named manual deck with its exact card text. <strong>Import URL</strong> starts ongoing source tracking for Archidekt, Moxfield and DeckCheck. Other supported sites load a one-time list for you to name and save; they do not gain automatic updates. If a linked source cannot supply its first complete list, the saved deck shows that it is waiting for the source.</p>
    <p>Your unfinished list stays in this browser for your account. An uncertain save keeps its original request: use <strong>Retry saved import</strong> to confirm the same deck. A successful import offers <strong>Open deck</strong>. There is no Before/After comparison step when adding a deck.</p>
    <p><strong>Shared cards</strong> compares overlap between your decks; it does not represent inventory. <strong>Alert history</strong> keeps deck-change and price alerts.</p>
    <h3>One workspace per deck</h3>
    <ul>
      <li><strong>Cards</strong> opens by default and shows the latest saved list. Open <strong>Insights &amp; prices</strong> for analysis, price checks/history and card suggestions. Use <strong>Export</strong> for text, images or TTS; <strong>MPCFill artwork</strong> opens artwork selection and its XML/ZIP downloads. <strong>Ownership &amp; shopping</strong> checks ManaSync without changing the print list.</li>
      <li><strong>Changes</strong> compares <strong>Paper to latest</strong>, the <strong>Latest update</strong>, or any Before/After versions. <strong>Version history</strong> has one row per saved version. <strong>View version</strong> opens its Cards and Changes; <strong>Options</strong> contains naming, protection, paper-marker and deletion actions. <strong>Updates to review</strong> holds provider source updates and ManaSync proposals.</li>
      <li><strong>Print</strong> prepares a whole version or new copies between versions and keeps this deck’s batches together.</li>
      <li><strong>Settings</strong> contains automatic source checks, deck and price alerts, and public sharing. Commander names, tags, pinning and existing notes can be edited in the deck header from any tab.</li>
    </ul>
    <h3>Keep a useful version history</h3>
    <p>Use <strong>Name version</strong> for recognizable names and <strong>Protect version</strong> to keep important ones from cleanup. The <strong>paper marker</strong> identifies the list your physical deck currently matches; it protects that version from automatic pruning even when unlocked. Older unlocked versions without the paper marker can be pruned at the instance limit. Rename, remove and compare versions from Changes.</p>
    <h3>Review source updates and proposals</h3>
    <p>Changes from a tracked provider can be reviewed against local edits. The header’s <strong>Updates need your review</strong> link opens this section when a source or proposal needs attention. Review the source diff, keep local changes or accept/revise the candidate; do not treat a newer provider list as proof that local work should be overwritten. Source tracking shows its refresh status and any review required.</p>
    <p>ManaSync deck tokens can allow proposed edits. Open <strong>ManaSync proposals</strong> under Updates to review, inspect the before/after list and approve, revise or reject it. Approval and revision create a reviewed version; proposal drafts and uncertain requests retain their original identity for recovery. After a conflict, refresh and review the current base before deciding again.</p>
    <p>Shared decks are view-only and use the same <strong>Cards</strong> and <strong>Changes</strong> organization. Their history can open older saved cards; <strong>Back to latest</strong> returns to the current saved version. Printing copies the selected list into your own print workflow and does not edit the owner’s deck.</p>
    <h3>Insights and prices</h3>
    <p>The Cards view contains the current list estimate; the deck header does not repeat older saved prices. Charts summarize mana curve, color distribution and card types; comparisons include mana and color changes. <strong>Check prices</strong> shows selected-printing prices and a budget estimate, while <strong>Price history</strong> follows saved values. Deck Settings can notify you when value changes beyond your threshold. Price controls are shown only when pricing is enabled for this instance.</p>
    <p>Power estimates and card suggestions are aids for discussion, not a guarantee of a deck’s strength. Suggestions consider colors and strategy, with ramp, draw, removal, wipes, protection, lands and recursion. Commander ban and Game Changer badges highlight relevant cards.</p>
  </div>;
}

function Printing() {
  return <div className="guide-section">
    <h2>Print cards</h2>
    <p>Print has two destinations: <a href="#print-list">New print list</a> prepares a named standalone or comparison batch, and <a href="#print-station">Printer</a> brings batch history and printer controls together. You can also start from <strong>Print cards</strong> in a comparison or a saved deck’s <strong>Print</strong> tab. In each preparation workspace, <strong>Prepare</strong> holds your draft and review; <strong>Batches</strong> holds that account’s standalone batches or that deck’s batches. Switching views preserves the draft.</p>
    <ol className="guide-steps">
      <li><strong>Choose cards.</strong> Paste, upload or import a list. For a comparison, choose new copies or the full After list. For a tracked deck, choose the whole version or Before/After versions. Basic lands start excluded; sideboard inclusion and replacing copies for printing changes start off.</li>
      <li><strong>Review &amp; print.</strong> Choose Review print list. Check every quantity, printing and front/back preview. Open <strong>Edit selection</strong> to add extra cards, change options or restore removed suggestions. Use <strong>Pick art</strong> for another Scryfall edition or <strong>Use original art</strong> to undo that override.</li>
      <li><strong>Batch status.</strong> Choose <strong>Generate PDFs</strong> for downloads or <strong>Generate &amp; print</strong> for the household station. Follow the current batch, then find it again under Batches or on Printer.</li>
    </ol>
    <p>Artwork can use exact Scryfall printings or saved MPC artwork. Choose <strong>Save art for home PDFs</strong> in MPCFill artwork before selecting it as the source. Missing or unusable required faces must be resolved before generation. A double-faced card needs both selected faces.</p>
    <p><strong>Card entries</strong> and <strong>physical copies</strong> are different: one entry for 10 Plains represents 10 copies. Review shows the source counts, copies already covered by a comparison baseline, excluded basic lands and manual removals so you can explain the final total.</p>
    <h3>Edit a selection without losing track</h3>
    <p>Pasting or importing a replacement source list detaches an earlier comparison baseline and uses the whole replacement list. A deliberate Print cards handoff keeps the captured Before and After pair. Remove suggested copies, add extra card text and review again. Editing the source, quantities, options or artwork makes the previous review stale and disables generation and its buy list until refreshed. Search and <strong>Filters &amp; sort</strong> only change the view: hidden cards still belong to the PDF batch.</p>
    <p>With ManaSync connected, filter by ownership to find missing originals. <strong>Buy missing originals</strong> can copy the missing cards in the current view or open a Mana Pool review. CLC asks for one original per card, regardless of the number of proxy copies. Incoming originals count as owned; unavailable ownership stays Unknown. Opening a shopping review does not place an order.</p>
    <h3>Follow waiting and completed batches</h3>
    <p><strong>Printer → Print batches</strong> includes saved PDFs, preparation, waiting jobs, submitted passes and finished history from both decks and standalone lists. Admins can see all owners’ batches; other signed-in users see their own. Filter by status, choose Printer order or Newest first, and load more history as needed. Viewing a summary does not grant access to another owner’s private deck or PDF downloads.</p>
    <p><strong>Waiting in CLC</strong> means the batch is saved here and has not been sent to Epson. <strong>In the Epson queue</strong> identifies a pass already submitted to the Mac spooler. CLC keeps later batches waiting so manual double-faced packets stay in order. Spooler completed is a receipt, not approval of the physical output.</p>
    <p>Admins can choose <strong>Cancel waiting batch</strong> only before any pass has begun submission. If pages may already have been sent, use the Mac to check and reconcile that exact submission instead. Cancellation keeps the batch record and does not automatically retry it.</p>
    <p>You can prepare another list while earlier batches wait or print. Queued batches do not use the preparation allowance: each account can have two batches preparing PDFs, subject to shared preparation capacity and available storage. An unresolved request still needs its original receipt recovered before that draft is replaced; an uncertain printer submission needs reconciliation before further physical passes.</p>
    <h3>Recover an interrupted request</h3>
    <p>Generation captures a fixed plan, artwork and quantities. If creating the batch times out, choose <strong>Retry same request</strong> to recover it, including after a reload. Do not start another batch to recover the same submission. Batch details show errors and available downloads; a spooler receipt alone does not prove usable cards.</p>
    <h3>Double-faced sheets: reload one matching packet</h3>
    <p>The station prints the front of a packet and waits. Find the exact batch and packet named in the reload notice or flip alert. Remove unused blank paper from the rear feeder, then flip and reload <strong>only that packet’s printed sheet</strong> using your verified feed orientation. Older batches may describe a packet with more than one sheet; keep all of that matching packet together and follow its count.</p>
    <p>Choose <strong>Confirm this paper is reloaded</strong>, check the acknowledgement and choose <strong>Confirm and print this packet’s backs</strong>. Return blank paper after the backs finish. Never confirm another packet just because other printed fronts are nearby. Drying, lamination and cutting remain household tasks.</p>
    <h3>Printer controls and alerts</h3>
    <p><a href="#print-station">Printer</a> shows connection, health, the active batch and reload actions. The overview explains reported faults and unavailable status directly. Companion 2.53.3 or newer displays Epson's routine ink-tank reminder as information, separately from actual faults; it does not mean the ink is empty. Physical proof checks remain separate in Printer settings. Pausing stops new submissions; existing pages can keep printing. An uncertain submission requires reconciliation before another attempt, so it cannot silently print twice.</p>
    <p><strong>Printer settings</strong> groups Print recipe, Discord printer alerts and Companion updates. Admins can connect, save, explicitly test or disconnect Discord. Flip alerts identify the deck or list, batch and packet. Companion 2.53 or newer also checks the local printer queue about once a minute and alerts on reported paper, jam, offline, stopped or failed-pass conditions. New faults alert once per error episode; a healthy check permits alerts if the fault returns. Unknown status does not reset the episode. Two consecutive failed printer checks raise a separate status-unavailable alert without implying recovery. Alerts depend on what CUPS and the Epson driver report, and never pause, resume or retry printing. Proxy Balboa’s Discord pings lead with the real event, add a short Rocky-inspired line, then give plain details: printer, full batch ID, packet, sheet count, error and next action as applicable. Test sends a real notification. Update controls require a compatible managed companion and an idle station.</p>
    <p>Physical proof flags reflect tests the operator has actually approved. <strong>Test printing enabled</strong> means the Mac owner explicitly allows unverified recipes for testing; it does not mark front or duplex proofs as passed. Browser controls cannot change native printer options or those proof flags.</p>
    <h3>Record usable copies separately</h3>
    <p>PDF generation and printer completion do not add usable proxies to inventory. After checking the physical cards, use <strong>Confirm usable copies</strong> in CLC or ManaSync’s pending prints. Confirm the quantity that actually succeeded, including partial batches. Shared receipts prevent the same confirmation being counted twice.</p>
    <p><strong>Record a manual print</strong> prepares inventory records for printing done through another tool. It does not generate PDFs or send paper to the printer. Its <strong>Confirm printed quantity</strong> action records the usable physical result. See <a href="#guide/connections">Connect ManaSync</a> for collection access and reconciliation.</p>
  </div>;
}

function Connections() {
  return <div className="guide-section">
    <h2>Connect ManaSync</h2>
    <p><a href="#connections">Connections</a> has two independent directions. ManaSync manages collections, purchases and proxy inventory; CLC manages deck versions, artwork and print preparation.</p>
    <h3>Show your ManaSync collection in CLC</h3>
    <ol className="guide-steps">
      <li>Open ManaSync, then <strong>More → Integration access → Personal app tokens</strong>. Create a CLC token with collection-read and proxy-write permissions.</li>
      <li>In CLC Connections, paste it under <strong>ManaSync collection in CLC</strong> and choose <strong>Connect ManaSync</strong>. The default server is manasync.net; Other server is available for a different instance.</li>
      <li>Verify the displayed account. Use <strong>Check connection</strong> to check it again; <strong>Edit connection</strong> and <strong>Disconnect</strong> are beside it.</li>
    </ol>
    <p>One original in any printing permits any number of proxy copies. Incoming originals count too; owning only a proxy does not count as owning an original. Missing ownership is Unknown when a connection or lookup fails, so it is not automatically added to shopping.</p>
    <p>Confirmed proxy batches have fixed account and receipt identities. Changing connections does not move old batches to a new owner. If an inventory confirmation is uncertain, retry that operation; deliberate corrections use the shared confirmation history rather than a second print record.</p>
    <h3>Optionally show CLC decks in ManaSync</h3>
    <p>Open <strong>CLC decks in ManaSync</strong> in Connections. Active deck tokens appear first; revoke access there or create another token. Read access is included. <strong>Allow proposed edits</strong> lets ManaSync send changes for review in CLC. <strong>Allow new decks</strong> permits immediate creation of a new deck; it does not require a proposal review.</p>
    <p>Copy a new token when shown and enter it in ManaSync’s CLC connection. The secret is shown only once. Enabling collection access in the first direction does not grant either optional deck permission in the other direction.</p>
    <p>Printer Discord alerts are configured separately in <a href="#print-station">Printer → Printer settings</a>.</p>
  </div>;
}

function Account() {
  return <div className="guide-section">
    <h2>Account and administration</h2>
    <p><a href="#settings">Account</a> keeps your profile and email together. Save an email before verifying it; resend verification if needed. Open <strong>Security</strong> to change your password. If you cannot log in, request a reset from the login dialog.</p>
    <p><strong>My invitations</strong> appears for admins and users with invitation permission. Create a code with a use limit, copy it or remove it. Account deletion is a separate disclosure and requires typing your username; it permanently removes associated CLC data.</p>
    <h3>Administration</h3>
    <p>Only admins can open Administration or use its actions. Moving a control between sections does not grant access to other users.</p>
    <ul>
      <li><strong>Overview</strong>: current app counts, runtime status and recent activity.</li>
      <li><strong>Users</strong>: search, sort and export users. Open Manage for a user’s password/session controls, role and invitation access, suspension, unlock or deletion.</li>
      <li><strong>All invitations</strong>: review and remove codes across the instance. Create personal codes in Account → My invitations.</li>
      <li><strong>App settings</strong>: registration, price display, deck monitoring and version limits. Closed registration prevents new account registration.</li>
      <li><strong>Shared links</strong>: review and delete public comparison links.</li>
      <li><strong>Audit log</strong>: browse/filter activity and manage audit retention.</li>
      <li><strong>System</strong>: download a database backup, clean up expired verification/reset tokens and review emergency lockdown.</li>
    </ul>
    <p>Lockdown suspends non-admin accounts and invalidates their sessions. Restore each account from Users. Destructive actions retain their confirmation steps; deleting a user requires their username.</p>
  </div>;
}

function Reference() {
  return <div className="guide-section">
    <h2>Formats and tools</h2>
    <h3>Deck text</h3>
    <p>CLC accepts plain quantities, Arena/MTGO-style exports, supported CSV imports, set codes, collector numbers and foil markers. Use an explicit Sideboard header or SB: prefix; blank lines alone do not reliably identify a sideboard.</p>
    <pre>{'1 Sol Ring (CMM) [396]\n1 Delver of Secrets // Insectile Aberration (ISD) [51]\n1 Lightning Bolt (M10) [146] *F*\n\nSideboard\n1 Negate'}</pre>
    <p>Full double-faced names are supported. Supplying set and collector details keeps the intended printing distinct. Check metadata coverage feedback after imports. Name-only providers may need printing details carried forward from your saved version; review the result if multiple printings are possible.</p>
    <h3>URL imports</h3>
    <p>Archidekt and Moxfield provide printing metadata when available. DeckCheck, TappedOut and Deckstats commonly supply names and quantities. MTGGoldfish and TCGPlayer handlers are also available, but provider restrictions or login requirements may block an import. Use a text/file export when a site cannot be reached. Private provider pages require a supported accessible export.</p>
    <h3>Exports</h3>
    <ul>
      <li><strong>Copy changes</strong>: a readable changelog. Export also includes Reddit formatting, structured JSON and Archidekt text.</li>
      <li><strong>Deck text</strong>: the full saved list with printing metadata.</li>
      <li><strong>Copy for MPCFill</strong>: additions in MPC paste format.</li>
      <li><strong>TTS</strong>: a Tabletop Simulator deck file with resolved card images.</li>
      <li><strong>Image ZIPs</strong>: unique image files; repeated card quantities do not duplicate image files. Required DFC faces are included. Incomplete or legacy unverified image jobs need regeneration.</li>
    </ul>
    <h3>MPCFill artwork</h3>
    <p>Open MPCFill artwork from a deck’s Export menu. Browse card art with DPI, language, ordered sources, tags and fuzzy-search settings. Saved overrides preserve selected artwork; Reset Art clears those choices.</p>
    <p><strong>Download MPCFill XML</strong> prepares the desktop MPC Autofill workflow with the selected cardstock. Download ZIP gathers selected images. <strong>Save art for home PDFs</strong> makes a selection available to CLC print review. Neither XML nor an image ZIP automatically submits a home print job.</p>
    <h3>When a result looks wrong</h3>
    <ul>
      <li>Check whether both lists include quantities, sideboard markers and the intended printing details.</li>
      <li>Compare again after editing an input; a displayed comparison stays tied to its earlier text.</li>
      <li>Refresh the print review after changing artwork or selection. View filters never remove cards from the PDF.</li>
      <li>Retry an uncertain saved request using its recovery action. A new request can create another batch or record.</li>
      <li>Reconnect for private data, images and source imports. An offline shell does not cache collection or deck API responses.</li>
    </ul>
  </div>;
}

export default function GuidePage() {
  const [active, setActive] = useState(topicFromHash);
  useEffect(() => {
    const update = () => setActive(topicFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const Content = SECTIONS.find(section => section.key === active).component;
  return <div className="guide-page">
    <header className="page-heading"><h1>Guide</h1><p>Find the next step for the task you are working on.</p></header>
    <aside className="guide-sidebar">
      <nav className="guide-sidebar-nav" aria-label="Guide topics">
        {SECTIONS.map(section => <a key={section.key} href={`#guide/${section.key}`} className={`guide-nav-item${active === section.key ? ' guide-nav-item--active' : ''}`} aria-current={active === section.key ? 'page' : undefined}>{section.label}</a>)}
      </nav>
      <label className="guide-section-select">Guide topic<select value={active} onChange={event => { window.location.hash = `guide/${event.target.value}`; }}>{SECTIONS.map(section => <option key={section.key} value={section.key}>{section.label}</option>)}</select></label>
    </aside>
    <article className="guide-content" aria-live="polite"><Content /></article>
  </div>;
}
