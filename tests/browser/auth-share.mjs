import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.env.CLC_PLAYWRIGHT_MODULE || 'playwright');

const verify = !process.argv.includes('--baseline');
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
const a = { id: 1, username: 'Account A' }, b = { id: 2, username: 'Account B' };
const observed = {};
const token = page => page.evaluate(() => localStorage.getItem('clc-auth-token'));
const setup = async () => {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.continue();
  });
  return page;
};
const signIn = async (page, username) => {
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username').fill(username);
  await dialog.getByLabel('Password', { exact: true }).fill('DisposablePassword1!');
  await dialog.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByRole('button', { name: 'Log Out' }).waitFor();
};

try {
  for (const action of ['ordinary', 'switch account', 'logout', 're-login']) {
    const page = await setup();
    const passwordStarted = Promise.withResolvers(), passwordResponse = Promise.withResolvers();
    await page.addInitScript(() => localStorage.setItem('clc-auth-token', 'fixture-old-a'));
    await page.route('**/api/auth/me', route => route.fulfill({ json: { user: route.request().headers().authorization === 'Bearer fixture-b' ? b : a } }));
    await page.route('**/api/auth/login', route => {
      const owner = route.request().postDataJSON().username === 'Account B' ? b : a;
      return route.fulfill({ json: { user: owner, token: owner.id === 2 ? 'fixture-b' : 'fixture-reauth-a' } });
    });
    await page.route('**/api/auth/change-password', async route => {
      assert.equal(route.request().headers().authorization, 'Bearer fixture-old-a');
      passwordStarted.resolve();
      await passwordResponse.promise;
      await route.fulfill({ json: { token: 'fixture-rotated-a' } });
    });
    await page.goto(origin + '/#settings');
    await page.getByText('Change your password', { exact: true }).click();
    await page.getByLabel('Current Password', { exact: true }).fill('DisposablePassword1!');
    await page.getByLabel('New Password', { exact: true }).fill('DisposablePassword2!');
    await page.getByLabel('Confirm New Password', { exact: true }).fill('DisposablePassword2!');
    await page.getByRole('button', { name: 'Change Password' }).click();
    await passwordStarted.promise;
    if (action !== 'ordinary') {
      await page.getByRole('button', { name: 'Log Out' }).click();
      if (action === 'switch account') await signIn(page, 'Account B');
      if (action === 're-login') await signIn(page, 'Account A');
    }
    const received = page.waitForResponse('**/api/auth/change-password');
    passwordResponse.resolve();
    await received;
    await page.waitForTimeout(100);
    observed[action] = await token(page);
    if (verify) {
      assert.equal(observed[action], { ordinary: 'fixture-rotated-a', 'switch account': 'fixture-b', logout: null, 're-login': 'fixture-reauth-a' }[action]);
      if (action === 'ordinary') await page.getByText('Password changed successfully', { exact: true }).waitFor();
    }
    await page.close();
  }

  for (const flow of ['reopen', 'new comparison', 'late share', 'owner']) {
    const page = await setup();
    const shareStarted = Promise.withResolvers(), shareResponse = Promise.withResolvers();
    const posts = [];
    await page.addInitScript(() => {
      window.fixtureClips = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText(text) {
        window.fixtureClips.push(text);
        return Promise.reject(new DOMException('Denied by fixture', 'NotAllowedError'));
      } } });
    });
    await page.route('**/api/auth/login', route => route.fulfill({ json: { user: b, token: 'fixture-b' } }));
    await page.route('**/api/share', async route => {
      const { beforeText, afterText } = route.request().postDataJSON();
      posts.push({ beforeText, afterText, authorization: route.request().headers().authorization });
      shareStarted.resolve();
      if (flow === 'late share' && afterText === '1 Mountain') await shareResponse.promise;
      return route.fulfill({ status: 201, json: { id: afterText === '1 Mountain' ? 'old-fixture' : 'new-fixture' } });
    });
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Before deck list' }).fill('1 Island');
    const after = page.getByRole('textbox', { name: 'After deck list' });
    await after.fill('1 Mountain');
    await page.getByRole('button', { name: 'Compare Lists' }).click();
    if (flow === 'new comparison' || flow === 'late share') await after.fill('1 Forest');
    const menu = page.getByRole('button', { name: 'Export', exact: true });
    const setMenu = async open => {
      if ((await menu.getAttribute('aria-expanded') === 'true') !== open) await menu.click();
    };
    await menu.click();
    await page.getByRole('button', { name: 'Create share link' }).click();
    await shareStarted.promise;
    const oldLink = page.locator('a[href="' + origin + '/#share/old-fixture"]');
    if (flow !== 'late share') await oldLink.waitFor();
    if (flow === 'reopen' || flow === 'owner') {
      await setMenu(false);
      if (flow === 'owner') await signIn(page, 'Account B');
      await setMenu(true);
    } else {
      if (flow === 'new comparison') await page.getByLabel('Link expires').focus();
      else await menu.focus();
      await page.keyboard.press('Control+Enter');
      await page.getByText('Forest', { exact: true }).last().waitFor();
      if (flow === 'late share') {
        const next = page.waitForResponse('**/api/share');
        shareResponse.resolve();
        await next;
      }
    }
    await page.waitForTimeout(100);
    const oldShown = await oldLink.isVisible();
    const writes = await page.evaluate(() => window.fixtureClips.length);
    observed[flow] = { oldShown, writes };
    assert.deepEqual(posts[0], { beforeText: '1 Island', afterText: '1 Mountain', authorization: undefined });
    if (verify) {
      assert.equal(oldShown, flow === 'reopen');
      if (flow === 'late share') assert.equal(writes, 0);
      if (flow === 'reopen') {
        assert.equal(await page.getByLabel('Share link', { exact: true }).inputValue(), origin + '/#share/old-fixture');
        assert.equal(posts.length, 1);
      }
      if (flow === 'new comparison' || flow === 'late share' || flow === 'owner') {
        await setMenu(true);
        await page.getByRole('button', { name: 'Create share link' }).click();
        const expected = flow === 'owner' ? 'old-fixture' : 'new-fixture';
        await page.locator('a[href="' + origin + '/#share/' + expected + '"]').waitFor();
        assert.deepEqual(posts[1], { beforeText: '1 Island', afterText: flow === 'owner' ? '1 Mountain' : '1 Forest', authorization: flow === 'owner' ? 'Bearer fixture-b' : undefined });
      }
    }
    await page.close();
  }
  console.log(JSON.stringify(observed));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
