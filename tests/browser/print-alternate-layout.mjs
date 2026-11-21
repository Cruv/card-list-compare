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
const capabilities = { canQueue: true, stationConfigured: true, paperSizes: ['letter'],
  printPresets: ['crowned-a4', 'crowned-a4-portrait-six', 'dahle-a4-punch', 'dahle-letter-punch'],
  foilProfiles: ['rainbow-v1', 'surge-v1'] };
const generator = { available: true, updating: false, revision: 'fixture' };
const station = { online: true, loadedPaperSize: 'a4', loadedPrintPreset: 'crowned-a4-portrait-six',
  supportedRecipeIds: ['household-letter-v6', 'household-crowned-a4-portrait-six-v1'] };
const markOn = '7'.repeat(64);
const markOff = '0'.repeat(64);
const dahleHash = 'd'.repeat(64);
const dahleMarkedHash = 'e'.repeat(64);
const dahleFoilHash = 'f'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const cards = [{
  selectionKey: 'sol-ring', displayName: 'Sol Ring', quantity: 7, setCode: 'c21', collectorNumber: '263', isDFC: false,
  faces: [{ face: 'front', name: 'Sol Ring', status: 'ready' }],
}, {
  selectionKey: 'delver', displayName: 'Delver of Secrets // Insectile Aberration', quantity: 8, setCode: 'isd', collectorNumber: '51', isDFC: true,
  faces: [{ face: 'front', name: 'Delver of Secrets', status: 'ready' }, { face: 'back', name: 'Insectile Aberration', status: 'ready' }],
}];
const failure = { displayName: cards[1].displayName, face: 'back', setCode: 'isd', collectorNumber: '51',
  reason: 'The saved back artwork is unavailable and the provider returned different bytes.' };

