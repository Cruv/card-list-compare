import { useState, useCallback } from 'react';
import './GuidePage.css';

const SECTIONS = [
  { key: 'getting-started', label: 'Getting Started' },
  { key: 'deck-comparison', label: 'Deck Comparison' },
  { key: 'importing-decks', label: 'Importing Decks' },
  { key: 'deck-library', label: 'Deck Library' },
  { key: 'deck-analytics', label: 'Deck Analytics' },
  { key: 'proxy-printing', label: 'Proxy Printing' },
  { key: 'export-formats', label: 'Export Formats' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'faq', label: 'FAQ' },
];

function GettingStarted() {
  return (
    <div className="guide-section">
      <h3>Getting Started</h3>
      <p>
        Card List Compare helps you compare MTG deck lists to see exactly what changed between
        two versions of a deck. Whether you're iterating on a Commander brew, tracking changes
        from a friend's Archidekt list, or preparing proxy prints for Tabletop Simulator, this
        tool gives you a clear visual diff.
      </p>

      <h4>Quick Start</h4>
      <ol className="guide-steps">
        <li>
          Paste your <strong>Before</strong> deck list into the left panel (or import from a URL).
        </li>
        <li>
          Paste your <strong>After</strong> deck list into the right panel.
        </li>
        <li>
          Click <strong>Compare Lists</strong> (or press <kbd className="guide-kbd">Ctrl+Enter</kbd>)
          to generate a changelog.
        </li>
      </ol>
      <p>
        The result shows a grouped changelog with cards added, removed, quantity changes, and
        printing swaps &mdash; organized by card type (Creatures, Instants, Sorceries, etc.).
      </p>

      <div className="guide-tip">
        <div className="guide-tip-label">Tip</div>
        <p>
          Create an account and track your decks in the <strong>Deck Library</strong> to
          automatically snapshot changes and compare versions over time &mdash; no need to
          manually paste lists each time.
        </p>
      </div>

      <h4>What You Can Do</h4>
      <ul>
        <li>Compare any two deck lists from any source</li>
        <li>Import directly from Archidekt, Moxfield, DeckCheck, TappedOut, and Deckstats URLs</li>
        <li>Track decks with automatic snapshot history and interactive timelines</li>
        <li>View deck analytics: mana curve, color distribution, price tracking, power level</li>
        <li>Generate proxy print files for MakePlayingCards (MPC)</li>
        <li>Export changelogs in multiple formats (Archidekt, Reddit, JSON, TTS, and more)</li>
        <li>Get card recommendations based on your deck's colors and strategy</li>
        <li>Share comparisons and tracked decks via public links</li>
      </ul>
    </div>
  );
}

function DeckComparison() {
  return (
    <div className="guide-section">
      <h3>Deck Comparison</h3>
      <p>
        The main comparison page has two input panels &mdash; <strong>Before</strong> and{' '}
        <strong>After</strong>. Each panel accepts deck text in multiple formats, or you can
        import directly from a URL.
      </p>

      <h4>Supported Text Formats</h4>
      <ul>
        <li><strong>Arena / MTGO export</strong> &mdash; standard export format from Magic clients</li>
        <li><strong>Plain text</strong> &mdash; <code>4 Lightning Bolt</code> or <code>4x Lightning Bolt</code></li>
        <li><strong>With set codes</strong> &mdash; <code>1 Lightning Bolt (M10)</code></li>
        <li><strong>With collector numbers</strong> &mdash; <code>1 Lightning Bolt (M10) [227]</code> or <code>1 Lightning Bolt (m10) 227</code></li>
        <li><strong>Foil markers</strong> &mdash; <code>1 Lightning Bolt (M10) [227] *F*</code></li>
        <li><strong>Sideboard</strong> &mdash; lines after a <code>Sideboard</code> header, or prefixed with <code>SB:</code></li>
        <li><strong>CSV</strong> &mdash; comma-separated values</li>
      </ul>

      <h4>Changelog Output</h4>
      <p>
        After comparing, the changelog groups results by card type: Creature, Instant, Sorcery,
        Artifact, Enchantment, Land, Planeswalker, Battle, and more. Each section shows cards
        that were added, removed, or changed in quantity.
      </p>
      <ul>
        <li><strong>Summary badges</strong> &mdash; quick counts of cards in, out, changed, and reprinted</li>
        <li><strong>Card image tooltips</strong> &mdash; hover any card name to see its Scryfall artwork (exact printing when metadata is available)</li>
        <li><strong>Mana cost symbols</strong> &mdash; official Scryfall SVG mana symbols displayed inline</li>
        <li><strong>Printing badges</strong> &mdash; set code, collector number, and foil marker shown after card names</li>
        <li><strong>Search filter</strong> &mdash; real-time card name filtering across all sections</li>
      </ul>

      <h4>Share a Comparison</h4>
      <p>
        Click <strong>Share</strong> in the export options to generate a permalink. Anyone with
        the link can view the comparison without logging in.
      </p>
    </div>
  );
}

