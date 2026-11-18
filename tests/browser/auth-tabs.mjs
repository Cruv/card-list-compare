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
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(asset)];
    if (contentType) response.setHeader('Content-Type', contentType);
    response.end(await readFile(join(dist, asset)));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const writer = await context.newPage();
const observer = await context.newPage();
const accountA = { id: 1, username: 'fixture-owner-a', email: 'a@example.invalid' };
const accountB = { id: 2, username: 'fixture-owner-b', email: 'b@example.invalid' };
const accountC = { id: 3, username: 'fixture-owner-c', email: 'c@example.invalid' };
const accounts = new Map([
  ['fixture-a', accountA], ['fixture-a-rotated', accountA], ['fixture-b', accountB], ['fixture-c', accountC],
]);
const heldValidation = new Map();
const requests = [];

async function signIn(name) {
  await writer.getByRole('button', { name: 'Log In', exact: true }).click();
  const dialog = writer.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username').fill(name);
  await dialog.getByLabel('Password', { exact: true }).fill('DisposablePassword1!');
  await dialog.getByRole('button', { name: 'Log In', exact: true }).click();
  await writer.locator('.auth-bar-user').getByText(name, { exact: true }).waitFor();
}

async function openExport() {
  const menu = observer.getByRole('button', { name: 'Export', exact: true });
  if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
}

const waitForBearer = (page, bearer) => page.waitForRequest(request =>
  request.url() === origin + '/api/auth/me' && request.headers().authorization === `Bearer ${bearer}`, { timeout: 4000 });
const shareButton = observer.getByRole('button', { name: 'Create share link' });
const owner = observer.locator('.auth-bar-user');

try {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const bearer = request.headers().authorization?.slice('Bearer '.length);
    const user = accounts.get(bearer);
    requests.push({ tab: request.frame().page(), path: url.pathname, bearer });
    if (url.pathname === '/api/auth/me') {
      if (request.frame().page() === observer) await heldValidation.get(bearer)?.promise;
      if (user) return route.fulfill({ json: { user } }).catch(() => {});
      return route.fulfill({ status: 401, json: { code: 'SESSION_INVALID', error: 'Fixture bearer expired' } });
    }
    if (url.pathname === '/api/auth/login') {
      const name = request.postDataJSON().username;
      const token = name === accountA.username ? 'fixture-a' : 'fixture-b';
      return route.fulfill({ json: { token, user: accounts.get(token) } });
    }
    if (url.pathname === '/api/auth/change-password') {
      assert.equal(bearer, 'fixture-a');
      return route.fulfill({ json: { token: 'fixture-a-rotated' } });
    }
    if (url.pathname === '/api/share') {
      return route.fulfill({ status: 201, json: { id: user ? `fixture-share-${user.id}` : 'guest' } });
    }
    return route.fulfill({ json: {} });
  });

  await writer.goto(origin + '/#settings');
  await signIn(accountA.username);
  await observer.goto(origin);
  await owner.getByText(accountA.username, { exact: true }).waitFor();
  await observer.getByRole('textbox', { name: 'Before deck list' }).fill('1 Island');
  await observer.getByRole('textbox', { name: 'After deck list' }).fill('1 Counterspell (CLB) [122] *F*');
  await observer.getByRole('button', { name: 'Compare Lists' }).click();
  await openExport();

  const rotated = Promise.withResolvers();
  heldValidation.set('fixture-a-rotated', rotated);
  const rotationCheck = baseline ? null : waitForBearer(observer, 'fixture-a-rotated');
  await writer.getByText('Change your password', { exact: true }).click();
  await writer.getByLabel('Current Password', { exact: true }).fill('DisposablePassword1!');
  await writer.getByLabel('New Password', { exact: true }).fill('DisposablePassword2!');
  await writer.getByLabel('Confirm New Password', { exact: true }).fill('DisposablePassword2!');
  await writer.getByRole('button', { name: 'Change Password' }).click();
  await writer.getByText('Password changed successfully', { exact: true }).waitFor();

  if (baseline) {
    await shareButton.click();
    await observer.getByText('Your sign-in changed. Sign in again to create a link for this account.').waitFor();
    assert.ok(!requests.some(request => request.tab === observer && request.bearer === 'fixture-a-rotated'));
    console.log('v2.65.1 baseline: password rotation left the other tab displayed as A and blocked sharing until reload.');
  } else {
    await rotationCheck;
    await shareButton.waitFor({ state: 'hidden' });
    await owner.waitFor({ state: 'hidden' });
    rotated.resolve();
    await owner.getByText(accountA.username, { exact: true }).waitFor();
    await openExport();
    await shareButton.click();
    await observer.locator('a[href$="#share/fixture-share-1"]').waitFor();
    assert.deepEqual(requests.filter(request => request.path === '/api/share').map(request => request.bearer), ['fixture-a-rotated']);

    // Hold B's validation long enough to supersede it with a third account and finally with logout.
    const replacement = Promise.withResolvers();
    heldValidation.set('fixture-b', replacement);
    const checkingB = waitForBearer(observer, 'fixture-b');
    await writer.getByRole('button', { name: 'Log Out' }).click();
    await signIn(accountB.username);
    await checkingB;
    await owner.waitFor({ state: 'hidden' });
    assert.equal(await shareButton.count(), 0);
    const checkingC = waitForBearer(observer, 'fixture-c');
    await writer.evaluate(() => localStorage.setItem('clc-auth-token', 'fixture-c'));
    await checkingC;
    await owner.getByText(accountC.username, { exact: true }).waitFor();
    replacement.resolve();
    await openExport();
    await shareButton.click();
    await observer.locator('a[href$="#share/fixture-share-3"]').waitFor();
    assert.deepEqual(requests.filter(request => request.path === '/api/share').map(request => request.bearer), ['fixture-a-rotated', 'fixture-c']);

    await observer.evaluate(() => {
      // Probe a previous view before the storage event can replace it.
      localStorage.setItem('clc-auth-token', 'fixture-b');
      document.querySelector('[aria-label="Log Out"]').click();
    });
    assert.equal(await writer.evaluate(() => localStorage.getItem('clc-auth-token')), 'fixture-b');
    await writer.evaluate(() => localStorage.clear());
    await observer.getByRole('button', { name: 'Log In', exact: true }).waitFor();
    console.log('Chrome verified two-tab password rotation, gating during replacement, late validation, owner-bound shares and cross-tab sign-out.');
  }
} finally {
  for (const pending of heldValidation.values()) pending.resolve();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
