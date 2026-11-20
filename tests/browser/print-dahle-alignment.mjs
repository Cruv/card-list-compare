import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.env.CLC_PLAYWRIGHT_MODULE || 'playwright');

const dist = process.argv[2];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? '/index.html' : pathname;
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)];
    if (type) response.setHeader('Content-Type', type);
    response.end(await readFile(join(dist, file)));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const capabilities = { canQueue: true, stationConfigured: true, paperSizes: ['letter'], printPresets: ['crowned-a4', 'dahle-a4-punch'] };
const generator = { available: true, revision: 'fixture-revision', adapterHash: 'fixture-adapter' };
const dahle = 'dahle-a4-punch';
const recipeId = 'household-dahle-a4-punch-v1';
const plainKey = '1'.repeat(64);
const markedKey = '2'.repeat(64);
const card = { selectionKey: 'sol-ring', displayName: 'Sol Ring', quantity: 2, baseQuantity: 2, setCode: 'c21', collectorNumber: '263' };
const frozenText = '2 Sol Ring (C21) [263]';
const resolvedCard = { ...card, isDFC: false, errors: [], faces: [{ face: 'front', status: 'ready', identifier: 'sol-ring-art' }] };
const snapshot = { id: 99, created_at: '2026-11-19T02:00:00Z', deck_text: frozenText };
const proofPath = `/api/print-proofs/${dahle}`;