function ImportingDecks() {
  return (
    <div className="guide-section">
      <h3>Importing Decks</h3>
      <p>
        Each input panel has a URL import button. Paste a deck URL and the app will fetch the
        full deck list with as much metadata as the source provides.
      </p>

      <h4>Supported Sources</h4>
      <ul>
        <li>
          <strong>Archidekt</strong> &mdash; full metadata: set codes, collector numbers, foil
          status. Best source for preserving specific printings and artwork.
        </li>
        <li>
          <strong>Moxfield</strong> &mdash; set codes, collector numbers, and foil/etched status.
          Metadata coverage shown after import.
        </li>
        <li>
          <strong>DeckCheck</strong> &mdash; card names and quantities (no printing metadata).
        </li>
        <li>
          <strong>TappedOut</strong> &mdash; card names and quantities.
        </li>
        <li>
          <strong>Deckstats</strong> &mdash; card names and quantities.
        </li>
      </ul>

      <h4>Metadata Coverage Feedback</h4>
      <p>
        After a URL import, you'll see a notification like{' '}
        <em>"Imported 97 cards from Moxfield &mdash; 95% with printing info"</em>. This tells
        you how many cards have full printing metadata (set code + collector number) preserved.
      </p>

      <h4>Cross-Source Carry-Forward</h4>
      <p>
        When comparing a metadata-rich source (like Archidekt) against a plain text source (like
        DeckCheck), the export will automatically inherit printing metadata from the richer side.
        This means you can compare any two sources and still get a metadata-rich export.
      </p>

      <div className="guide-tip">
        <div className="guide-tip-label">Tip</div>
        <p>
          For best results, import from <strong>Archidekt</strong> or <strong>Moxfield</strong> to
          preserve your specific artwork selections and foil choices.
        </p>
      </div>
    </div>
  );
}

function DeckLibrary() {
  return (
    <div className="guide-section">
      <h3>Deck Library</h3>
      <p>
        The Deck Library (accessible via the <strong>Decks</strong> button in the navigation bar)
        is where you track, organize, and analyze your decks. It requires a login.
      </p>

      <h4>Tracking Decks</h4>
      <ol className="guide-steps">
        <li>
          Go to the <strong>Deck Tracker</strong> tab and enter an Archidekt username.
        </li>
        <li>
          Browse their public decks and click <strong>Track</strong> on any deck you want to follow.
        </li>
        <li>
          The app takes a snapshot of the current deck state. Each time you refresh (or auto-refresh
          triggers), a new snapshot is created if the deck changed.
        </li>
      </ol>

      <h4>Deck Cards Grid</h4>
      <p>
        Tracked decks appear as cards in a responsive grid. Each card shows the deck name,
        commander(s), current price, tags, and when it was last updated.
      </p>
      <ul>
        <li><strong>Pin</strong> important decks to sort them to the top</li>
        <li><strong>Tags</strong> &mdash; add custom labels and filter the grid by tag</li>
        <li><strong>Search</strong> &mdash; filter by deck name across all owner groups</li>
        <li><strong>Owner groups</strong> &mdash; decks grouped by Archidekt username with collapsible sections</li>
      </ul>

      <h4>Individual Deck Pages</h4>
      <p>
        Click any deck card to open its full-page view with tabs:
      </p>
      <ul>
        <li><strong>Snapshots</strong> &mdash; history of all saved versions; lock, nickname, compare, or delete snapshots</li>
        <li><strong>Changelog</strong> &mdash; what changed between the latest two snapshots</li>
        <li><strong>Timeline</strong> &mdash; interactive visual history; click any entry to see the changes or full deck at that point</li>
        <li><strong>Full Deck</strong> &mdash; complete card list at the latest snapshot, grouped by type</li>
        <li><strong>Analytics</strong> &mdash; prices, mana curve, color distribution, power level, recommendations</li>
        <li><strong>Settings</strong> &mdash; deck configuration (commanders, webhook, price alerts, auto-refresh, sharing)</li>
      </ul>

      <h4>Snapshot Management</h4>
      <ul>
        <li><strong>Lock</strong> &mdash; protect important snapshots from auto-pruning (configurable limit, default 5 locked per deck)</li>
        <li><strong>Paper marker</strong> &mdash; mark a snapshot as your physical deck to compare it against the latest digital version</li>
        <li><strong>Nicknames</strong> &mdash; give snapshots custom names for easy reference</li>
        <li><strong>Compare</strong> &mdash; select any two snapshots to see a detailed diff in an overlay</li>
        <li><strong>Auto-pruning</strong> &mdash; oldest unlocked snapshots are automatically deleted when the count exceeds the limit (default 25 per deck)</li>
      </ul>

      <h4>Auto-Refresh</h4>
      <p>
        Set a per-deck refresh schedule (6h, 12h, or 24h) to automatically check Archidekt for
        changes. When a change is detected, a new snapshot is created. Combine with notifications
        to get alerted when your decks update.
      </p>

      <h4>Other Tabs</h4>
      <ul>
        <li><strong>Collection</strong> &mdash; manage your card collection for overlap analysis</li>
        <li><strong>Overlap</strong> &mdash; see how many cards are shared across all your tracked decks in a matrix view</li>
      </ul>
    </div>
  );
}

