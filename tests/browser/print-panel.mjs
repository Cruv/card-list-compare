import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.env.CLC_PLAYWRIGHT_MODULE || 'playwright');

const baseline = process.argv.includes('--baseline');
const watchCapBaseline = process.argv.includes('--watch-cap-baseline');
const dist = process.argv[2];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const asset = pathname === '/' ? '/index.html' : pathname;
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(asset)];
    if (contentType) response.setHeader('Content-Type', contentType);
    response.end(await readFile(join(dist, asset)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(version => {
    localStorage.setItem('clc-auth-token', 'fixture');
    localStorage.setItem('clc-version-seen', version);
  }, baseline ? '2.65.0' : watchCapBaseline ? '2.65.1' : '2.65.2');
  let stationPaper = 'letter';
  let stationReads = 0;
  let activityReads = 0;
  let historyReads = 0;
  let manaSyncReads = 0;
  let historyUnavailable = false;
  let creationFixture = null;
  const watchCounts = [];
  const changedReads = new Map();
  const capabilities = { canQueue: true, stationConfigured: true, printPresets: ['crowned-a4'], paperSizes: ['letter', 'a4'] };
  const generator = { available: true, updating: false, revision: 'fixture', adapterHash: 'adapter-fixture' };
  const card = { selectionKey: '["lightning bolt","",""]', displayName: 'Lightning Bolt', quantity: 3, baseQuantity: 3 };
  const jobs = new Map();
  const makeJob = (seq, name, state) => {
    const id = 'eda9b6dd-6884-4444-8222-' + seq.toString(16).padStart(12, '0');
    const createdAt = new Date(Date.UTC(2026, 10, 18, 13, 10, seq)).toISOString();
    return { id, state, deckName: name, createdAt, updatedAt: createdAt, totalCopies: 3, mode: 'adhoc', artSource:'scryfall', artifacts: [] };
  };
  const updateJob = (job, state) => jobs.set(job.id, { ...job, state, updatedAt: '2026-11-18T13:12:00.000Z' });
  const ready = () => ({
    online: stationPaper !== 'offline', loadedPaperSize: stationPaper === 'crowned-a4' ? 'a4' : 'letter',
    ...(stationPaper === 'crowned-a4' ? { loadedPrintPreset: 'crowned-a4' } : {}),
    supportedRecipeIds: ['household-crowned-a4-v2', 'household-letter-v6'],
  });
  const summary = ({ id, state, updatedAt }) => ({ id, state, updatedAt });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = json => route.fulfill({ json });
    if (url.pathname === '/api/auth/me') return send({ user: { id: 41, username: 'Fixture', is_admin: 1 } });
    if (url.pathname === '/api/print-lists/jobs/activity') {
      activityReads++;
      const active = Array.from(jobs.values()).reverse().filter(job => !['completed', 'canceled', 'failed', 'expired'].includes(job.state));
      const watch = url.searchParams.get('watch')?.split(',') ?? [];
      watchCounts.push(watch.length);
      if (watch.length > 51) return route.fulfill({ status: 400, json: { error: 'Invalid batch watch list' } });
      const watchedJobs = watch.filter(id => jobs.has(id)).map(id => summary(jobs.get(id)));
      return send({ activeCount: active.length, jobs: active.slice(0, 50).map(summary), watching: active.some(job => job.state !== 'ready'),
        capabilities, generator, station: ready(), watchedJobs });
    }
    if (url.pathname === '/api/print-station-management/status') {
      stationReads++;
      return send({ station: ready() });
    }
    if (url.pathname === '/api/print-lists/jobs') {
      if (request.method() === 'POST') {
        assert.ok(creationFixture, 'Only the watch-limit fixture should request generation');
        assert.equal(request.postDataJSON().queueOnReady, false);
        jobs.set(creationFixture.id, creationFixture);
        return route.fulfill({ status: 201, json: { job: creationFixture } });
      }
      historyReads++;
      assert.equal(request.method(), 'GET');
      if (historyUnavailable) return route.fulfill({ status: 503, json: { error: 'History unavailable in this fixture' } });
      return send({ jobs: Array.from(jobs.values()).reverse().slice(0, 50), capabilities, generator });
    }
    if (url.pathname.startsWith('/api/print-lists/jobs/')) {
      const id = url.pathname.split('/').at(-1);
      changedReads.set(id, (changedReads.get(id) || 0) + 1);
      return send({ job: jobs.get(id) });
    }
    if (url.pathname === '/api/manasync/print-queue') {
      manaSyncReads++;
      return route.fulfill({ status: 502, json: { error: 'ManaSync is offline in this fixture' } });
    }
    if (url.pathname === '/api/print-lists/plan') {
      const body = request.postDataJSON();
      return send({ capabilities, generator, plan: { ...body, deckName: 'Fixture list', cards: [card],
        resolvedCards: [{ ...card, isDFC: false, errors: [], faces: [{ face: 'front', status: 'ready', identifier: 'fixture' }] }],
        artSource: 'scryfall', sheetPacking: 'double-faced-first', totalCopies: 3, ordinaryCopies: 3, doubleFacedCopies: 0,
        readyToGenerate: true, planHash: 'a'.repeat(64),
      } });
    }
    return send({ jobs: [], items: [] });
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(origin + '/#print-list');
  await page.getByRole('textbox', { name: 'Cards to print' }).fill('3 Lightning Bolt');
  await page.getByRole('button', { name: 'Review print list', exact: true }).click();
  await page.getByRole('combobox', { name: 'Paper and layout' }).selectOption('crowned-a4');
  await page.getByRole('button', { name: 'Review updated list', exact: true }).click();
  const queue = page.getByRole('button', { name: 'Generate & print', exact: true });
  await queue.and(page.locator(':disabled')).waitFor();
  await page.getByText(/The Mac is set up for US Letter/).waitFor();
  stationPaper = 'crowned-a4';
  await page.clock.runFor(20000);
  if (baseline) {
    await queue.and(page.locator(':disabled')).waitFor();
    assert.equal(activityReads, 1);
    assert.equal(stationReads, 1);
    console.log('Baseline: Prepare remained blocked after 20 mock seconds and the stock switch.');
  } else {
    await queue.and(page.locator(':enabled')).waitFor();
    stationPaper = 'offline';
    await page.clock.runFor(16000);
    await queue.and(page.locator(':disabled')).waitFor();
    stationPaper = 'crowned-a4';
    await page.clock.runFor(16000);
    await queue.and(page.locator(':enabled')).waitFor();
    assert.equal(stationReads, 0, 'Prepare must avoid full Printer dashboard status');
    assert.equal(historyReads, 0);
    assert.equal(manaSyncReads, 0);
    console.log('Updated: Prepare followed the stock change, disconnect and reconnect via activity only.');
  }
  const older = makeJob(1, 'Older fixture batch', 'submitted');
  const middle = makeJob(2, 'Middle fixture batch', 'preparing');
  const latest = makeJob(3, 'Latest fixture batch', 'preparing');
  for (const job of [older, middle, latest]) jobs.set(job.id, job);
  await page.getByRole('button', { name: 'Batches', exact: true }).click();
  const scope = name => page.locator('article.print-batch').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await scope(latest.deckName).waitFor();
  await page.locator('summary').filter({ hasText: 'Other print batches' }).click();
  await scope(older.deckName).getByText('In the Epson queue').waitFor();
  await scope(middle.deckName).getByText('Preparing PDFs').waitFor();
  await page.getByText('ManaSync confirmation records could not refresh: ManaSync is offline in this fixture').waitFor();
  if (!baseline) await page.clock.runFor(5000); // Allow the first watched summaries after history opens.
  assert.equal(historyReads, 1);
  updateJob(older, 'completed');
  updateJob(middle, 'ready');
  await page.clock.runFor(6500);
  if (baseline) {
    await scope(older.deckName).getByText('In the Epson queue').waitFor();
    await scope(middle.deckName).getByText('Preparing PDFs').waitFor();
    assert.equal(changedReads.get(older.id), undefined);
    assert.equal(changedReads.get(middle.id), undefined);
    console.log('Baseline: older completed and middle ready batches remained stale while history was open.');
  } else {
    await scope(older.deckName).getByText('Spooler completed').waitFor();
    await scope(middle.deckName).getByText('PDFs ready', { exact: true }).waitFor();
    assert.equal(changedReads.get(older.id), 1);
    assert.equal(changedReads.get(middle.id), 1);
    assert.equal(historyReads, 1);
    assert.equal(manaSyncReads, 1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const previousActivity = activityReads;
    updateJob(older, 'expired');
    await page.clock.runFor(20000);
    assert.equal(activityReads, previousActivity);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await scope(older.deckName).getByText('PDFs expired').waitFor();
    assert.equal(historyReads, 1, 'Resuming visibility must only refresh compact status and changed details');
    assert.equal(manaSyncReads, 1);
    assert.equal(changedReads.get(older.id), 2);
    console.log('Updated: both older rows refreshed, including completed → expired across visibility, while ManaSync failed independently.');
  }

  if (!baseline) {
    await page.close();
    jobs.clear();
    watchCounts.length = 0;
    historyReads = 0;
    const linked = makeJob(0, 'Linked older batch', 'completed');
    jobs.set(linked.id, linked);
    for (let i = 1; i <= 50; i++) {
      const job = makeJob(i, `History fixture ${i}`, 'completed');
      jobs.set(job.id, job);
    }
    const limitPage = await context.newPage();
    await limitPage.clock.install();
    await limitPage.goto(origin + '/#print-list?batch=' + linked.id);
    const currentBatch = limitPage.getByRole('region', { name: 'Current print batch' });
    await currentBatch.getByRole('heading', { name: linked.deckName }).waitFor();
    await limitPage.getByRole('button', { name: 'Batches (51)', exact: true }).waitFor();
    const watchedFullList = limitPage.waitForRequest(request =>
      new URL(request.url()).searchParams.get('watch')?.split(',').length === 51);
    await limitPage.clock.runFor(16000);
    await watchedFullList;
    assert.equal(historyReads, 1);

    await limitPage.getByRole('button', { name: 'Prepare another batch', exact: true }).click();
    await limitPage.getByRole('textbox', { name: 'Cards to print' }).fill('3 Lightning Bolt');
    await limitPage.getByRole('button', { name: 'Review print list', exact: true }).click();
    historyUnavailable = true;
    creationFixture = makeJob(51, 'New fixture batch', 'preparing');
    await limitPage.getByRole('button', { name: 'Generate PDFs', exact: true }).click();
    await currentBatch.getByRole('heading', { name: creationFixture.deckName }).waitFor();
    await limitPage.getByText('Batch history could not refresh: History unavailable in this fixture').waitFor();
    if (watchCapBaseline) {
      await limitPage.getByRole('button', { name: 'Batches (52)', exact: true }).waitFor();
      await limitPage.getByText('Print status could not refresh: Invalid batch watch list').waitFor();
      assert.equal(Math.max(...watchCounts), 52);
      console.log('v2.65.1 baseline: creating a batch with a full history and an older linked batch caused 52 watched IDs and a 400.');
    } else {
      await limitPage.getByRole('button', { name: 'Batches (50)', exact: true }).waitFor();
      updateJob(creationFixture, 'ready');
      await limitPage.clock.runFor(6500);
      await currentBatch.getByText('PDFs ready', { exact: true }).waitFor();
      assert.equal(historyReads, 2);
      assert.equal(Math.max(...watchCounts), 51);
      console.log('Updated: a full batch list stayed within 51 watched IDs and the new selection advanced while history returned 503.');
    }
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
