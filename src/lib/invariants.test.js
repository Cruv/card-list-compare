// Invariant-sync tests — executable enforcement of repo-wide couplings.
//
// These tests are the NORMATIVE home for the invariants they cover.
// docs/INVARIANTS.md and CLAUDE.md point here; if a test in this file fails,
// the fix is to restore the coupling it guards (or consciously update BOTH
// the code and the pinned expectation), never to delete the test.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CARD_LINE_PATTERN, LINE_PATTERNS } from './constants.js';
import { parse } from './parser.js';
import { _archidektToText } from './fetcher.js';
import { archidektToText as serverArchidektToText } from '../../server/lib/deckToText.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Invariant: card-line pattern is single-sourced
// ---------------------------------------------------------------------------
// CARD_LINE_PATTERN in constants.js is the ONLY card-line regex. It drifted
// into forked copies twice before (server/lib/enrichDeckText.js, fixed
// v2.40.2; server/routes/collection.js, fixed v2.40.1) — both corrupted or
// mis-read user data. These tests guard against a third fork and pin the
// pattern's behavior so edits show exactly what changed.

const captures = (line) => {
  const m = line.match(CARD_LINE_PATTERN);
  return m && { qty: m[1], name: m[2], set: m[3] || '', cn: m[4] || m[5] || '', foil: !!m[6] };
};

