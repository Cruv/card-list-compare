import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';

let directory, server, origin, db, snapshots, tokens, scopedToken, creatorToken, instanceId;
beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), 'clc-proposal-http-'));
  vi.stubEnv('DB_PATH', join(directory, 'test.db'));
  vi.stubEnv('JWT_SECRET', 'proposal-json-test-jwt-secret-only');
  db = await import('../db.js'); await db.initDb();
  const schema = await import('../lib/integrationSchema.js'); schema.initIntegrationSchema();
  instanceId = schema.getInstanceId();
  snapshots = await import('../lib/structuredSnapshots.js');
  const { createToken } = await import('./auth.js');
  tokens = [];
  for (const id of [1, 2]) {
    db.run('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [id, `user${id}`, 'unused']);
    tokens[id] = createToken({ id, username: `user${id}` });
  }
  db.run('INSERT INTO tracked_owners(id,user_id,archidekt_username) VALUES(1,1,?)', ['owner']);
  db.run('INSERT INTO tracked_decks(id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES(1,1,1,1,?)', ['Long draft']);
  db.run('INSERT INTO deck_snapshots(tracked_deck_id,deck_text) VALUES(1,?)', ['1 Sol Ring']);
  db.run('UPDATE tracked_decks SET paper_snapshot_id=1 WHERE id=1');
  const app = express();
  app.use((await import('./jsonBody.js')).default);
  app.use('/api/integrations/tokens', (await import('../routes/integrationTokens.js')).default);
  app.use('/api/decks', (await import('../routes/proposals.js')).default);
  const { createStructuredDeckRouter } = await import('../routes/structuredDecks.js');
  const { createSourceTrackingService } = await import('../lib/sourceTracking.js');
  app.use('/api/integrations/v1', createStructuredDeckRouter({
    trackSource: createSourceTrackingService({ refreshSource: async () => ({}) }),
  }));
  app.post('/api/unrelated', (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type || error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const issued = await request('/api/integrations/tokens', { name: 'ManaSync', scopes: ['decks:read', 'decks:propose'] });
  scopedToken = issued.body.token;
  creatorToken = (await request('/api/integrations/tokens', { name: 'Publish', scopes: ['decks:read', 'decks:create'] })).body.token;
});
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

async function request(path, body, { token = tokens[1], raw } = {}) {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const longText = (character, count = 500_000) => `//${character.repeat(count - 2)}`;
function submission(baseText = '1 Sol Ring', proposedText = '2 Sol Ring') {
  return { operationId: randomUUID(), baseSnapshotId: '1', baseTextHash: snapshots.textHash(baseText), baseText, proposedText };
}
function review(receipt, extra = {}) {
  return { operationId: randomUUID(), expectedProposalRevision: receipt.proposalRevision,
    expectedLatestSnapshotId: receipt.currentLatestSnapshotId, expectedLatestTextHash: receipt.currentLatestTextHash,
    action: 'accept', ...extra };
}

describe('authenticated proposal JSON limits', () => {
  it.each(['UTF-8', 'JSON-escaped'])('accepts and replays two exact maximum Unicode fields over HTTP (%s)', async encoding => {
    const baseText = longText('😀'), proposedText = longText('😁');
    db.run('UPDATE deck_snapshots SET deck_text=? WHERE id=1', [baseText]);
    const payload = submission(baseText, proposedText);
    const raw = encoding === 'JSON-escaped'
      ? JSON.stringify(payload).replace(/[\uD800-\uDFFF]/g, character => `\\u${character.charCodeAt(0).toString(16)}`)
      : JSON.stringify(payload);
    const submitted = await request('/api/decks/1/proposals', payload, { token: scopedToken, raw });
    expect(submitted.status).toBe(201);
    expect(submitted.body.baseText === baseText).toBe(true);
    expect(submitted.body.proposedText === proposedText).toBe(true);
    expect((await request('/api/decks/1/proposals', payload, { token: scopedToken, raw })).body.proposalId).toBe(submitted.body.proposalId);
    const decision = review(submitted.body);
    const path = `/api/decks/1/proposals/${submitted.body.proposalId}/review`;
    const accepted = await request(path, decision);
    expect(accepted.status).toBe(200);
    expect(accepted.body.resultTextHash).toBe(snapshots.textHash(proposedText));
    expect((await request(path, decision)).body.replayed).toBe(true);
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
    expect(db.get('SELECT paper_snapshot_id FROM tracked_decks WHERE id=1').paper_snapshot_id).toBe(1);
  });

  it('accepts an exact maximum reviewed replacement and preserves its receipt/version guards', async () => {
    const submitted = await request('/api/decks/1/proposals', submission(), { token: scopedToken });
    const decision = review(submitted.body, { action: 'revise', reviewedText: longText('😀') });
    const path = `/api/decks/1/proposals/${submitted.body.proposalId}/review`;
    const revised = await request(path, decision);
    expect(revised.status).toBe(200);
    expect(revised.body.status).toBe('revised');
    expect(snapshots.latestSnapshot(1).deck_text === decision.reviewedText).toBe(true);
    expect((await request(path, decision)).body.replayed).toBe(true);
    expect((await request(path, { ...decision, operationId: randomUUID() })).body.error).toBe('proposal_changed');
    expect((await request(path, { ...decision, reviewedText: '3 Sol Ring' })).body.error).toBe('operation_conflict');
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
  });

  it.each(['baseText', 'proposedText'])('rejects a %s field one Unicode character over the limit without storing a proposal', async field => {
    const payload = { ...submission(), [field]: longText('😀', 500_001) };
    if (field === 'baseText') payload.baseTextHash = snapshots.textHash(payload.baseText);
    const result = await request('/api/decks/1/proposals', payload, { token: scopedToken });
    expect(result).toMatchObject({ status: 400, body: { error: 'invalid_proposal' } });
    expect(db.get('SELECT COUNT(*) AS count FROM deck_proposals').count).toBe(0);
  });

  it('rejects a reviewed replacement one character over the limit without deciding or creating a snapshot', async () => {
    const submitted = await request('/api/decks/1/proposals', submission(), { token: scopedToken });
    const result = await request(`/api/decks/1/proposals/${submitted.body.proposalId}/review`,
      review(submitted.body, { action: 'revise', reviewedText: longText('😀', 500_001) }));
    expect(result).toMatchObject({ status: 400, body: { error: 'invalid_review' } });
    expect(db.get('SELECT status FROM deck_proposals').status).toBe('pending_review');
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(1);
  });

  it('retains the global envelope limit and authenticates larger proposal/review envelopes first', async () => {
    const oversized = { proposedText: 'x'.repeat(600_000) };
    expect((await request('/api/unrelated', oversized)).status).toBe(413);
    expect((await request('/api/decks/1/snapshots/manual', oversized)).status).toBe(413);
    expect((await request('/api/decks/1/proposals', oversized, { token: null })).status).toBe(401);
    const reader = await request('/api/integrations/tokens', { name: 'Reader', scopes: ['decks:read'] });
    expect((await request('/api/decks/1/proposals', oversized, { token: reader.body.token })).status).toBe(403);
    expect((await request('/api/decks/1/proposals/example/review', oversized, { token: scopedToken })).status).toBe(401);
    expect((await request('/api/decks/1/proposals', submission(), { token: tokens[2] })).status).toBe(404);
    const tooLarge = JSON.stringify({ proposedText: 'x'.repeat(12 * 1024 * 1024) });
    expect((await request('/api/decks/1/proposals', null, { token: scopedToken, raw: tooLarge })).status).toBe(413);
    expect((await request('/api/decks/1/proposals/example/review', null, { raw: tooLarge })).status).toBe(413);
  });
});

describe.each([
  { path: '/api/integrations/v1/decks', error: 'invalid_deck_creation' },
  { path: '/api/integrations/v1/decks/track-source', error: 'invalid_source_tracking',
    sourceLink: { provider: 'archidekt', deckId: '123', url: 'https://archidekt.com/decks/123' } },
])('integration deck text limits at $path', ({ path, error, sourceLink }) => {
  const payload = (deckText = longText('😀')) => ({ operationId: randomUUID(), name: 'Unicode deck',
    deckText, expectedInstanceId: instanceId, expectedAccountId: '1', ...(sourceLink ? { sourceLink } : {}) });

  it.each(['UTF-8', 'JSON-escaped'])('publishes maximum Unicode text once with an explicit creation grant (%s)', async encoding => {
    const input = payload();
    const raw = encoding === 'JSON-escaped'
      ? JSON.stringify(input).replace(/[\uD800-\uDFFF]/g, character => `\\u${character.charCodeAt(0).toString(16)}`)
      : JSON.stringify(input);
    const first = await request(path, input, { token: creatorToken, raw });
    expect(first.status).toBe(201);
    expect(first.body.decks[0].snapshots[0].deckText === input.deckText).toBe(true);
    expect(first.body.decks[0].paperSnapshotId).toBeNull();
    const replay = await request(path, input, { token: creatorToken, raw });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } });
    expect(replay.body.decks[0].id).toBe(first.body.decks[0].id);
    expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(2);
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
  });

  it('rejects a field one Unicode character over the limit without publishing', async () => {
    const result = await request(path, payload(longText('😀', 500_001)), { token: creatorToken });
    expect(result).toMatchObject({ status: 400, body: { error } });
    expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(1);
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(1);
  });

  it('authenticates the explicit creation grant before larger parsing and keeps its envelope bounded', async () => {
    const input = payload();
    expect((await request(path, input, { token: scopedToken })).status).toBe(403);
    expect((await request(path, input)).status).toBe(403);
    expect((await request(path, input, { token: null })).status).toBe(401);
    expect((await request(path, null, { token: creatorToken,
      raw: JSON.stringify({ deckText: 'x'.repeat(12 * 1024 * 1024) }) })).status).toBe(413);
    expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(1);
  });
});
