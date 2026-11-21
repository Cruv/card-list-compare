import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.env.CLC_PLAYWRIGHT_MODULE || 'playwright');

const dist = process.argv[2];
const baselineRun = process.argv.includes('--baseline');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const asset = pathname === '/' ? '/index.html' : pathname;
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(asset)];
    if (type) response.setHeader('Content-Type', type);
    response.end(await readFile(join(dist, asset)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const foil = '1 Sol Ring (C21) [263] *F*';
const etched = '1 Opt (ELD) [59] *E*';
const counterspell = '2 Counterspell (SLD) [DDO-20] *F* (Commander)';
const original = '// Keep this annotation  \r\nCommander\r\n1 Atraxa (2XM) [190]\r\n\r\nDeck\r\n' + foil + '\r\nMaybeboard\n1 Island\r\n';
const inTextarea = text => text.replace(/\r\n/g, '\n');

async function paste(input, marker, clipboard, { after = false, replace = false } = {}) {
  return input.evaluate((textarea, { marker, clipboard, after, replace }) => {
    const at = textarea.value.indexOf(marker);
    if (at < 0) throw new Error('Paste marker missing: ' + marker);
    const start = after ? at + marker.length : at;
    const end = replace ? start + marker.length : start;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const data = new DataTransfer();
    data.setData('text/plain', clipboard);
    const allowed = textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    // Use the browser's editing command for the default action of a synthetic
    // paste event. This exercises the native caret and undo without touching the OS clipboard.
    const insertion = clipboard.replace(/\r\n?/g, '\n');
    const draft = textarea.value.slice(0, start) + insertion + textarea.value.slice(end);
    if (allowed && !document.execCommand('insertText', false, insertion)) throw new Error('Browser did not insert pasted text');
    return { allowed, draft, caret: start + insertion.length };
  }, { marker, clipboard, after, replace });
}

try {
  await printDraftPaste();
  if (!baselineRun) {
    for (const lineBreak of ['\n', '\r\n']) {
      for (const [label, clipboard] of [
        ['exposed left edge', '*E*' + lineBreak],
        ['hidden right edge', lineBreak + etched],
        ['accepted card stranded inside foil', '*E*' + lineBreak + counterspell + lineBreak],
        ['rejected finish replacement', '*E*' + lineBreak],
        ['invalid row merged into foil', lineBreak + '0 '],
      ]) {
        await compareDraft(label, clipboard, lineBreak);
      }
    }

    await compareDraft('rejected edge leaves a suffix fragment', ' Island\n' + etched, '\n');
    await compareDraft('rejected edge leaves a prefix fragment', etched + '\nIsland ', '\n');
    // A rejected boundary row can be removed while a complete row still applies.
    await compareDraft('rejected row at the end of an intact card', ' *E*\r\n' + counterspell, '\r\n');
    // Selecting a complete printing intentionally replaces it while retaining surrounding text.
    await compareDraft('replace a whole card', counterspell + '\n' + etched, '\n');
    await libraryUndo();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

async function printDraftPaste() {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const initial = foil + '\n1 Plains';
  const clipboard = '\nSideboard\n1 Negate (M20) [69]\n0 Invalid';
  const expected = initial + '\nSideboard\n1 Negate (M20) [69]';
  try {
    await page.addInitScript(() => localStorage.setItem('clc-auth-token', 'fixture'));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 41, username: 'Fixture' } } });
      if (url.pathname === '/api/print-lists/jobs/activity') return route.fulfill({ json: {
        activeCount: 0, jobs: [], watchedJobs: [], watching: false,
        capabilities: { stationConfigured: false, printPresets: [] }, generator: { available: true },
      } });
      if (url.pathname === '/api/archidekt/decks/42/') return route.fulfill({ json: {
        cards: [{ quantity: 2, card: { oracleCard: { name: 'Forest' } } }],
      } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      return route.continue();
    });
    await page.goto(origin + '/#print-list');
    const input = page.getByRole('textbox', { name: 'Cards to print' });
    const preview = page.getByRole('region', { name: 'Preview cards to print import' });
    await input.fill(initial);
    const scrollY = await page.evaluate(() => window.scrollY);
    const first = await paste(input, '1 Plains', clipboard, { after: true });
    if (baselineRun) {
      assert.equal(first.allowed, false);
      assert.equal(await input.inputValue(), initial);
      await preview.waitFor();
      console.log('Chrome baseline: the Print textarea intercepted the paste and opened the review');
      return;
    }
    assert.equal(first.allowed, true);
    assert.equal(await input.inputValue(), first.draft);
    assert.deepEqual(await input.evaluate(el => ({ focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd })),
      { focused: true, start: first.caret, end: first.caret });
    assert.equal(await page.evaluate(() => window.scrollY), scrollY);
    assert.equal(await preview.count(), 0);
    await input.press('ControlOrMeta+z');
    assert.equal(await input.inputValue(), initial);

    await paste(input, '1 Plains', clipboard, { after: true });
    const review = page.getByRole('button', { name: 'Review import' });
    await review.click();
    await preview.getByText('Sideboard · M20 · #69 · Nonfoil', { exact: true }).waitFor();
    await preview.getByText('Mainboard · C21 · #263 · Foil', { exact: true }).waitFor();
    await preview.getByText('0 Invalid', { exact: true }).waitFor();
    await preview.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await input.inputValue(), first.draft);
    await review.click();
    await preview.getByRole('button', { name: 'Apply import' }).click();
    assert.equal(await input.inputValue(), expected);
    await page.getByRole('button', { name: 'Undo import' }).click();
    assert.equal(await input.inputValue(), initial);

    await paste(input, '1 Plains', clipboard, { after: true });
    for (let i = 0; i < '0 Invalid'.length; i++) await input.press('Backspace');
    await review.click();
    await preview.getByText('3 accepted rows · 3 copies · 0 skipped').waitFor();
    assert.equal(await input.inputValue(), expected + '\n');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await preview.getByRole('button', { name: 'Cancel' }).click();

    await page.locator('.deck-input input[type="file"]').setInputFiles({ name: 'cards.txt', mimeType: 'text/plain', buffer: Buffer.from('1 Island') });
    await preview.getByText('1× Island', { exact: true }).waitFor();
    await preview.getByRole('button', { name: 'Cancel' }).click();
    const urlPaste = await paste(input, '1 Plains', 'https://archidekt.com/decks/42', { replace: true });
    assert.equal(urlPaste.allowed, false);
    await page.getByRole('region', { name: 'Preview cards to print import from Archidekt' }).getByText('2× Forest', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), expected + '\n');
    console.log('Chrome paste: Print draft focus, scroll, native undo, explicit review, editing, and file and URL imports');
  } finally {
    await page.close();
  }
}