function DeckAnalytics() {
  return (
    <div className="guide-section">
      <h3>Deck Analytics</h3>
      <p>
        The Analytics tab on each deck page gives you insight into your deck's composition,
        power level, and cost.
      </p>

      <h4>Price Tracking</h4>
      <ul>
        <li><strong>Check Prices</strong> &mdash; fetch current prices from Scryfall with a per-card breakdown and total</li>
        <li><strong>Budget prices</strong> &mdash; see the cheapest printing total alongside your owned printing total, with the potential savings</li>
        <li><strong>Price history chart</strong> &mdash; a smooth SVG chart showing your deck's value over time across snapshots, with high/low/change stats</li>
        <li><strong>Price alerts</strong> &mdash; set a threshold and get notified when your deck's price crosses it</li>
        <li><strong>Price impact</strong> &mdash; changelogs show the cost impact of cards added, removed, and changed</li>
      </ul>

      <h4>Mana Curve &amp; Color Distribution</h4>
      <ul>
        <li><strong>Mana curve</strong> &mdash; bar chart of converted mana cost (CMC) distribution</li>
        <li><strong>Color distribution</strong> &mdash; breakdown of your deck's color identity with official Scryfall mana symbols</li>
        <li><strong>Card type breakdown</strong> &mdash; summary of creature, spell, land, and artifact counts</li>
        <li><strong>Mana curve delta</strong> &mdash; see how the mana curve changed between two snapshots in changelog views</li>
      </ul>

      <h4>Power Level</h4>
      <p>
        An automatic heuristic estimate on a 1&ndash;10 scale based on analysis of your deck's
        fast mana, tutors, free interaction, combo enablers, and mana curve. This is a rough
        guide, not a definitive rating &mdash; use it as a conversation starter for your playgroup.
      </p>
    </div>
  );
}