try {
  for (const tracked of [false, true]) {
    const scope = tracked ? '/api/decks/12/print-jobs' : '/api/print-lists/jobs';
    const originalId = tracked ? '22222222-4444-4444-8444-444444444444' : '11111111-4444-4444-8444-444444444444';
    const newId = tracked ? '44444444-4444-4444-8444-444444444444' : '33333333-4444-4444-8444-444444444444';
    const href = tracked ? `#library/12?printBatch=${originalId}` : `#print-list?batch=${originalId}`;
    const source = { id: originalId, state: 'backs_pending', createdAt: '2026-11-17T11:00:00Z', updatedAt: '2026-11-17T12:00:00Z',
      deckName: tracked ? 'Tracked fixture' : 'Standalone fixture', totalCopies: 15, mode: tracked ? 'full' : 'adhoc', target: tracked ? { id: 99 } : null,
      artSource: 'scryfall', paperSize: 'letter', recipeId: 'household-letter-v6', registrationMarks: true, manifestSha256,
      queueOnReady: true, steps: [], artifacts: [] };
    const previewRequests = [];
    const createRequests = [];
    const queueRequests = [];
    let derived;
    let offeredFoilProfiles = capabilities.foilProfiles;
    let blockArt = !tracked;
    let loseFirstResponse = !tracked;
    const markedPreview = Promise.withResolvers();
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: tracked ? { width: 1280, height: 900 } : { width: 390, height: 844 } });
    await page.addInitScript(() => localStorage.setItem('clc-auth-token', 'print-layout-fixture'));
    try {
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const send = (json, status = 200) => route.fulfill({ status, json });
        const jobs = derived ? [derived, source] : [source];
        if (url.pathname === '/api/auth/me') return send({ user: { id: 41, username: 'Layout Fixture' } });
        if (url.pathname === '/api/decks/12') return send({ deck: { id: 12, deck_name: source.deckName, source_type: 'manual', commanders: '[]', tags: [] } });
        if (url.pathname === '/api/decks/12/snapshots') return send({ snapshots: [] });
        if (url.pathname === '/api/manasync/print-queue') return send({ items: [] });
        if (url.pathname === `${scope}/activity`) return send({
          activeCount: jobs.length, jobs, watchedJobs: jobs, watching: false,
          capabilities: { ...capabilities, foilProfiles: offeredFoilProfiles }, generator, station,
        });
        if (url.pathname === scope && request.method() === 'GET') return send({ jobs, capabilities, generator });
        if (url.pathname === `${scope}/${originalId}/alternate-layout/preview`) {
          const body = request.postDataJSON();
          assert.equal(request.headers().authorization, 'Bearer print-layout-fixture');
          previewRequests.push(body);
          const dahle = body.printPreset === 'dahle-letter-punch';
          const portraitSix = body.printPreset === 'crowned-a4-portrait-six';
          if (body.dahleCutGuides) await markedPreview.promise;
          const failures = blockArt ? [failure] : [];
          return send({
            capabilities, generator, layout: { frontSheets: dahle ? 2 : 3, backSheets: dahle ? 1 : 2 }, artworkFailures: failures,
            sourceJobId: originalId, sourceManifestSha256: manifestSha256,
            plan: { ...body, totalCopies: 15, readyToGenerate: !failures.length, resolvedCards: cards,
              planHash: dahle ? [body.foilProfile && dahleFoilHash, body.dahleCutGuides && dahleMarkedHash, dahleHash].find(Boolean)
                : portraitSix && !body.registrationMarks ? markOff : markOn },
          });
        }
        if (url.pathname === `${scope}/${originalId}/alternate-layout`) {
          const body = request.postDataJSON();
          assert.equal(request.headers().authorization, 'Bearer print-layout-fixture');
          const optionalKeys = tracked ? [] : ['dahleCutGuides', 'foilProfile'];
          assert.deepEqual(Object.keys(body).sort(), [...optionalKeys, 'expectedPlanHash', 'idempotencyKey', 'paperSize', 'printPreset', 'registrationMarks'].sort());
          assert.match(body.idempotencyKey, /^[a-f0-9]{48}$/);
          createRequests.push(body);
          if (derived) return send({ job: derived, isExisting: true });
          derived = { ...source, ...body, id: newId, deckName: 'Alternate-layout fixture', state: 'ready', queueOnReady: false,
            createdAt: '2026-11-17T13:00:00Z', updatedAt: '2026-11-17T13:00:00Z', alternateLayoutOf: { id: originalId, manifestSha256 },
            artifacts: [{ id: 'ordinary', kind: 'ordinary', downloadUrl: `${scope}/${newId}/artifacts/ordinary` }] };
          if (loseFirstResponse) {
            loseFirstResponse = false;
            return route.abort('failed');
          }
          return send({ job: derived, isExisting: false }, 201);
        }
        if (url.pathname === `${scope}/${newId}/queue` && request.method() === 'POST') {
          queueRequests.push(newId);
          derived = { ...derived, state: 'queued', updatedAt: '2026-11-17T13:01:00Z' };
          return send({ job: derived });
        }
        if (url.pathname === `${scope}/${newId}` && request.method() === 'GET') return send({ job: derived });
        if (url.pathname === `${scope}/${originalId}` && request.method() === 'GET') return send({ job: source });
        assert.equal(request.method(), 'GET', `Unexpected write to ${url.pathname}`);
        return send({});
      });

      await page.goto(origin + '/' + href);
      const current = page.getByRole('region', { name: 'Current print batch' });
      const open = current.getByRole('button', { name: 'Regenerate with another layout' });
      const dialog = page.getByRole('dialog', { name: 'Regenerate with another layout' });
      const paper = dialog.getByRole('combobox', { name: 'Paper and layout' });
      const dieMarks = dialog.getByRole('checkbox', { name: 'Include strip cut lines and R3 corner guides' });
      const foil = dialog.getByRole('combobox', { name: 'Artwork color', exact: true });
      const counts = dialog.locator('.print-regeneration-counts dd');
      const generate = dialog.getByRole('button', { name: 'Generate PDFs', exact: true });
      await current.getByText('Fronts are printed. Backs are saved for later.', { exact: true }).waitFor();
      await open.click();
      if (tracked) {
        await paper.waitFor();
        await page.waitForFunction(() => document.activeElement?.tagName === 'SELECT');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await open.evaluate(button => button === document.activeElement), true);
        await open.click();
      }
      if (!tracked) {
        await dialog.getByRole('alert').getByText(/Delver of Secrets .* · Back\./).waitFor();
        await dialog.getByText(failure.reason).waitFor();
        assert.equal(await generate.isDisabled(), true);
        assert.equal(await foil.count(), 0);
        assert.deepEqual(createRequests, []);
        assert.deepEqual(queueRequests, []);
        blockArt = false;
        await paper.selectOption('dahle-letter-punch');
        await dialog.getByText(/Cut 215\.9 × 91 mm strips on the Dahle/).waitFor();
        assert.equal(await dieMarks.isChecked(), false);
        assert.equal(await dialog.getByRole('checkbox', { name: /Cameo/ }).count(), 0);
        await generate.waitFor();
        await counts.first().waitFor();
        assert.deepEqual(await counts.allTextContents(), ['15', '2', '1']);
        assert.equal(previewRequests.at(-1).dahleCutGuides, undefined);
        assert.equal(await foil.inputValue(), '');
        await dieMarks.check();
        await dialog.getByText(/Checking the original artwork and layout/).waitFor();
        await foil.selectOption('surge-v1');
        assert.equal(await generate.isDisabled(), true);
        assert.deepEqual(createRequests, []);
        markedPreview.resolve();
        await counts.first().waitFor();
        assert.deepEqual(await counts.allTextContents(), ['15', '2', '1']);
        assert.equal(previewRequests.at(-1).foilProfile, 'surge-v1');
      } else {
        await paper.selectOption('crowned-a4-portrait-six');
        assert.equal(await dieMarks.count(), 0);
        assert.equal(await foil.count(), 0);
        await dialog.getByRole('checkbox', { name: 'Include Cameo registration marks' }).uncheck();
        await counts.first().waitFor();
        assert.deepEqual(await counts.allTextContents(), ['15', '3', '2']);
      }
      await dialog.getByText('Original printings and paired faces', { exact: true }).click();
      await dialog.getByText(/· C21 263/).waitFor();
      await dialog.getByText(/· ISD 51/).waitFor();
      await dialog.getByText('Front · Delver of Secrets · Verified', { exact: true }).waitFor();
      await dialog.getByText('Back · Insectile Aberration · Verified', { exact: true }).waitFor();
      await generate.click();
      if (!tracked) {
        await dialog.getByRole('alert').getByText(/Network error/).waitFor();
        const originalRequest = structuredClone(createRequests[0]);
        assert.equal(originalRequest.expectedPlanHash, dahleFoilHash);
        assert.equal(originalRequest.paperSize, 'letter');
        assert.equal(originalRequest.registrationMarks, false);
        assert.equal(originalRequest.dahleCutGuides, true);
        assert.equal(originalRequest.foilProfile, 'surge-v1');
        offeredFoilProfiles = [];
        await page.reload();
        await open.click();
        assert.equal(await paper.inputValue(), 'dahle-letter-punch');
        assert.equal(await paper.isDisabled(), true);
        assert.equal(await dieMarks.isChecked(), true);
        assert.equal(await dieMarks.isDisabled(), true);
        assert.equal(await foil.inputValue(), 'surge-v1');
        assert.equal(await foil.isDisabled(), true);
        await dialog.getByText(/Cut the strips on the Dahle using the guides on your PDF/).waitFor();
        await dialog.getByRole('button', { name: 'Retry same layout request' }).click();
        await current.getByRole('heading', { name: 'Alternate-layout fixture' }).waitFor();
        assert.deepEqual(createRequests, [originalRequest, originalRequest]);
      } else {
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(createRequests[0].expectedPlanHash, markOff);
        assert.equal(createRequests[0].registrationMarks, false);
      }
      await current.getByRole('heading', { name: 'Alternate-layout fixture' }).waitFor();
      assert.ok(previewRequests.length > 0);
      await current.getByRole('button', { name: 'Download ordinary fronts PDF' }).waitFor();
      assert.equal(await current.getByRole('button', { name: 'Confirm usable copies' }).count(), 0);
      assert.deepEqual(queueRequests, []);
      if (tracked) {
        await current.getByRole('button', { name: 'Send to Mac' }).click();
        await current.getByText('Waiting for the Mac', { exact: true }).waitFor();
        assert.deepEqual(queueRequests, [newId]);
      } else {
        await current.getByText(/Dahle strip cut lines and R3 corner guides/).waitFor();
        await current.getByText(/Surge foil/).waitFor();
        assert.equal(await current.getByRole('button', { name: 'Send to Mac' }).count(), 0);
      }
      await current.getByRole('link', { name: /source batch/ }).click();
      await current.getByText('Fronts are printed. Backs are saved for later.', { exact: true }).waitFor();
      console.log(tracked
        ? 'Tracked batch retained its paired art and parked backs. Only the explicit fake Send to Mac action queued the new batch.'
        : 'Mobile standalone review showed the failed back face, Dahle sheet counts, and exact paired printings. The Surge foil preview replaced the plain hash, and reload retried the same PDF-only request.');
    } finally { markedPreview.resolve(); await page.close(); }
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
