import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createApiRateLimiter } from './apiRateLimit.js';
import stationRoutes from '../routes/print-station.js';

const credential = 'rate-test-station-only-012345678901234567890123456789';
let server, origin;
beforeEach(async () => {
  vi.stubEnv('PRINT_STATION_TOKEN', credential);
  const app = express();
  app.set('trust proxy', 1);
  const general = rateLimit({ windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false });
  app.use('/api', createApiRateLimiter({ general, stationMax: 3 }));
  app.use(express.json());
  app.use('/api/print-station', stationRoutes);
  app.get('/api/browser', (_req, res) => res.json({ ok: true }));
  app.get('/api/print-station-management/status', (_req, res) => res.json({ fixture: true }));
  app.get('/api/print-station-impostor/status', (_req, res) => res.json({ fixture: true }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  vi.unstubAllEnvs();
});
const request = (path = '/print-station/status', token = credential, headers = {}) => fetch(origin + '/api' + path, {
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
});

describe('native print station rate isolation', () => {
  it('a browser-exhausted IP can still read the authenticated native protocol', async () => {
    expect((await request('/browser', null)).status).toBe(200);
    expect((await request('/browser', null)).status).toBe(200);
    expect((await request('/browser', null)).status).toBe(429);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stationId: 'household', protocolVersion: 1 });
    expect(response.headers.get('ratelimit-limit')).toBe('3');
    expect((await request()).status).toBe(200);
  });

  it('station traffic is separately bounded and does not consume the browser budget', async () => {
    for (let i = 0; i < 3; i++) expect((await request()).status).toBe(200);
    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('same operation') });
    expect((await request('/browser', null)).status).toBe(200);
    expect((await request('/browser', null)).status).toBe(200);
  });

  it('missing and invalid station credentials remain authenticated and generally rate-limited', async () => {
    expect((await request('/print-station/status', null)).status).toBe(401);
    expect((await request('/print-station/status', 'fake-user-jwt')).status).toBe(401);
    expect((await request('/print-station/status', 'fake-user-jwt')).status).toBe(429);
    expect((await request()).status).toBe(200);
  });

  it('a valid station token cannot exempt browser management or lookalike namespaces', async () => {
    expect((await request('/print-station-management/status')).status).toBe(200);
    expect((await request('/print-station-impostor/status')).status).toBe(200);
    expect((await request('/browser')).status).toBe(429);
    expect((await request()).status).toBe(200);
  });

  it('requires the exact Bearer form even when the secret is otherwise correct', async () => {
    expect((await request('/print-station/status', null, { Authorization: credential })).status).toBe(401);
    expect((await request('/print-station/status', null, { Authorization: 'Basic ' + credential })).status).toBe(401);
    expect((await request('/print-station/status', null)).status).toBe(429);
    expect((await request()).status).toBe(200);
  });

  it('rotation revokes the old bypass immediately without resetting the station allowance', async () => {
    expect((await request()).status).toBe(200);
    const replacement = credential + '-replacement';
    vi.stubEnv('PRINT_STATION_TOKEN', replacement);
    expect((await request()).status).toBe(401);
    expect((await request()).status).toBe(401);
    expect((await request()).status).toBe(429);
    expect((await request('/print-station/status', replacement)).status).toBe(200);
    expect((await request('/print-station/status', replacement)).status).toBe(200);
    expect((await request('/print-station/status', replacement)).status).toBe(429);
  });

  it('cannot reset the authenticated station allowance by changing client IP', async () => {
    for (let i = 1; i <= 3; i++) {
      expect((await request('/print-station/status', credential, { 'X-Forwarded-For': `192.0.2.${i}` })).status).toBe(200);
    }
    expect((await request('/print-station/status', credential, { 'X-Forwarded-For': '192.0.2.99' })).status).toBe(429);
  });

  it('unconfigured station traffic never acquires a privileged budget', async () => {
    vi.stubEnv('PRINT_STATION_TOKEN', '');
    expect((await request()).status).toBe(503);
    expect((await request()).status).toBe(503);
    expect((await request()).status).toBe(429);
  });
});