function ProxyPrinting() {
  return (
    <div className="guide-section">
      <h3>Proxy Printing</h3>
      <p>
        Card List Compare integrates with the MPC Autofill database to help you create
        high-quality proxy cards for personal use via MakePlayingCards.com.
      </p>

      <h4>MPC Autofill</h4>
      <p>
        From the <strong>Print Proxies</strong> tab on a deck page, the app searches the MPC
        Autofill database for proxy-quality artwork for every card in your deck. You can
        customize the search with filters:
      </p>
      <ul>
        <li><strong>DPI range</strong> &mdash; minimum image quality</li>
        <li><strong>Language</strong> &mdash; filter by card language</li>
        <li><strong>Source priority</strong> &mdash; prefer certain art sources</li>
        <li><strong>Tag filters</strong> &mdash; include or exclude tags (e.g., alternate art, borderless)</li>
        <li><strong>Fuzzy search</strong> &mdash; toggle looser name matching for cards with alternate spellings</li>
      </ul>

      <h4>Art Overrides</h4>
      <p>
        Click any card to search for alternative artwork and select your preferred printing.
        Your choices are saved per-deck and persist across sessions (synced to the server).
      </p>

      <h4>Export Options</h4>
      <ul>
        <li><strong>Download XML</strong> &mdash; for use with the MPC Autofill browser extension</li>
        <li><strong>Download ZIP</strong> &mdash; all selected card images in a ZIP archive</li>
        <li><strong>Cardstock selection</strong> &mdash; Standard Smooth, Superior Smooth, Smooth, Linen, or Plastic</li>
      </ul>

      <h4>Scryfall Image Downloads</h4>
      <p>
        You can also download a ZIP of all Scryfall card images for a deck. This runs as a
        background job with progress tracking &mdash; images are cached so re-downloads are fast.
      </p>

      <h4>Double-Faced Cards</h4>
      <p>
        Double-faced cards (DFCs) are automatically paired: both front and back face images are
        included in exports and downloads.
      </p>

      <div className="guide-tip">
        <div className="guide-tip-label">Tip</div>
        <p>
          You can also use <strong>Copy for MPCFill</strong> from any changelog to quickly grab
          just the new additions in MPC paste format.
        </p>
      </div>
    </div>
  );
}

