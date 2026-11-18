import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import initSqlJs from 'sql.js';

const oldShare = {
  id: 'old-link', beforeText: '1 Lightning Bolt (M10) 146', afterText: '1 Counterspell (DMR) 45 *F*',
  title: 'An old link', createdAt: '2026-11-10 11:11:11',
};
const newShare = {
  beforeText: '1 Lightning Bolt (M10) 146\r\n\r\nSideboard\r\n1 Island',
  afterText: '1 Counterspell (DMR) 45 *F*\n',
  title: 'A new link',
};

let dir, db, server, baseUrl, alice, bob;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clc-share-'));
  const dbPath = join(dir, 'test.db');
  vi.stubEnv('DB_PATH', dbPath);
  vi.stubEnv('JWT_SECRET', 'disposable-share-test-jwt-secret');
  vi.resetModules();

  // Start from the old schema, including an actual anonymous share on disk.
  const SQL = await initSqlJs();
  const old = new SQL.Database();
  old.run(`CREATE TABLE shared_comparisons (
    id TEXT PRIMARY KEY, before_text TEXT NOT NULL, after_text TEXT NOT NULL,
    title TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  old.run('INSERT INTO shared_comparisons VALUES (?, ?, ?, ?, ?)', Object.values(oldShare));
  writeFileSync(dbPath, old.export());
  old.close();

  db = await import('../db.js');
  await db.initDb();
  db.run("INSERT INTO users (username, password_hash) VALUES ('alice', 'unused'), ('bob', 'unused')");
  const { createToken } = await import('../middleware/auth.js');
  alice = createToken({ id: 1, username: 'alice' });
  bob = createToken({ id: 2, username: 'bob' });

  const app = express();
  app.use(express.json());
  app.use('/api/share', (await import('./share.js')).default);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/api/share`;
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function request(path, { method = 'GET', token, body } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function create(token, body = newShare) {
  const response = await request('', { method: 'POST', token, body });
  expect(response.status).toBe(201);
  return response.json();
}

describe('comparison sharing compatibility', () => {
  it('migrates legacy links in place and preserves anonymous reads and creation', async () => {
    const legacy = await request('/old-link');
    expect(await legacy.json()).toEqual(oldShare);

    const anonymous = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic cHJveHktZml4dHVyZQ==' },
      body: JSON.stringify({ ...newShare, ownerUserId: 1 }),
    });
    expect(anonymous.status).toBe(201);
    const { id, url } = await anonymous.json();
    expect(url).toBe(`/share/${id}`);
    const publiclyReadable = await request(`/${id}`, { token: 'invalid-token' });
    expect(publiclyReadable.headers.get('Cache-Control')).toBe('no-store');
    expect(await publiclyReadable.json()).toEqual({ ...newShare, id, createdAt: expect.any(String) });

    expect(await (await request('/mine', { token: alice })).json()).toEqual({ shares: [] });
    expect((await request('/old-link', { token: alice, method: 'DELETE' })).status).toBe(404);
    expect((await request(`/${id}`, { token: alice, method: 'DELETE' })).status).toBe(404);
    expect((await request(`/${id}`)).status).toBe(200);
  });

  it('rejects invalid supplied credentials rather than claiming an anonymous share', async () => {
    const response = await request('', { method: 'POST', token: 'invalid-token', body: newShare });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'SESSION_INVALID' });
    expect(db.get('SELECT COUNT(*) AS total FROM shared_comparisons').total).toBe(1);
  });
});

describe('comparison share ownership and expiry', () => {
  it('lists only own metadata and denies all non-owner mutations', async () => {
    const { id } = await create(alice, { ...newShare, ownerUserId: 2 });
    const list = await request('/mine', { token: alice });
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    expect(await list.json()).toEqual({ shares: [{ id, title: newShare.title, createdAt: expect.any(String), expiresAt: null }] });
    expect(await (await request('/mine', { token: bob })).json()).toEqual({ shares: [] });
    expect((await request('/mine')).status).toBe(401);

    for (const method of ['PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { expiresAt: null } : undefined;
      const denied = await request(`/${id}`, { method, token: bob, body });
      const missing = await request('/absent', { method, token: bob, body });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual(await missing.json());
      expect((await request(`/${id}`, { method, body })).status).toBe(401);
    }
    expect(await (await request(`/${id}`)).json()).toMatchObject(newShare);
  });

  it('expires at the exact boundary, allows an owner to change expiry, and durably revokes the link', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { id } = await create(alice, { ...newShare, expiresAt });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) - 1);
    expect((await request(`/${id}`)).status).toBe(200);
    clock.mockReturnValue(Date.parse(expiresAt));
    expect((await request(`/${id}`)).status).toBe(404);
    expect((await (await request('/mine', { token: alice })).json()).shares[0].expiresAt).toBe(expiresAt);

    const until = new Date(Date.now() + 45_000).toISOString();
    const extended = await request(`/${id}`, { method: 'PATCH', token: alice, body: { expiresAt: until } });
    expect(await extended.json()).toEqual({ expiresAt: until });
    expect((await request(`/${id}`)).status).toBe(200);
    const cleared = await request(`/${id}`, { method: 'PATCH', token: alice, body: { expiresAt: null } });
    expect(await cleared.json()).toEqual({ expiresAt: null });
    expect((await request(`/${id}`, { token: alice, method: 'DELETE' })).status).toBe(200);
    expect((await request(`/${id}`)).status).toBe(404);
    await db.initDb();
    expect((await request(`/${id}`)).status).toBe(404);
    expect((await request('/old-link')).status).toBe(200);
  });

  it('rejects incomplete updates and malformed or past expiry without changing saved data', async () => {
    const { id } = await create(alice);
    const badExpiries = ['', new Date(Date.now() - 1000).toISOString(), '2099-02-31T00:00:00.000Z', 45];
    for (const expiresAt of badExpiries) {
      expect((await request('', { method: 'POST', token: alice, body: { ...newShare, expiresAt } })).status).toBe(400);
      expect((await request(`/${id}`, { method: 'PATCH', token: alice, body: { expiresAt } })).status).toBe(400);
    }
    expect((await request(`/${id}`, { method: 'PATCH', token: alice, body: { beforeText: 'changed', expiresAt: null } })).status).toBe(400);
    expect(await (await request(`/${id}`)).json()).toMatchObject(newShare);
  });

  it('removes an account’s owned links when that account is deleted and preserves legacy links', async () => {
    const { id } = await create(alice);
    db.run('DELETE FROM users WHERE id = 1');
    expect((await request(`/${id}`)).status).toBe(404);
    expect((await request('/old-link')).status).toBe(200);
  });
});
