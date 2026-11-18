import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ getJob: vi.fn(), verify: vi.fn() }));
vi.mock('../lib/printQueue.js', async importOriginal => ({ ...await importOriginal(),
  getOwnedPrintJob: fixture.getJob, ownedPrintArtifact: fixture.verify }));

let db, dir, auth, server, url, token;
beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'clc-browser-pdf-auth-'));
  vi.stubEnv('DB_PATH', join(dir, 'fixture.db'));
  vi.stubEnv('JWT_SECRET', 'disposable-test-jwt-secret');
  db = await import('../db.js');
  auth = await import('../middleware/auth.js');
  await db.initDb();
  db.run("INSERT INTO users (username, password_hash) VALUES ('fixture', 'unused')");
  token = auth.createToken(db.get('SELECT * FROM users WHERE id = 1'));
  const app = express();
  app.use(express.json());
  const routes = await import('./print.js');
  app.use('/api/print-lists', routes.standalonePrintRouter);
  app.use('/api/print-downloads', routes.printDownloadsRouter);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  rmSync(dir, { recursive: true, force: true });
});

it.each(['native', 'bearer'])('rechecks account state after artifact verification before sending %s PDF bytes', async mode => {
  const path = join(dir, 'fronts.pdf');
  const bytes = '%PDF-1.4\nPrivate PDF\n%%EOF\n';
  writeFileSync(path, bytes);
  const artifact = { id: 'fronts', sha256: 'test-hash', size: bytes.length, path };
  fixture.getJob.mockReturnValue({ manifestSha256: 'manifest-hash', state: 'ready', artifacts: [artifact] });
  const hashing = Promise.withResolvers();
  const complete = Promise.withResolvers();
  fixture.verify.mockImplementation(() => { hashing.resolve(); return complete.promise; });
  const artifactUrl = `${url}/api/print-lists/jobs/fixture/artifacts/fronts`;
  let transfer;
  if (mode === 'native') {
    const ticket = await fetch(`${artifactUrl}/download`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const { url: grantedUrl } = await ticket.json();
    transfer = fetch(url + grantedUrl, { headers: { Cookie: ticket.headers.get('set-cookie').split(';')[0] } });
  } else transfer = fetch(artifactUrl, { headers: { Authorization: `Bearer ${token}` } });
  await hashing.promise;
  db.run('UPDATE users SET suspended = 1 WHERE id = 1');
  auth.invalidateAuthCache(1);
  complete.resolve(artifact);
  const response = await transfer;
  expect(response.status).toBe(403);
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({ error: 'Account suspended' });
});

it('keeps native attachment status private to the original authenticated session', async () => {
  fixture.getJob.mockReturnValue({ manifestSha256: 'manifest-hash', state: 'ready', artifacts: [{ id: 'fronts', sha256: 'test-hash' }] });
  const ticket = await fetch(`${url}/api/print-lists/jobs/fixture/artifacts/fronts/download`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportStatus: true }),
  });
  const { url: grantedUrl } = await ticket.json();
  const replacement = auth.createToken(db.get('SELECT * FROM users WHERE id = 1'));
  const statusUrl = `${url}${grantedUrl}/status`;
  const denied = await fetch(statusUrl, { headers: { Authorization: `Bearer ${replacement}` } });
  expect(denied.status).toBe(404);
  expect(denied.headers.get('cache-control')).toBe('private, no-store');
  const pending = await fetch(statusUrl, { headers: { Authorization: `Bearer ${token}` } });
  expect(await pending.json()).toEqual({ state: 'pending' });
});

it.each(['removed', 'replaced'])('rechecks the opened file after the verified PDF was %s', async state => {
  const { printFileFingerprint } = await import('../lib/printPdfHash.js');
  const path = join(dir, 'fronts.pdf');
  const bytes = '%PDF-1.4\nPrivate PDF\n%%EOF\n';
  writeFileSync(path, bytes);
  const artifact = { id: 'fronts', sha256: 'test-hash', size: bytes.length, path, fingerprint: printFileFingerprint(path) };
  fixture.getJob.mockReturnValue({ manifestSha256: 'manifest-hash', state: 'ready', artifacts: [artifact] });
  fixture.verify.mockImplementation(async () => {
    if (state === 'removed') unlinkSync(path);
    else {
      writeFileSync(`${path}.tmp`, bytes);
      renameSync(`${path}.tmp`, path);
    }
    return artifact;
  });
  const ticket = await fetch(`${url}/api/print-lists/jobs/fixture/artifacts/fronts/download`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportStatus: true }),
  });
  const { url: grantedUrl } = await ticket.json();
  const attachment = await fetch(url + grantedUrl, { headers: { Cookie: ticket.headers.get('set-cookie').split(';')[0] } });
  expect(attachment.status).toBe(state === 'removed' ? 410 : 409);
  expect(attachment.headers.get('content-disposition')).toBeNull();
  const receipt = await fetch(`${url}${grantedUrl}/status`, { headers: { Authorization: `Bearer ${token}` } });
  expect(await receipt.json()).toMatchObject({ state: 'failed', error: expect.stringContaining('Refresh batches') });
});