function ExportFormats() {
  return (
    <div className="guide-section">
      <h3>Export Formats</h3>
      <p>
        After comparing two deck lists (or from a timeline overlay), you can export the results
        in several formats:
      </p>

      <ul>
        <li>
          <strong>Copy for Archidekt</strong> &mdash; Archidekt's native text format with full
          printing metadata: <code>1x Name (set) collectorNum *F* [Commander&#123;top&#125;]</code>.
          Paste directly into Archidekt's deck import.
        </li>
        <li>
          <strong>Copy Changelog</strong> &mdash; human-readable plain text diff summary.
        </li>
        <li>
          <strong>Copy for Reddit</strong> &mdash; formatted in Reddit markdown with bold headers
          and bullet points.
        </li>
        <li>
          <strong>Copy for MPCFill</strong> &mdash; MPC paste format for proxy printing the
          new additions from a changelog.
        </li>
        <li>
          <strong>Copy JSON</strong> &mdash; structured diff data as JSON for programmatic use
          or integration.
        </li>
        <li>
          <strong>Copy Deck Text</strong> &mdash; raw deck list from any snapshot, with printing
          metadata preserved.
        </li>
        <li>
          <strong>Download for TTS</strong> &mdash; Tabletop Simulator JSON import file with
          Scryfall images, proper zones (mainboard, sideboard), and commander placement.
        </li>
      </ul>

      <div className="guide-tip">
        <div className="guide-tip-label">Tip</div>
        <p>
          The Full Deck tab in the timeline overlay also has Copy for Archidekt and Copy Deck
          Text buttons, so you can export any historical version of your deck.
        </p>
      </div>
    </div>
  );
}

function Recommendations() {
  return (
    <div className="guide-section">
      <h3>Card Recommendations</h3>
      <p>
        The <strong>Suggest Cards</strong> feature analyzes your deck and recommends staple cards
        you might be missing, filtered by your deck's color identity.
      </p>

      <h4>Categories</h4>
      <p>Suggestions are organized by category:</p>
      <ul>
        <li><strong>Ramp</strong> &mdash; mana acceleration (Sol Ring, Arcane Signet, etc.)</li>
        <li><strong>Card Draw</strong> &mdash; card advantage engines</li>
        <li><strong>Removal</strong> &mdash; single-target interaction</li>
        <li><strong>Board Wipe</strong> &mdash; mass removal</li>
        <li><strong>Protection</strong> &mdash; counterspells and defensive pieces</li>
        <li><strong>Lands</strong> &mdash; utility and fixing lands</li>
        <li><strong>Recursion</strong> &mdash; graveyard recovery</li>
      </ul>
      <p>
        You can filter by category, search within suggestions, and see prices for each
        recommended card.
      </p>

      <h4>EDHREC Badges</h4>
      <ul>
        <li>
          <strong>BANNED</strong> (red badge) &mdash; cards on the Commander ban list. These are
          sorted to the bottom and shown at reduced opacity.
        </li>
        <li>
          <strong>Game Changer</strong> (gold badge) &mdash; high-impact staples identified by
          EDHREC as format-defining cards.
        </li>
      </ul>
    </div>
  );
}

function FAQ() {
  return (
    <div className="guide-section">
      <h3>Frequently Asked Questions</h3>

      <div className="guide-faq-item">
        <p className="guide-faq-q">How do I track a deck?</p>
        <p className="guide-faq-a">
          Go to the <strong>Decks</strong> page, enter an Archidekt username in the Deck Tracker
          tab, and click <strong>Track</strong> on any deck. The app will take an initial snapshot
          and track changes from that point.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">What is auto-pruning?</p>
        <p className="guide-faq-a">
          To prevent unlimited snapshot growth, the oldest unlocked snapshots are automatically
          deleted when a deck exceeds the snapshot limit (default: 25 per deck). Lock important
          snapshots to protect them from pruning. The limits are configurable by your admin.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">How does printing metadata work?</p>
        <p className="guide-faq-a">
          When you import from Archidekt or Moxfield, the app preserves set codes, collector
          numbers, and foil status for each card. This metadata travels through the entire
          import &rarr; diff &rarr; export pipeline, so you can export back to Archidekt without
          losing your specific artwork selections.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">Can I compare decks from different sources?</p>
        <p className="guide-faq-a">
          Yes. You can compare any two deck lists regardless of source. If one side has richer
          metadata (e.g., Archidekt with full printing info) and the other is plain text, the
          export will inherit metadata from the richer source via cross-source carry-forward.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">What's a paper snapshot?</p>
        <p className="guide-faq-a">
          You can mark any snapshot as your "paper" version &mdash; the physical deck you
          actually own. This makes it easy to compare your paper deck against the latest digital
          changes to see what you need to buy or swap.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">How do I share a tracked deck?</p>
        <p className="guide-faq-a">
          On any deck page, go to the <strong>Settings</strong> tab and click{' '}
          <strong>Share</strong>. This generates a public link that anyone can view without
          logging in, including snapshot comparison.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">What happens if I delete a snapshot?</p>
        <p className="guide-faq-a">
          Snapshot deletion is permanent. Locked snapshots cannot be deleted &mdash; you must
          unlock them first. The paper snapshot also cannot be deleted while it is marked as paper.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">How accurate are the prices?</p>
        <p className="guide-faq-a">
          Prices are sourced from Scryfall, which aggregates market data from TCGPlayer. They are
          fetched on demand when you click "Check Prices" or when auto-refresh runs. Prices
          reflect the specific printing you own (by set code and collector number) when that
          metadata is available.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">Can I use this without an account?</p>
        <p className="guide-faq-a">
          Yes. The main comparison page works without logging in &mdash; paste two lists and
          compare. An account is only needed for the Deck Library (tracking, snapshots, analytics,
          proxy printing) and personalized features.
        </p>
      </div>

      <div className="guide-faq-item">
        <p className="guide-faq-q">Is my data backed up?</p>
        <p className="guide-faq-a">
          All data is stored in a SQLite database in your configured data directory. Admins can
          download database backups from the Admin Dashboard. For self-hosted instances, you
          should also set up regular file-level backups of the data volume.
        </p>
      </div>
    </div>
  );
}

const SECTION_COMPONENTS = {
  'getting-started': GettingStarted,
  'deck-comparison': DeckComparison,
  'importing-decks': ImportingDecks,
  'deck-library': DeckLibrary,
  'deck-analytics': DeckAnalytics,
  'proxy-printing': ProxyPrinting,
  'export-formats': ExportFormats,
  'recommendations': Recommendations,
  'faq': FAQ,
};

export default function GuidePage() {
  const [activeSection, setActiveSection] = useState('getting-started');

  const handleBack = useCallback(() => {
    window.location.hash = '';
  }, []);

  const ContentComponent = SECTION_COMPONENTS[activeSection] || GettingStarted;

  return (
    <div className="guide-page">
      <aside className="guide-sidebar">
        <div className="guide-sidebar-header">
          <h2 className="guide-sidebar-title">Guide</h2>
          <button className="guide-back-link" onClick={handleBack} type="button">
            &larr; Back to Compare
          </button>
        </div>
        <nav className="guide-sidebar-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`guide-nav-item${activeSection === s.key ? ' guide-nav-item--active' : ''}`}
              onClick={() => setActiveSection(s.key)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="guide-content">
        <ContentComponent />
      </main>
    </div>
  );
}