try {
  for (const tracked of [false, true]) {
    const scope = tracked ? '/api/decks/12/print-jobs' : '/api/print-lists/jobs';
    const planPath = tracked ? '/api/decks/12/print-plan' : '/api/print-lists/plan';
    const jobId = tracked ? '22222222-4444-4444-8444-444444444444' : '11111111-4444-4444-8444-444444444444';
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: tracked ? { width: 1280, height: 900 } : { width: 390, height: 844 } });
    const proofs = [];
    const proofDownloads = [];
    const planRequests = [];
    const creates = [];
    const markedProof = Promise.withResolvers();
    const ready = Promise.withResolvers();
    let job;
    await page.addInitScript(() => {
      localStorage.setItem('clc-auth-token', 'print-alignment-fixture');
      localStorage.setItem('clc-print-paper-default:41', 'dahle-a4-punch');
    });
    try {
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const send = (json, status = 200) => route.fulfill({ status, json });
        if (url.pathname === '/api/auth/me') return send({ user: { id: 41, username: 'Alignment Fixture' } });
        if (url.pathname === '/api/decks/12') return send({ deck: { id: 12, deck_name: 'Tracked fixture', source_type: 'manual', commanders: '[]', tags: [] } });
        if (url.pathname === '/api/decks/12/snapshots') return send({ snapshots: [snapshot] });
        if (url.pathname === '/api/decks/12/snapshots/99') return send({ snapshot });
        if (url.pathname === '/api/scryfall/cards/collection') return send({ data: [], not_found: [] });
        if (url.pathname === '/api/manasync/print-queue') return send({ items: [] });
        if (url.pathname === `${scope}/activity`) {
          ready.resolve();
          return send({ activeCount: job ? 1 : 0, jobs: job ? [job] : [], watchedJobs: job ? [job] : [],
            watching: false, capabilities, generator, station: { online: true, loadedPaperSize: 'letter' } });
        }
        if (url.pathname === scope && request.method() === 'GET') return send({ jobs: job ? [job] : [], capabilities, generator });
        if (url.pathname === `${scope}/${jobId}` && request.method() === 'GET') return send({ job });
        if (url.pathname === planPath) {
          const body = request.postDataJSON();
          planRequests.push(body);
          const planHash = body.dahleCutGuides ? markedKey : plainKey;
          const plan = { ...body, deckName: 'Fixture cards', cards: [card], resolvedCards: [resolvedCard], ordinaryCopies: 2,
            doubleFacedCopies: 0, totalCopies: 2, readyToGenerate: true, planHash, ...(tracked ? { target: { id: 99 } } : {}) };
          return send({ plan, capabilities, generator });
        }
        if (url.pathname === scope && request.method() === 'POST') {
          const body = request.postDataJSON();
          creates.push(body);
          assert.equal(body.expectedPlanHash, markedKey);
          assert.equal(body.printPreset, dahle);
          assert.equal(body.dahleCutGuides, true);
          assert.equal(body.registrationMarks, false);
          assert.equal(body.queueOnReady, false);
          if (job) return send({ job, isExisting: true });
          job = { ...body, id: jobId, state: 'ready', mode: tracked ? 'full' : 'adhoc', deckName: 'Marked fixture batch',
            totalCopies: 2, artifacts: [], manifestSha256: 'a'.repeat(64), createdAt: '2026-11-19T03:00:00Z', updatedAt: '2026-11-19T03:01:00Z' };
          return tracked ? send({ job }, 202) : route.abort('failed');
        }
        if (url.pathname === proofPath || url.pathname === `${proofPath}/pdf`) {
          assert.equal(request.headers().authorization, 'Bearer print-alignment-fixture');
          assert.equal(url.searchParams.get('marks'), 'off');
          const marks = url.searchParams.get('dahleCutGuides');
          assert.ok(marks === null || marks === 'on');
          const key = marks ? markedKey : plainKey;
          if (url.pathname.endsWith('/pdf')) {
            assert.equal(url.searchParams.get('key'), key);
            proofDownloads.push(marks);
            return route.fulfill({ contentType: 'application/pdf', headers: { 'x-clc-proof-key': key }, body: '%PDF-1.4\n% Synthetic proof\n' });
          }
          proofs.push(marks);
          if (marks) await markedProof.promise;
          return send({ proof: { recipeId, key, ...generator, cardsPerSheet: 9, trim: [63, 88], bleed: { millimeters: 1 },
            registrationMarks: false, ...(marks ? { dahleCutGuides: true } : {}) } });
        }
        assert.equal(request.method(), 'GET', `Unexpected write to ${url.pathname}`);
        return send({});
      });

      await page.goto(origin + (tracked ? '/#library/12' : '/#print-list'));
      if (tracked) await page.getByRole('button', { name: 'Print', exact: true }).click();
      await ready.promise;
      const reviewList = page.getByRole('button', { name: 'Review print list', exact: true });
      const review = page.getByRole('region', { name: 'Print list review' });
      const marks = review.getByRole('checkbox', { name: 'Include strip cut lines and R3 corner guides', exact: true });
      const reviewUpdated = review.getByRole('button', { name: 'Review updated list' });
      const generate = review.getByRole('button', { name: 'Generate PDFs', exact: true });
      if (!tracked) {
        await checkProof(page);
        await page.getByRole('textbox', { name: 'Cards to print' }).fill(frozenText);
      }
      await reviewList.click();
      await marks.waitFor();
      assert.equal(await marks.isChecked(), false);
      assert.equal(await review.getByRole('checkbox', { name: /Cameo registration/ }).count(), 0);
      assert.equal(planRequests.at(-1).dahleCutGuides, undefined);
      await marks.check();
      await reviewUpdated.waitFor();
      assert.equal(await generate.count(), 0);

      if (!tracked) {
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('clc-print-list-draft:41'))?.dahleCutGuides === true);
        await page.reload();
        await reviewList.click();
        await marks.waitFor();
        assert.equal(await marks.isChecked(), true);
      } else await reviewUpdated.click();
      await review.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
      assert.equal(planRequests.at(-1).dahleCutGuides, true);
      assert.equal(await review.getByRole('button', { name: 'Generate & print' }).count(), 0);
      await generate.click();
      if (!tracked) {
        await page.getByRole('alert').getByText(/Network error/).waitFor();
        await page.reload();
        const retry = page.getByRole('region', { name: 'Recover print batch request' });
        await retry.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
        await retry.getByRole('button', { name: 'Retry same batch request' }).click();
      }
      const current = page.getByRole('region', { name: 'Current print batch' });
      await current.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
      assert.equal(await current.getByRole('button', { name: 'Send to Mac' }).count(), 0);
      assert.equal(creates.length, tracked ? 1 : 2);
      if (!tracked) assert.deepEqual(creates[0], creates[1]);
      console.log(`${tracked ? 'Tracked' : 'Standalone'} Chrome: a marked Dahle review generated PDFs only with its new hash.${tracked ? '' : ' The draft and exact lost-response request survived reloads.'}`);

      async function checkProof(page) {
        await page.getByText('One-sheet paper proof', { exact: true }).click();
        const proof = page.locator('.print-paper-proof');
        const toggle = proof.getByRole('checkbox', { name: 'Include strip cut lines and R3 corner guides on the proof' });
        const confirm = proof.getByRole('checkbox', { name: 'I printed and checked this exact recipe' });
        const download = proof.getByRole('button', { name: 'Download one-sheet proof PDF' });
        await proof.getByText(/Dahle row ticks · 63/).waitFor();
        assert.equal(await toggle.isChecked(), false);
        const downloadingPlain = page.waitForEvent('download');
        await download.click();
        assert.match((await downloadingPlain).suggestedFilename(), /-no-marks-/);
        await confirm.check();
        await toggle.check();
        await proof.getByText('Loading proof recipe…').waitFor();
        assert.equal(await confirm.count(), 0);
        markedProof.resolve();
        await proof.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
        await proof.getByText('Cut 210 × 90 mm strips on the Dahle using the horizontal black cut lines.', { exact: true }).waitFor();
        await proof.getByText(/Feed each strip into the 63 × 88 mm R3 punch.*four lime corner guides/).waitFor();
        assert.equal(await confirm.isChecked(), false);
        assert.equal(await confirm.isDisabled(), true);
        const downloadingMarked = page.waitForEvent('download');
        await download.click();
        assert.match((await downloadingMarked).suggestedFilename(), /-dahle-cut-guides-/);
        await confirm.check();
        await toggle.uncheck();
        await proof.getByText(/Dahle row ticks · 63/).waitFor();
        assert.equal(await confirm.isChecked(), true);
        assert.deepEqual(proofs, [null, 'on', null]);
        assert.deepEqual(proofDownloads, [null, 'on']);
        await page.getByText('One-sheet paper proof', { exact: true }).click();
        console.log('Chrome kept marked and plain Dahle proof keys, filenames, download queries, and proof checks separate.');
      }
    } finally { markedProof.resolve(); await page.close(); }
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
