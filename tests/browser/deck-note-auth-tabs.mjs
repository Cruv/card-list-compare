import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.env.CLC_PLAYWRIGHT_MODULE || 'playwright');

const dist = process.argv[2];
const baseline = process.argv.includes('--baseline');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const asset = pathname === '/' ? '/index.html' : pathname;
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(asset)];
    if (type) response.setHeader('Content-Type', type);
    response.end(await readFile(join(dist, asset)));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const writer = await context.newPage();
const observer = await context.newPage();
const ownerA = { id: 1, username: 'fixture-note-owner-a' };
const ownerB = { id: 2, username: 'fixture-note-owner-b' };
const accounts = new Map([
  ['fixture-a', ownerA], ['fixture-a-first', ownerA], ['fixture-a-second', ownerA], ['fixture-a-return', ownerA],
  ['fixture-a-after-failure', ownerA], ['fixture-a-after-logout', ownerA], ['fixture-b', ownerB],
]);
const heldValidations = new Map();
const writes = [];
const oldSave = Promise.withResolvers();
const note = observer.locator('textarea[placeholder="Deck notes..."]');
const authUser = observer.locator('.auth-bar-user');
const deckPath = '/api/decks/12';
let saveResult = 'failure';

const waitForCheck = bearer => observer.waitForRequest(request =>
  request.url() === `${origin}/api/auth/me` && request.headers().authorization === `Bearer ${bearer}`, { timeout: 4000 });
const changeCredential = bearer => writer.evaluate(token => localStorage.setItem('clc-auth-token', token), bearer);
const confirmOwner = account => authUser.getByText(account.username, { exact: true }).waitFor();
const saved = account => observer.getByRole('button', { name: `Saved notes for ${account.username}`, exact: true });
const hasDraft = async text => {
  await note.waitFor();
  assert.equal(await note.inputValue(), text);
};
const startDraft = async (account, text) => {
  await saved(account).click();
  await note.fill(text);
};
const waitForGate = async () => {
  await observer.getByText('Loading your account…', { exact: true }).waitFor();
  assert.equal(await note.count(), 0);
  assert.equal(await observer.getByRole('button', { name: 'Save', exact: true }).count(), 0);
};

