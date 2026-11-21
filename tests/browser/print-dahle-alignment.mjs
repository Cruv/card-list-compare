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
const a4Preset = 'dahle-a4-punch';
const letterPreset = 'dahle-letter-punch';
const capabilities = { canQueue: true, stationConfigured: true, paperSizes: ['letter'], printPresets: ['crowned-a4', a4Preset, letterPreset],
  foilProfiles: ['rainbow-v1', 'surge-v1'] };
const generator = { available: true, revision: 'fixture-revision', adapterHash: 'fixture-adapter' };
const plainKey = '1'.repeat(64);
const markedKey = '2'.repeat(64);
const legacyKey = '3'.repeat(64);
const foilKey = '4'.repeat(64);
const card = { selectionKey: 'sol-ring', displayName: 'Sol Ring', quantity: 2, baseQuantity: 2, setCode: 'c21', collectorNumber: '263' };
const frozenText = '2 Sol Ring (C21) [263]';
const resolvedCard = { ...card, isDFC: false, errors: [], faces: [{ face: 'front', status: 'ready', identifier: 'sol-ring-art' }] };
const snapshot = { id: 99, created_at: '2026-11-19T02:00:00Z', deck_text: frozenText };
const proofPath = '/api/print-proofs/';

try {
  for (const tracked of [false, true]) {
    const dahle = tracked ? a4Preset : letterPreset;
    const paperSize = tracked ? 'a4' : 'letter';
    const stripSize = `${tracked ? 210 : 215.9} × 91 mm`;
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
    let activityDelay;
    let offeredFoilProfiles = capabilities.foilProfiles;
    let job;
    let legacyProof = false;
    await page.addInitScript(defaultPreset => {
      localStorage.setItem('clc-auth-token', 'print-alignment-fixture');
      localStorage.setItem('clc-print-paper-default:41', defaultPreset);
    }, dahle);
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
        const currentCapabilities = { ...capabilities, foilProfiles: offeredFoilProfiles };
        if (url.pathname === `${scope}/activity`) {
          ready.resolve();
          if (activityDelay) await activityDelay.promise;
          return send({ activeCount: job ? 1 : 0, jobs: job ? [job] : [], watchedJobs: job ? [job] : [],
            watching: false, capabilities: currentCapabilities, generator, station: { online: true, loadedPaperSize: 'letter' } });
        }
        if (url.pathname === scope && request.method() === 'GET') return send({ jobs: job ? [job] : [], capabilities: currentCapabilities, generator });
        if (url.pathname === `${scope}/${jobId}` && request.method() === 'GET') return send({ job });
        if (url.pathname === planPath) {
          const body = request.postDataJSON();
          assert.equal(body.paperSize, paperSize);
          assert.equal(body.printPreset, dahle);
          planRequests.push(body);
          const planHash = body.foilProfile ? foilKey : body.dahleCutGuides ? markedKey : plainKey;
          const plan = { ...body, deckName: 'Fixture cards', cards: [card], resolvedCards: [resolvedCard], ordinaryCopies: 2,
            doubleFacedCopies: 0, totalCopies: 2, readyToGenerate: true, planHash, ...(tracked ? { target: { id: 99 } } : {}) };
          return send({ plan, capabilities: currentCapabilities, generator });
        }
        if (url.pathname === scope && request.method() === 'POST') {
          const body = request.postDataJSON();
          creates.push(body);
          assert.equal(body.expectedPlanHash, tracked ? markedKey : foilKey);
          assert.equal(body.printPreset, dahle);
          assert.equal(body.paperSize, paperSize);
          assert.equal(body.dahleCutGuides, true);
          assert.equal(body.foilProfile, tracked ? undefined : 'rainbow-v1');
          assert.equal(body.registrationMarks, false);
          assert.equal(body.queueOnReady, false);
          if (job) return send({ job, isExisting: true });
          job = { ...body, id: jobId, state: 'ready', mode: tracked ? 'full' : 'adhoc', deckName: 'Marked fixture batch',
            totalCopies: 2, artifacts: [], manifestSha256: 'a'.repeat(64), createdAt: '2026-11-19T03:00:00Z', updatedAt: '2026-11-19T03:01:00Z' };
          return tracked ? send({ job }, 202) : route.abort('failed');
        }
        const preset = url.pathname.slice(proofPath.length).split('/')[0];
        if (url.pathname.startsWith(proofPath) && [a4Preset, letterPreset].includes(preset)) {
          assert.equal(request.headers().authorization, 'Bearer print-alignment-fixture');
          assert.equal(url.searchParams.get('marks'), 'off');
          assert.equal(url.searchParams.has('foilProfile'), false);
          const marks = url.searchParams.get('dahleCutGuides');
          assert.ok(marks === null || marks === 'on');
          const key = legacyProof && preset === a4Preset ? legacyKey : marks ? markedKey : plainKey;
          if (url.pathname.endsWith('/pdf')) {
            assert.equal(url.searchParams.get('key'), key);
            proofDownloads.push(marks);
            return route.fulfill({ contentType: 'application/pdf', headers: { 'x-clc-proof-key': key }, body: '%PDF-1.4\n% Synthetic proof\n' });
          }
          proofs.push(marks);
          if (marks) await markedProof.promise;
          return send({ proof: { recipeId: `household-${preset}-v1`, key, ...generator, cardsPerSheet: 9, trim: [63, 88], bleed: { millimeters: key === legacyKey ? 1 : 1.5 },
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
      const foil = review.getByRole('combobox', { name: 'Artwork color', exact: true });
      const reviewUpdated = review.getByRole('button', { name: 'Review updated list' });
      const generate = review.getByRole('button', { name: 'Generate PDFs', exact: true });
      if (!tracked) {
        await checkProof(page);
        await page.getByRole('textbox', { name: 'Cards to print' }).fill(frozenText);
      }
      await reviewList.click();
      await marks.waitFor();
      await review.getByText(`63 × 88 mm finished cards · 1.5 mm bleed per edge · ${stripSize} row strips.`, { exact: false }).waitFor();
      assert.equal(await marks.isChecked(), false);
      assert.equal(await foil.inputValue(), '');
      assert.equal(planRequests.at(-1).foilProfile, undefined);
      assert.equal(await review.getByRole('checkbox', { name: /Cameo registration/ }).count(), 0);
      assert.equal(planRequests.at(-1).dahleCutGuides, undefined);
      await marks.check();
      await reviewUpdated.waitFor();
      assert.equal(await generate.count(), 0);

      if (!tracked) {
        await reviewUpdated.click();
        await generate.waitFor();
        await foil.selectOption('rainbow-v1');
        await reviewUpdated.waitFor();
        assert.equal(await generate.count(), 0);
        await page.waitForFunction(() => {
          const draft = JSON.parse(localStorage.getItem('clc-print-list-draft:41'));
          return draft?.dahleCutGuides && draft?.foilProfile === 'rainbow-v1';
        });
        await page.reload();
        await reviewList.click();
        await marks.waitFor();
        assert.equal(await marks.isChecked(), true);
        assert.equal(await foil.inputValue(), 'rainbow-v1');
      } else await reviewUpdated.click();
      await review.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
      assert.equal(planRequests.at(-1).dahleCutGuides, true);
      assert.equal(planRequests.at(-1).foilProfile, tracked ? undefined : 'rainbow-v1');
      assert.equal(await review.getByRole('button', { name: 'Generate & print' }).count(), 0);
      await generate.click();
      if (!tracked) {
        await page.getByRole('alert').getByText(/Network error/).waitFor();
        offeredFoilProfiles = [];
        await page.reload();
        const retry = page.getByRole('region', { name: 'Recover print batch request' });
        await retry.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
        await retry.getByText(/Rainbow foil/).waitFor();
        await retry.getByRole('button', { name: 'Retry same batch request' }).click();
      }
      const current = page.getByRole('region', { name: 'Current print batch' });
      await current.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
      if (!tracked) await current.getByText(/Rainbow foil/).waitFor();
      assert.equal(await current.getByRole('button', { name: 'Send to Mac' }).count(), 0);
      assert.equal(creates.length, tracked ? 1 : 2);
      if (!tracked) assert.deepEqual(creates[0], creates[1]);
      console.log(`${tracked ? 'Tracked' : 'Standalone'} Chrome: a marked Dahle review generated PDFs only with its new hash.${tracked ? '' : ' The Rainbow foil draft and exact lost-response request survived reloads.'}`);

      await page.goto(`${origin}/#guide/dahle-punch`);
      await page.getByText('91 mm from the blade', { exact: true }).waitFor();
      await page.getByText(/210 × 91 mm on A4 or 215\.9 × 91 mm on Letter/).waitFor();
      await page.getByText(/Earlier Dahle PDFs may have 90 mm strips/).waitFor();
      if (!tracked) {
        legacyProof = true;
        await page.goto(`${origin}/#print-list`);
        await page.getByText('One-sheet paper proof', { exact: true }).click();
        const proof = page.locator('.print-paper-proof');
        await proof.getByRole('combobox', { name: 'Proof paper and layout' }).selectOption(a4Preset);
        await proof.getByRole('checkbox', { name: 'Include strip cut lines and R3 corner guides on the proof' }).uncheck();
        await proof.getByText('Cut 210 × 90 mm strips on the Dahle using the row ticks.', { exact: true }).waitFor();
        assert.equal(await proof.getByRole('checkbox', { name: 'I printed and checked this exact recipe' }).isChecked(), false);
        console.log('Chrome used the returned 1 mm bleed to show the exact 90 mm cutting instructions for an older proof.');

        await page.evaluate(({ paperSize, dahle, cardText }) => {
          const key = 'clc-print-list-draft:41';
          const draft = JSON.parse(localStorage.getItem(key));
          localStorage.setItem(key, JSON.stringify({ ...draft, cardText, paperSize, printPreset: dahle, foilProfile: 'rainbow-v1' }));
        }, { paperSize, dahle, cardText: frozenText });
        activityDelay = Promise.withResolvers();
        const previousReviews = planRequests.length;
        const draftFoil = page.getByRole('region', { name: 'Draft artwork color' });
        try {
          await page.reload();
          await draftFoil.getByText('Checking support for Rainbow foil…', { exact: true }).waitFor();
          assert.equal(await reviewList.isDisabled(), true);
          assert.equal(planRequests.length, previousReviews);
        } finally { activityDelay.resolve(); }
        await draftFoil.getByText('Rainbow foil is unavailable for this draft.', { exact: true }).waitFor();
        assert.equal(await reviewList.isDisabled(), true);
        await draftFoil.getByRole('button', { name: 'Use Standard color' }).click();
        await reviewList.click();
        await generate.waitFor();
        assert.equal(await foil.count(), 0);
        assert.equal(planRequests.at(-1).foilProfile, undefined);
        assert.equal(planRequests.length, previousReviews + 1);
        console.log('Chrome waited for capabilities before reviewing a saved foil draft and let it recover as Standard after a downgrade.');
      }

      async function checkProof(page) {
        await page.getByText('One-sheet paper proof', { exact: true }).click();
        const proof = page.locator('.print-paper-proof');
        const toggle = proof.getByRole('checkbox', { name: 'Include strip cut lines and R3 corner guides on the proof' });
        const confirm = proof.getByRole('checkbox', { name: 'I printed and checked this exact recipe' });
        const download = proof.getByRole('button', { name: 'Download one-sheet proof PDF' });
        await proof.getByText(/Dahle row ticks · 63 × 88 mm trim · 1\.5 mm bleed per edge/).waitFor();
        await proof.getByText(`Cut ${stripSize} strips on the Dahle using the row ticks.`, { exact: true }).waitFor();
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
        await proof.getByText(`Cut ${stripSize} strips on the Dahle using the horizontal lime cut lines. Line up the blade with the lines in the side margins.`, { exact: true }).waitFor();
        await proof.getByText(/outer lime guide closest to the edge of the paper/).waitFor();
        await proof.getByText(/Feed each strip into the 63 × 88 mm R3 punch.*all four disappear under the die/).waitFor();
        await proof.getByText('Check that the guide ink stayed on the scrap.', { exact: true }).waitFor();
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
