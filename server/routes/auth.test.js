import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import bcrypt from 'bcryptjs';
import express from 'express';
import { hashToken } from '../lib/tokens.js';

const password = 'OldPassword1';
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();
const asSqlite = iso => iso.slice(0, 19).replace('T', ' ');
let dir, db, server, baseUrl;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clc-auth-'));
  vi.stubEnv('DB_PATH', join(dir, 'test.db'));
  vi.stubEnv('JWT_SECRET', 'disposable-test-jwt-secret');
  vi.resetModules();
  db = await import('../db.js');
  await db.initDb();
  db.run('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)', ['fixture', await bcrypt.hash(password, 4), 'fixture@example.test']);
  const app = express();
  app.use(express.json());
  app.use('/auth', (await import('./auth.js')).default);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/auth`;
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

function request(path, { body, token, method = 'POST' } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const login = value => request('/login', { body: { username: 'fixture', password: value } });
const user = () => db.get('SELECT * FROM users WHERE id = 1');

function addToken(table, token, expiresAt) {
  db.run(`INSERT INTO ${table} (user_id, token, expires_at) VALUES (1, ?, ?)`, [hashToken(token), expiresAt]);
}

describe('account lockout', () => {
  it('counts simultaneous bad passwords and locks out even a correct password', async () => {
    const allComparing = Promise.withResolvers();
    let comparisons = 0;
    const compare = bcrypt.compare.bind(bcrypt);
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (...args) => {
      if (++comparisons === 5) allComparing.resolve();
      await allComparing.promise;
      return compare(...args);
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () => login('WrongPassword1')));
    expect(responses.map(response => response.status).sort()).toEqual([401, 401, 401, 401, 429]);
    expect(user().failed_login_attempts).toBe(5);
    expect(new Date(user().locked_until).getTime()).toBeGreaterThan(Date.now());
    expect((await login(password)).status).toBe(429);
  });

  it.each([value => value, asSqlite])('honors a saved lock and restarts the count after expiry', async format => {
    db.run('UPDATE users SET failed_login_attempts = 5, locked_until = ?', [format(future())]);
    expect((await login(password)).status).toBe(429);
    db.run('UPDATE users SET locked_until = ?', [format(past())]);
    expect((await login('WrongPassword1')).status).toBe(401);
    expect(user()).toMatchObject({ failed_login_attempts: 1, locked_until: null });
    expect((await login(password)).status).toBe(200);
    expect(user()).toMatchObject({ failed_login_attempts: 0, locked_until: null });
  });
});

describe('account tokens', () => {
  it('verifies a legacy live link once and refuses a same-day expired ISO link', async () => {
    addToken('email_verification_tokens', 'expired-email', past());
    addToken('email_verification_tokens', 'live-email', asSqlite(future()));
    const verify = token => request('/verify-email', { body: { token } });
    expect((await verify('expired-email')).status).toBe(400);
    expect(user().email_verified).toBe(0);
    const responses = await Promise.all([verify('live-email'), verify('live-email')]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    expect(user().email_verified).toBe(1);
  });

  it('rejects an expired reset', async () => {
    addToken('password_reset_tokens', 'expired-reset', past());
    const response = await request('/reset-password', { body: { token: 'expired-reset', newPassword: 'ExpiredPassword1' } });
    expect(response.status).toBe(400);
    expect(await bcrypt.compare(password, user().password_hash)).toBe(true);
  });

  it('applies exactly one of two concurrent resets', async () => {
    addToken('password_reset_tokens', 'live-reset', asSqlite(future()));
    const reset = (token, newPassword) => request('/reset-password', { body: { token, newPassword } });
    const passwords = ['FirstPassword1', 'SecondPassword1'];
    const responses = await Promise.all(passwords.map(value => reset('live-reset', value)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    const winner = responses.findIndex(response => response.status === 200);
    expect(await bcrypt.compare(passwords[winner], user().password_hash)).toBe(true);
    expect((await reset('live-reset', 'ReplayPassword1')).status).toBe(400);
  });

  it('rolls back a password write when the token cannot be marked used', async () => {
    addToken('password_reset_tokens', 'live-reset', future());
    db.run("CREATE TRIGGER stop_consumption BEFORE UPDATE ON password_reset_tokens BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reset = () => request('/reset-password', { body: { token: 'live-reset', newPassword: 'SecondPassword1' } });
    expect((await reset()).status).toBe(500);
    expect(await bcrypt.compare(password, user().password_hash)).toBe(true);
    expect(db.get('SELECT used FROM password_reset_tokens').used).toBe(0);
    db.run('DROP TRIGGER stop_consumption');
    expect((await reset()).status).toBe(200);
  });

  it('invalidates a verification link when the email is cleared', async () => {
    addToken('email_verification_tokens', 'old-address', future());
    const { token } = await (await login(password)).json();
    expect((await request('/email', { method: 'PUT', body: { email: null }, token })).status).toBe(200);
    expect((await request('/verify-email', { body: { token: 'old-address' } })).status).toBe(400);
    expect(user()).toMatchObject({ email: null, email_verified: 0 });
  });

  it('gives new sessions distinct credentials and distinguishes password failures from an invalid bearer', async () => {
    const { token } = await (await login(password)).json();
    const nextSession = await (await login(password)).json();
    expect(nextSession.token).not.toBe(token);
    const incorrect = await request('/change-password', { token, body: { currentPassword: 'WrongPassword1', newPassword: 'NewPassword1' } });
    expect(incorrect.status).toBe(401);
    expect(await incorrect.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const invalid = await request('/me', { token: 'invalid-jwt', method: 'GET' });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ code: 'SESSION_INVALID' });
  });
});