try {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const bearer = request.headers().authorization?.slice('Bearer '.length);
    const user = accounts.get(bearer);
    const respond = (json, status = 200) => route.fulfill({ json, status }).catch(() => {});
    if (url.pathname === '/api/auth/me') {
      if (request.frame().page() === observer) await heldValidations.get(bearer)?.promise;
      if (bearer === 'fixture-a-validation-failure') return respond({ error: 'Fixture account check failed' }, 503);
      return user ? respond({ user }) : respond({ code: 'SESSION_INVALID' }, 401);
    }
    if (url.pathname === '/api/auth/login') return respond({ token: 'fixture-a', user: ownerA });
    if (url.pathname === '/api/auth/change-password') {
      assert.equal(bearer, 'fixture-a');
      return respond({ token: 'fixture-a-first' });
    }
    if (url.pathname === deckPath && request.method() === 'PATCH') {
      writes.push({ bearer, body: request.postDataJSON() });
      if (saveResult === 'failure') return respond({ error: 'Fixture could not save the notes' }, 500);
      if (saveResult === 'late') await oldSave.promise;
      return respond({ message: 'Deck updated' });
    }
    if (url.pathname === deckPath && user) {
      return respond({ deck: { id: 12, deck_name: `Deck for ${user.username}`, notes: `Saved notes for ${user.username}`,
        source_type: 'manual', commanders: '[]', tags: [] } });
    }
    if (url.pathname === `${deckPath}/snapshots`) return respond({ snapshots: [] });
    return respond({});
  });

  await writer.goto(`${origin}/#settings`);
  await writer.getByRole('button', { name: 'Log In', exact: true }).click();
  const dialog = writer.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username').fill(ownerA.username);
  await dialog.getByLabel('Password', { exact: true }).fill('DisposablePassword1!');
  await dialog.getByRole('button', { name: 'Log In', exact: true }).click();
  await writer.locator('.auth-bar-user').getByText(ownerA.username, { exact: true }).waitFor();
  await observer.goto(`${origin}/#library/12`);
  await confirmOwner(ownerA);
  const draft = '  Unsaved notes for owner A\nsecond line  ';
  await startDraft(ownerA, draft);

  const rotation = Promise.withResolvers();
  heldValidations.set('fixture-a-first', rotation);
  const checkingRotated = waitForCheck('fixture-a-first');
  await writer.getByText('Change your password', { exact: true }).click();
  await writer.getByLabel('Current Password', { exact: true }).fill('DisposablePassword1!');
  await writer.getByLabel('New Password', { exact: true }).fill('DisposablePassword2!');
  await writer.getByLabel('Confirm New Password', { exact: true }).fill('DisposablePassword2!');
  await writer.getByRole('button', { name: 'Change Password' }).click();
  await checkingRotated;
  await waitForGate();
  assert.deepEqual(writes, []);
  rotation.resolve();
  await confirmOwner(ownerA);

  if (baseline) {
    await saved(ownerA).waitFor();
    assert.equal(await note.count(), 0);
    console.log('v2.65.2 baseline discarded the unsaved note during same-owner rotation.');
  } else {
    await hasDraft(draft);
    await observer.getByRole('button', { name: 'Save', exact: true }).click();
    await observer.getByText('Fixture could not save the notes', { exact: true }).waitFor();
    await hasDraft(draft);
    assert.deepEqual(writes, [{ bearer: 'fixture-a-first', body: { notes: draft.trim() } }]);

    saveResult = 'late';
    await note.fill('');
    const startingSave = observer.waitForRequest(request => request.url() === `${origin}${deckPath}` && request.method() === 'PATCH');
    await observer.getByRole('button', { name: 'Save', exact: true }).click();
    await startingSave;
    const checkingNext = waitForCheck('fixture-a-second');
    await changeCredential('fixture-a-second');
    await checkingNext;
    await confirmOwner(ownerA);
    await hasDraft('');
    await note.fill('A newer edit after the save began');
    const staleResponse = observer.waitForResponse(response => response.url() === `${origin}${deckPath}` && response.request().method() === 'PATCH');
    oldSave.resolve();
    await staleResponse;
    await hasDraft('A newer edit after the save began');
    assert.equal(await observer.getByText('Notes saved', { exact: true }).count(), 0);
    assert.deepEqual(writes[1], { bearer: 'fixture-a-first', body: { notes: null } });
    await note.fill('Private draft for owner A');

    const crossOwner = Promise.withResolvers();
    heldValidations.set('fixture-b', crossOwner);
    const checkingB = waitForCheck('fixture-b');
    await changeCredential('fixture-b');
    await checkingB;
    await waitForGate();
    crossOwner.resolve();
    await confirmOwner(ownerB);
    await saved(ownerB).waitFor();
    assert.equal(await note.count(), 0);
    await changeCredential('fixture-a-return');
    await confirmOwner(ownerA);
    await saved(ownerA).waitFor();
    assert.equal(await note.count(), 0);

    await startDraft(ownerA, 'Discard after validation failure');
    const failed = Promise.withResolvers();
    heldValidations.set('fixture-a-validation-failure', failed);
    const checkingFailed = waitForCheck('fixture-a-validation-failure');
    await changeCredential('fixture-a-validation-failure');
    await checkingFailed;
    await waitForGate();
    failed.resolve();
    await observer.getByRole('heading', { name: 'Log in to continue' }).waitFor();
    assert.equal(await observer.evaluate(() => localStorage.getItem('clc-auth-token')), 'fixture-a-validation-failure');
    await changeCredential('fixture-a-after-failure');
    await confirmOwner(ownerA);
    await saved(ownerA).waitFor();
    assert.equal(await note.count(), 0);

    await startDraft(ownerA, 'Discard on logout and immediate same-owner sign-in');
    const checkingReturn = waitForCheck('fixture-a-after-logout');
    await writer.evaluate(() => {
      localStorage.removeItem('clc-auth-token');
      localStorage.setItem('clc-auth-token', 'fixture-a-after-logout');
    });
    await checkingReturn;
    await confirmOwner(ownerA);
    await saved(ownerA).waitFor();
    assert.equal(await note.count(), 0);
    assert.deepEqual(await observer.evaluate(() => Object.values(localStorage).filter(value => value.includes('Unsaved notes'))), []);
    console.log('Chrome verified in-memory deck note continuity across same-owner rotation, gated controls, pinned saves, failed validation, different owners, and sign-out.');
  }
} finally {
  for (const waiting of heldValidations.values()) waiting.resolve();
  oldSave.resolve();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