async function compareDraft(label, clipboard, lineBreak) {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const posts = [];
  const baseline = lineBreak === '\r\n' ? original : inTextarea(original);
  const safeAppend = label === 'rejected row at the end of an intact card';
  const safeReplace = label === 'replace a whole card';
  const suffixFragment = label.endsWith('suffix fragment');
  const prefixFragment = label.endsWith('prefix fragment');
  const changed = safeAppend || safeReplace;
  const expected = baseline.replace(foil, safeAppend ? foil + lineBreak + counterspell : safeReplace ? counterspell : foil);
  try {
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/share/paste-fixture') return route.fulfill({ json: { beforeText: baseline, afterText: '1 Lightning Bolt' } });
      if (url.pathname === '/api/share' && route.request().method() === 'POST') {
        posts.push(route.request().postDataJSON().beforeText);
        return route.fulfill({ json: { id: 'fixture-' + posts.length } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      return route.continue();
    });
    await page.goto(origin + '/#share/paste-fixture');
    const before = page.getByRole('textbox', { name: 'Before deck list' });
    const preview = page.getByRole('region', { name: 'Preview before import' });
    const undo = page.getByRole('button', { name: 'Undo import' });
    await before.waitFor();
    const reviewImport = page.locator('.deck-input').filter({ has: before }).getByRole('button', { name: 'Review import' });
    const edit = await paste(before, changed || suffixFragment || prefixFragment ? foil : '*F*', clipboard, {
      after: safeAppend || suffixFragment, replace: safeReplace || label === 'rejected finish replacement',
    });
    assert.equal(edit.allowed, true);
    assert.equal(await preview.count(), 0);
    assert.equal(await before.inputValue(), edit.draft, label);
    await reviewImport.click();
    await preview.getByText('Skipped rows', { exact: true }).waitFor();
    if (!label.includes('invalid row')) await preview.getByText(/Unsupported finish \(\*E\*\)/).first().waitFor();
    if (label.includes('stranded') || suffixFragment || prefixFragment) await preview.getByText(/Paste at a line boundary/).waitFor();
    if (!safeReplace) await preview.getByText('Mainboard · C21 · #263 · Foil', { exact: true }).waitFor();
    assert.equal(await preview.getByText('1× *F*', { exact: true }).count(), 0, label);
    assert.equal(await preview.getByText('2× Counterspell', { exact: true }).count(), Number(changed), label);
    if (changed) {
      await preview.getByText('Mainboard · SLD · #DDO-20 · Foil', { exact: true }).waitFor();
      await preview.getByText('Commanders · Atraxa').waitFor();
    }
    if (safeReplace) await preview.getByText('Replaced draft text').waitFor();
    assert.equal(await before.inputValue(), edit.draft, label);
    await preview.getByRole('button', { name: 'Apply import' }).click();
    assert.equal(await before.inputValue(), inTextarea(expected), label);
    await postComparison(page);
    assert.equal(posts.at(-1), expected, label);
    assert.equal(await undo.count(), Number(changed), label);

    if (safeAppend) {
      await paste(before, '*F*', lineBreak + etched);
      await reviewImport.click();
      await preview.getByText(/Unsupported finish \(\*E\*\)/).first().waitFor();
      await preview.getByRole('button', { name: 'Apply import' }).click();
      await postComparison(page, '1 Mountain');
      assert.equal(posts.at(-1), expected, 'The rejected paste leaves every byte in place');
      // Even a valid replacement that produces identical bytes leaves the previous Undo.
      await paste(before, foil, foil, { replace: true });
      await reviewImport.click();
      await preview.getByText('No changes to card counts or printings.').waitFor();
      await preview.getByRole('button', { name: 'Apply import' }).click();
    }
    if (changed) {
      await undo.click();
      await postComparison(page, '1 Forest');
      assert.equal(posts.at(-1), baseline, 'Undo restores the exact original bytes');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    console.log('Chrome paste:', label, JSON.stringify(lineBreak));
  } finally {
    await page.close();
  }
}

async function postComparison(page, afterText) {
  if (afterText) await page.getByRole('textbox', { name: 'After deck list' }).fill(afterText);
  await page.getByRole('button', { name: 'Compare Lists' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const response = page.waitForResponse(result => result.url().endsWith('/api/share') && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create share link' }).click();
  await response;
  await page.keyboard.press('Escape');
}

async function libraryUndo() {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  try {
    await page.addInitScript(() => localStorage.setItem('clc-auth-token', 'fixture'));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 41, username: 'Fixture' } } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { decks: [], owners: [], tags: [] } });
      return route.continue();
    });
    await page.goto(origin + '/#library');
    await page.getByRole('button', { name: 'Add decks' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add decks' });
    await dialog.getByRole('button', { name: 'Paste a list' }).click();
    const text = dialog.locator('textarea');
    const preview = dialog.getByRole('region', { name: 'Preview deck import' });
    await text.fill(foil);
    await paste(text, foil, '\n1 Island', { after: true });
    await preview.getByRole('button', { name: 'Apply import' }).click();
    await paste(text, '*F*', '*E*\n');
    await preview.getByText(/Unsupported finish \(\*E\*\)/).first().waitFor();
    await preview.getByRole('button', { name: 'Apply import' }).click();
    assert.equal(await text.inputValue(), foil + '\n1 Island');
    await dialog.getByRole('button', { name: 'Undo import' }).click();
    assert.equal(await text.inputValue(), foil);
    console.log('Chrome paste: library Undo after rejection');
  } finally {
    await page.close();
  }
}