describe('invariant: card-line pattern single source', () => {
  it('LINE_PATTERNS[0] is CARD_LINE_PATTERN (same object)', () => {
    expect(LINE_PATTERNS[0]).toBe(CARD_LINE_PATTERN);
  });

  it('enrichDeckText consumes the shared pattern and declares no local fork', () => {
    const src = read('server/lib/enrichDeckText.js');
    expect(src.includes('CARD_LINE_PATTERN'), 'enrichDeckText.js must import CARD_LINE_PATTERN from src/lib/constants.js').toBe(true);
    expect(/CARD_LINE_RE\s*=/.test(src), 'enrichDeckText.js declares a local card-line regex — use the shared CARD_LINE_PATTERN instead').toBe(false);
  });

  it('no other server file declares a card-line-shaped regex', () => {
    // The corruption signature of past forks: a regex literal matching a
    // leading quantity capture followed by a lazy name capture.
    for (const file of ['server/routes/collection.js', 'server/lib/deckToText.js']) {
      expect(
        /\/\^\(\\d\+\)/.test(read(file)),
        `${file} declares a quantity-leading regex literal — card lines must go through the shared parser/pattern`
      ).toBe(false);
    }
  });

  // Behavior pins for the canonical corpus (subset of the examples in
  // docs/DECK_TEXT_FORMAT.md). Any pattern edit must consciously update these.
  it.each([
    ['4 Lightning Bolt', { qty: '4', name: 'Lightning Bolt', set: '', cn: '', foil: false }],
    ['4x Lightning Bolt', { qty: '4', name: 'Lightning Bolt', set: '', cn: '', foil: false }],
    ['1 Snapcaster Mage (UMA) [63]', { qty: '1', name: 'Snapcaster Mage', set: 'UMA', cn: '63', foil: false }],
    ['1 Nazgul (ltr) [336p]', { qty: '1', name: 'Nazgul', set: 'ltr', cn: '336p', foil: false }],
    ['1 Sol Ring (c21) [263] *F*', { qty: '1', name: 'Sol Ring', set: 'c21', cn: '263', foil: true }],
    ['1 Sol Ring (c21) *F*', { qty: '1', name: 'Sol Ring', set: 'c21', cn: '', foil: true }],
    ['1 Sol Ring *F*', { qty: '1', name: 'Sol Ring', set: '', cn: '', foil: true }],
    ['1 Sword of Dungeons // Dragons (H17) [DDO-20]', { qty: '1', name: 'Sword of Dungeons // Dragons', set: 'H17', cn: 'DDO-20', foil: false }],
    ['10 Island', { qty: '10', name: 'Island', set: '', cn: '', foil: false }],
    // Formerly-divergent inputs, now unified (v2.40.2):
    ['2 Atraxa (C20) 215 *F*', { qty: '2', name: 'Atraxa', set: 'C20', cn: '215', foil: true }],
    ['1 Nazgul [336p]', { qty: '1', name: 'Nazgul [336p]', set: '', cn: '', foil: false }],
  ])('pins behavior for %j', (line, expected) => {
    expect(captures(line)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Invariant: the Dockerfile ships every src/lib file the server imports
// ---------------------------------------------------------------------------
// The production image copies a hardcoded list of shared lib files (Dockerfile
// "COPY src/lib/..."). A server-side import of a src/lib file that is missing
// from that list works in dev and crashes the Docker image at startup.
describe('invariant: Dockerfile COPY list covers server imports of src/lib', () => {
  // Catches `from '../../src/lib/x.js'`, dynamic `import('../src/lib/x.js')`
  // (server/db.js uses one), and side-effect `import '../src/lib/x.js'`.
  const IMPORT_RE = /(?:from|import\s*\(?)\s*['"](?:\.\/)?(?:\.\.\/)+src\/lib\/([\w.-]+\.m?js)['"]/g;
  // Local imports inside src/lib. Deliberately broad: captures the whole
  // specifier so subdirectory / extensionless imports can be rejected below.
  const LOCAL_RE = /(?:from|import\s*\(?)\s*['"](\.\/[\w./-]+)['"]/g;

  function serverJsFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'data') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) serverJsFiles(p, out);
      else if (/\.m?js$/.test(name) && !/\.test\.m?js$/.test(name)) out.push(p);
    }
    return out;
  }

  it('no server file imports src/lib via a template literal (invisible to this scan)', () => {
    for (const f of serverJsFiles(join(ROOT, 'server'))) {
      expect(
        /import\(\s*`[^`]*src\/lib/.test(readFileSync(f, 'utf8')),
        `${f} imports src/lib via a template literal — use a static string so the Dockerfile COPY test can see it`
      ).toBe(false);
    }
  });

  it('every imported file (transitively) appears in a COPY instruction', () => {
    // Only COPY instructions count — a comment mentioning a file must not
    // satisfy the check. A whole-directory copy (COPY src/lib/ ...) ships
    // everything and short-circuits the per-file assertion.
    const copyLines = read('Dockerfile')
      .split(/\r?\n/)
      .filter((l) => /^\s*COPY\s/.test(l));
    if (copyLines.some((l) => /COPY\s+src\/lib\/?\s/.test(l))) return; // dir copy ships all
    const copied = new Set(
      copyLines.flatMap((l) => [...l.matchAll(/src\/lib\/([\w.-]+\.m?js)/g)].map((m) => m[1]))
    );

    const needed = new Set();
    for (const f of serverJsFiles(join(ROOT, 'server'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(IMPORT_RE)) needed.add(m[1]);
    }
    // Transitive closure inside src/lib (e.g. parser.js itself imports
    // constants.js). src/lib must stay flat and fully-extensioned for the
    // flat COPY to work — reject subdir/extensionless specifiers loudly.
    const queue = [...needed];
    while (queue.length) {
      const src = read(join('src/lib', queue.pop()));
      for (const m of src.matchAll(LOCAL_RE)) {
        const spec = m[1].slice(2); // strip './'
        expect(
          /^[\w.-]+\.m?js$/.test(spec),
          `src/lib import "./${spec}" is a subdirectory or extensionless import — src/lib must stay flat and fully-extensioned or the Dockerfile flat COPY breaks in production only`
        ).toBe(true);
        if (!needed.has(spec)) {
          needed.add(spec);
          queue.push(spec);
        }
      }
    }

    expect(needed.size, 'expected the server to import at least one src/lib file').toBeGreaterThan(0);
    for (const file of needed) {
      expect(
        copied,
        `server imports src/lib/${file} but no Dockerfile COPY instruction ships it — production will crash while dev works`
      ).toContain(file);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: parser entry contract
// ---------------------------------------------------------------------------
// Server routes and formatters have shipped bugs by assuming `entry.name` or
// treating parsed.commanders as objects. This pins the actual shape.
describe('invariant: parser entry contract', () => {
  const FIXTURE = [
    'Commander',
    "1 Atraxa, Praetors' Voice (c16) [28] *F*",
    '',
    '4 Lightning Bolt (m10) [146]',
    '10 Island',
    '',
    'Sideboard',
    '2 Fatal Push (2xm) [69]',
  ].join('\n');

  it('entries expose exactly displayName/quantity/setCode/collectorNumber/isFoil', () => {
    const parsed = parse(FIXTURE);
    const allEntries = [...parsed.mainboard.values(), ...parsed.sideboard.values()];
    expect(allEntries.length).toBeGreaterThan(0);
    for (const entry of allEntries) {
      expect(Object.keys(entry).sort()).toEqual([
        'collectorNumber',
        'displayName',
        'isFoil',
        'quantity',
        'setCode',
      ]);
      expect(entry).not.toHaveProperty('name');
    }
  });

  it('parsed.commanders is a flat array of display-name strings', () => {
    const parsed = parse(FIXTURE);
    expect(parsed.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    for (const c of parsed.commanders) expect(typeof c).toBe('string');
  });

  it('map keys are lowercase name, or lowercase name|collectorNumber when present', () => {
    const parsed = parse(FIXTURE);
    expect(parsed.mainboard.has('lightning bolt|146')).toBe(true);
    expect(parsed.mainboard.has('island')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant: archidektToText mirror (client fetcher.js vs server deckToText.js)
// ---------------------------------------------------------------------------
// The client version additionally returns stats; text and commanders must be
// identical. If this fails, one side of the mirror changed without the other.
describe('invariant: archidektToText client/server mirror', () => {
  const ARCHIDEKT_FIXTURE = {
    cards: [
      {
        card: {
          oracleCard: { name: "Atraxa, Praetors' Voice" },
          edition: { editioncode: 'c16' },
          collectorNumber: '28',
        },
        quantity: 1,
        modifier: 'Foil',
        categories: ['Commander'],
      },
      {
        card: { name: 'Lightning Bolt', edition: { editioncode: 'm10' }, collectorNumber: '146' },
        quantity: 4,
        modifier: 'Normal',
        categories: [{ name: 'Instants' }],
      },
      {
        card: { name: 'Fatal Push', edition: { editioncode: '2xm' }, collectorNumber: '69' },
        quantity: 2,
        categories: ['Sideboard'],
      },
      { card: { name: 'Skipped Maybe' }, quantity: 1, categories: ['Maybeboard'] },
      { card: { name: 'Skipped Considering' }, quantity: 1, categories: [{ name: 'Considering' }] },
      // Multi-category cards: maybeboard/considering must win over board
      // categories on BOTH sides (category-dispatch ORDER is part of the
      // mirror — this drifted once and produced different deck text).
      { card: { name: 'Maybe Commander' }, quantity: 1, categories: ['Commander', 'Maybeboard'] },
      { card: { name: 'Considering Sideboard' }, quantity: 1, categories: ['Sideboard', 'Considering'] },
      { card: { name: 'Island' }, quantity: 10, categories: [] },
      { card: { name: 'No Category Card' }, quantity: 1 },
    ],
  };

  it('produces identical text and commanders on both sides', () => {
    const client = _archidektToText(ARCHIDEKT_FIXTURE);
    const server = serverArchidektToText(ARCHIDEKT_FIXTURE);
    expect(server.text).toEqual(client.text);
    expect(server.commanders).toEqual(client.commanders);
  });

  it('maybeboard wins over board categories on both sides', () => {
    const client = _archidektToText(ARCHIDEKT_FIXTURE);
    const server = serverArchidektToText(ARCHIDEKT_FIXTURE);
    for (const out of [client, server]) {
      expect(out.text).not.toContain('Maybe Commander');
      expect(out.text).not.toContain('Considering Sideboard');
      expect(out.commanders).not.toContain('Maybe Commander');
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: version bookkeeping
// ---------------------------------------------------------------------------
function getAppVersion(appSrc) {
  const m = appSrc.match(/^const APP_VERSION = '(\d+\.\d+\.\d+)';$/m);
  expect(m, "src/App.jsx must declare: const APP_VERSION = 'X.Y.Z'; (single quotes, plain semver)").toBeTruthy();
  return m[1];
}

describe('invariant: version bookkeeping', () => {
  const appSrc = read('src/App.jsx');

  it('APP_VERSION is a semver string', () => {
    getAppVersion(appSrc);
  });

  it('WHATS_NEW has at least one non-empty entry', () => {
    const m = appSrc.match(/const WHATS_NEW = \[([\s\S]*?)\];/);
    expect(m, 'src/App.jsx must declare a WHATS_NEW array').toBeTruthy();
    // Strip comments so a fully commented-out array cannot pass as populated.
    const body = m[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const entries = [...body.matchAll(/'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)"|`((?:[^`\\]|\\.)+)`/g)];
    expect(entries.length, 'WHATS_NEW must contain at least one non-comment entry').toBeGreaterThan(0);
  });

  it('package.json version matches APP_VERSION (release skill syncs them)', () => {
    const appVersion = getAppVersion(appSrc);
    const pkg = JSON.parse(read('package.json'));
    expect(
      pkg.version,
      'package.json version must equal APP_VERSION — run: npm version <APP_VERSION> --no-git-tag-version --allow-same-version'
    ).toBe(appVersion);
  });
});

// ---------------------------------------------------------------------------
// Invariant: differ pipeline order (DFC normalization before name indexing)
// ---------------------------------------------------------------------------
// normalizeDFCKeys() must run before buildNameIndex()/composite remapping in
// diffSection(); reordering silently breaks double-faced-card matching while
// simple-deck tests keep passing. Cheap source-order tripwire.
describe('invariant: differ pipeline order', () => {
  it('diffSection calls normalizeDFCKeys before buildNameIndex', () => {
    const src = read('src/lib/differ.js');
    const bodyStart = src.indexOf('function diffSection');
    expect(bodyStart).toBeGreaterThan(-1);
    // Bound the search to diffSection's body (up to the next top-level
    // function) and ignore comment lines so prose can't satisfy the check.
    const nextFn = src.indexOf('\nfunction ', bodyStart + 1);
    const body = src
      .slice(bodyStart, nextFn === -1 ? undefined : nextFn)
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    const dfc = body.indexOf('normalizeDFCKeys(');
    const index = body.indexOf('buildNameIndex(');
    expect(dfc, 'diffSection() must call normalizeDFCKeys()').toBeGreaterThan(-1);
    expect(index, 'diffSection() must call buildNameIndex()').toBeGreaterThan(-1);
    expect(dfc, 'normalizeDFCKeys() must run BEFORE buildNameIndex() in diffSection()').toBeLessThan(index);
  });
});

// ---------------------------------------------------------------------------
// Invariant: docs/INVARIANTS.md anchors still exist
// ---------------------------------------------------------------------------
// docs/INVARIANTS.md references code by symbol name, not line number. This
// table mirrors those anchors; when a symbol is renamed or removed, this test
// fails and the doc must be updated in the same change. Word-boundary matched
// so a rename to a longer identifier (run -> runQuery) cannot false-pass.
describe('invariant: docs/INVARIANTS.md content anchors resolve', () => {
  const ANCHORS = [
    ['src/lib/constants.js', 'LINE_PATTERNS'],
    ['src/lib/constants.js', 'CARD_LINE_PATTERN'],
    ['server/lib/enrichDeckText.js', 'CARD_LINE_PATTERN'],
    ['server/lib/enrichDeckText.js', 'buildMetadataLookup'],
    ['src/lib/parser.js', 'cardKey'],
    ['src/lib/parser.js', 'displayName'],
    ['src/lib/differ.js', 'normalizeDFCKeys'],
    ['src/lib/differ.js', 'buildNameIndex'],
    ['src/lib/differ.js', 'collapseCompositeKeys'],
    ['src/lib/scryfall.js', 'collectCardIdentifiers'],
    ['src/lib/fetcher.js', 'archidektToText'],
    ['server/lib/deckToText.js', 'archidektToText'],
    ['server/db.js', 'export function persist'],
    ['server/db.js', 'export function run'],
    ['server/middleware/auth.js', 'invalidateAuthCache'],
    ['server/middleware/auth.js', 'invalidateAllAuthCache'],
    ['server/middleware/auth.js', 'password_changed_at'],
    ['src/App.jsx', 'APP_VERSION'],
    ['src/App.jsx', 'WHATS_NEW'],
    ['src/components/GuidePage.jsx', 'SECTIONS'],
  ];

  it.each(ANCHORS)('%s still contains "%s"', (file, symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(
      new RegExp(`\\b${escaped}\\b`).test(read(file)),
      `docs/INVARIANTS.md cites "${symbol}" in ${file} — the symbol moved or was renamed; update the doc and this anchor table together`
    ).toBe(true);
  });
});
