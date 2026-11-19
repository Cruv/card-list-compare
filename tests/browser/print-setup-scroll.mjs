import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const { chromium } = await import(process.env.CLC_PLAYWRIGHT_MODULE || 'playwright');
const dist = process.argv[2];
const baseline = process.argv.includes('--baseline');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const asset = path === '/' ? '/index.html' : path;
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

const capabilities = { stationConfigured: true, canQueue: true, printPresets: ['crowned-a4', 'crowned-a4-portrait-six'] };
const generator = { available: true, revision: 'fixture' };
const cards = Array.from({ length: 18 }, (_, index) => ({
  selectionKey: JSON.stringify([`card ${index + 1}`, 'm10', String(index + 1)]),
  displayName: `Card ${index + 1}`, setCode: 'm10', collectorNumber: String(index + 1), quantity: 1, baseQuantity: 1,
}));
const resolvedCards = cards.map(card => ({
  ...card, isDFC: false, errors: [], faces: [{ face: 'front', status: 'ready', identifier: card.selectionKey }],
}));
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'Mobile tap' : 'Desktop click';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 780 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      localStorage.setItem('clc-auth-token', 'disposable-scroll-fixture');
      window.scrollTrace = [];
      for (const method of ['scrollBy', 'scrollTo']) {
        const original = window[method].bind(window);
        window[method] = (...args) => {
          window.scrollTrace.push({ event: method, top: args[0]?.top, active: document.activeElement?.id, y: window.scrollY });
          return original(...args);
        };
      }
      document.addEventListener('focusin', event => {
        window.scrollTrace.push({ event: 'focusin', id: event.target.id, tag: event.target.tagName, y: window.scrollY });
      });
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Scroll fixture' } } });
      if (url.pathname === '/api/print-lists/jobs/activity') return route.fulfill({ json: {
        activeCount: 0, jobs: [], watchedJobs: [], watching: false, capabilities, generator,
        station: { online: true, loadedPaperSize: 'letter', supportedRecipeIds: ['household-letter-v6', 'household-crowned-a4-v2'] },
      } });
      if (url.pathname === '/api/print-lists/plan') {
        const payload = route.request().postDataJSON();
        return route.fulfill({ json: { capabilities, generator, plan: {
          ...payload, deckName: 'Print review fixture', cards, resolvedCards, ordinaryCopies: cards.length,
          totalCopies: cards.length, doubleFacedCopies: 0, readyToGenerate: true, planHash: 'a'.repeat(64),
        } } });
      }
      return route.fulfill({ json: {} });
    });

    const page = await context.newPage();
    await page.goto(origin + '/#print-list');
    await page.getByRole('textbox', { name: 'Cards to print' }).fill(cards.map(card => '1 ' + card.displayName).join('\n'));
    await page.getByRole('button', { name: 'Review print list', exact: true }).click();
    const controls = page.locator('.print-review-step .print-paper-controls');
    const savedDefault = controls.getByText('Browser default: US Letter', { exact: true });
    await savedDefault.waitFor();

    async function pressStatic(what) {
      await savedDefault.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await settle(page);
      const { x, y } = await (what === 'text' ? savedDefault : controls).evaluate((el, what) => {
        const rect = el.getBoundingClientRect();
        if (what === 'text') return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        for (let y = Math.ceil(rect.top + 1); y < rect.bottom; y += 3) {
          for (let x = Math.ceil(rect.left + 1); x < rect.right; x += 3) {
            if (document.elementFromPoint(x, y) === el) return { x, y };
          }
        }
        throw new Error('No blank point inside the paper controls');
      }, what);
      const start = await page.evaluate(() => {
        document.activeElement.blur();
        window.scrollTrace.length = 0;
        return window.scrollY;
      });
      assert.ok(start > 400, `${label} setup must scroll deep enough to expose a jump`);
      await (mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
      await settle(page);
      const result = await page.evaluate(() => ({
        end: window.scrollY, focus: document.activeElement.id, trace: window.scrollTrace.slice(),
      }));
      if (baseline) {
        assert.ok(result.end < 100, `${label} ${what}: baseline jumped from ${start} to ${result.end}`);
        assert.equal(result.focus, 'workspace-main');
        assert.ok(result.trace.some(e => e.event === 'focusin' && e.id === 'workspace-main'));
        assert.ok(result.trace.some(e => e.event === 'scrollBy' && e.active === 'workspace-main' && e.top < -300));
      } else {
        assert.ok(Math.abs(result.end - start) <= 1, `${label} ${what}: ${start} → ${result.end}`);
        assert.equal(result.trace.some(e => e.event === 'scrollBy' && e.active === 'workspace-main'), false);
      }
      console.log(`${label} on paper ${what}: ${start} → ${result.end}px`, baseline ? JSON.stringify(result.trace) : '');
    }

    await pressStatic('text');
    await pressStatic('blank space');
    if (!baseline) {
      const picker = controls.getByRole('combobox', { name: 'Paper and layout' });
      await picker.evaluate(el => {
        el.scrollIntoView({ block: 'center' });
        window.scrollBy(0, el.getBoundingClientRect().top - (innerHeight - 35));
        el.focus({ preventScroll: true });
      });
      await settle(page);
      assert.ok(await picker.evaluate(el => document.activeElement === el));
      assert.ok(await picker.evaluate(el => {
        const footer = document.querySelector('.print-review-footer').getBoundingClientRect();
        return el.getBoundingClientRect().bottom <= Math.min(window.innerHeight, footer.top);
      }), 'The focused picker should remain above the fixed bars');
      const beforeSelection = await page.evaluate(() => window.scrollY);
      await picker.selectOption('crowned-a4');
      await settle(page);
      assert.ok(await picker.evaluate(el => document.activeElement === el));
      assert.ok(await page.evaluate(start => Math.abs(window.scrollY - start) < 150, beforeSelection));

      const save = controls.getByRole('button', { name: 'Save as default', exact: true });
      await page.keyboard.press('Tab');
      assert.ok(await save.evaluate(el => document.activeElement === el));
      await save.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await settle(page);
      const beforeSave = await page.evaluate(() => window.scrollY);
      await (mobile ? save.tap() : save.click());
      await controls.getByText(/Browser default: Crowned A4/).waitFor();
      await settle(page);
      assert.equal(await page.evaluate(() => localStorage.getItem('clc-print-paper-default:1')), 'crowned-a4');
      const afterSave = await page.evaluate(() => window.scrollY);
      assert.ok(Math.abs(afterSave - beforeSave) < 150, `${label} Save as default: ${beforeSave} → ${afterSave}`);

      await page.getByRole('link', { name: 'Skip to content', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.scrollY < 100 && document.activeElement.id === 'workspace-main');
      await page.keyboard.press('Tab');
      assert.ok(await page.getByRole('link', { name: 'New print list', exact: true }).evaluate(el => document.activeElement === el));

      await controls.evaluate(el => el.scrollIntoView({ block: 'center' }));
      const navigation = page.getByRole('navigation', { name: mobile ? 'Mobile navigation' : 'Main navigation', exact: true });
      await navigation.getByRole('link', { name: 'Print', exact: true }).click();
      await page.waitForFunction(() => window.scrollY === 0);
      console.log(`${label}: picker focus, browser default, explicit Print navigation, and keyboard skip passed.`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
