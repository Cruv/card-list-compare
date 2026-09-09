import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

let directory, db, proposals, snapshots, baseId, baseText;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'clc-proposals-'));
  process.env.DB_PATH = join(directory, 'test.db');
  vi.resetModules();
  db = await import('../db.js');
  await db.initDb();
  const { initIntegrationSchema } = await import('./integrationSchema.js');
  initIntegrationSchema();
  proposals = await import('./deckProposals.js');
  snapshots = await import('./structuredSnapshots.js');
  for (const [id, name] of [[1,'alice'],[2,'bob']]) {
    db.run('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)', [id,name,'test']);
    db.run('INSERT INTO tracked_owners (id,user_id,archidekt_username) VALUES (?,?,?)', [id,id,name]);
    db.run('INSERT INTO tracked_decks (id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES (?,?,?,?,?)', [id,id,id,id,`${name} deck`]);
  }
  baseText = 'Commander\r\n1 Test Commander\r\nMainboard\r\n1 Sol Ring (CMM) 410\r\n// saved note\r\n';
  baseId = addSnapshot(baseText);
  db.run('UPDATE tracked_decks SET paper_snapshot_id = ? WHERE id = 1', [baseId]);
});
afterEach(() => { delete process.env.DB_PATH; rmSync(directory, { recursive: true, force: true }); });

function addSnapshot(text, deckId = 1) {
  return String(db.run('INSERT INTO deck_snapshots (tracked_deck_id,deck_text) VALUES (?,?)', [deckId,text]).lastInsertRowid);
}
function submission(overrides = {}) {
  return { operationId: randomUUID(), baseSnapshotId: baseId, baseTextHash: snapshots.textHash(baseText), baseText,
    proposedText: `${baseText}1 Arcane Signet\n`, ...overrides };
}
function review(receipt, overrides = {}) {
  return { operationId: randomUUID(), expectedProposalRevision: receipt.proposalRevision,
    expectedLatestSnapshotId: receipt.currentLatestSnapshotId, expectedLatestTextHash: receipt.currentLatestTextHash,
    action: 'accept', ...overrides };
}

describe('deck proposals', () => {
  it('stores the exact immutable base without changing latest, paper, or holdings; duplicate operations replay', () => {
    const input = submission();
    const first = proposals.submitProposal(1, '1', input);
    expect(first.receipt.baseText).toBe(baseText);
    expect(first.receipt.status).toBe('pending_review');
    expect(first.receipt.currentLatestSnapshotId).toBe(baseId);
    expect(proposals.submitProposal(1, '1', input).receipt.proposalId).toBe(first.receipt.proposalId);
    expect(() => proposals.submitProposal(1, '1', { ...input, proposedText: '2 Sol Ring' })).toThrow('operation_conflict');
    expect(() => proposals.submitProposal(1, '1', { ...input, baseText: 'changed without rehashing' })).toThrow('operation_conflict');
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(1);
    expect(String(db.get('SELECT paper_snapshot_id FROM tracked_decks WHERE id = 1').paper_snapshot_id)).toBe(baseId);
    expect(db.get('SELECT COUNT(*) AS count FROM collection_cards').count).toBe(0);
  });

  it('atomically accepts once, preserves paper, records provenance, and replays a lost review response after restart', async () => {
    const input = submission();
    const receipt = proposals.submitProposal(1, '1', input).receipt;
    const operation = review(receipt);
    const result = proposals.reviewProposal(1,'1',receipt.proposalId,operation);
    expect(result.status).toBe('accepted');
    expect(result.resultTextHash).toBe(snapshots.textHash(input.proposedText));
    const latest = snapshots.latestSnapshot(1);
    expect(String(latest.id)).toBe(result.resultSnapshotId);
    expect(snapshots.serializeSnapshot(latest,latest.id,Number(baseId)).origin).toEqual({ source:'manasync',proposalId:receipt.proposalId,operationId:input.operationId });
    expect(db.get('SELECT paper_snapshot_id FROM tracked_decks WHERE id = 1').paper_snapshot_id).toBe(Number(baseId));
    vi.resetModules();
    db = await import('../db.js'); await db.initDb();
    proposals = await import('./deckProposals.js');
    expect(proposals.reviewProposal(1,'1',receipt.proposalId,operation)).toMatchObject({ ...result, replayed:true });
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
    expect(() => proposals.reviewProposal(1,'1',receipt.proposalId,{...operation,action:'reject'})).toThrow('operation_conflict');
  });

  it('uses IDs to distinguish same-second snapshots and forces visible review after upstream changes', () => {
    const first = proposals.submitProposal(1,'1',submission()).receipt;
    const nextId = addSnapshot('1 Island');
    const latest = snapshots.latestSnapshot(1);
    expect(String(latest.id)).toBe(nextId);
    expect(() => proposals.reviewProposal(1,'1',first.proposalId,review(first))).toThrow('latest_changed');
    const stale = proposals.readProposal(1,'1',first.proposalId);
    expect(stale.status).toBe('needs_rebase');
    expect(stale.proposalRevision).toBe(first.proposalRevision + 1);
    expect(() => proposals.reviewProposal(1,'1',first.proposalId,review(stale))).toThrow(/digital latest changed/);
    const chosen = 'Mainboard\n1 Island\n1 Sol Ring';
    const revised = proposals.reviewProposal(1,'1',first.proposalId,review(stale,{action:'revise',reviewedText:chosen}));
    expect(revised.status).toBe('revised');
    expect(snapshots.latestSnapshot(1).deck_text).toBe(chosen);
    expect(revised.baseText).toBe(baseText);
  });

  it.each(['accept', 'revise'])('%s replaces commander metadata when the old commander moves to mainboard', action => {
    db.run('UPDATE tracked_decks SET commanders = ? WHERE id = 1', [JSON.stringify(['Test Commander'])]);
    const replacement = 'Commander\n1 New Commander\nMainboard\n1 Test Commander\n1 Sol Ring';
    const receipt = proposals.submitProposal(1, '1', submission({ proposedText: replacement })).receipt;
    proposals.reviewProposal(1, '1', receipt.proposalId, review(receipt, {
      action, ...(action === 'revise' ? { reviewedText: replacement } : {}),
    }));
    expect(JSON.parse(db.get('SELECT commanders FROM tracked_decks WHERE id = 1').commanders)).toEqual(['New Commander']);
    expect(snapshots.latestSnapshot(1).deck_text).toBe(replacement);
  });

  it.each([
    { name: 'inline commander designation', before: '1 Test Commander\n1 Sol Ring', after: '1 Test Commander\n1 New Commander (Commander)', expected: ['New Commander'] },
    { name: 'removal of the latest explicit commander', before: 'Commander\n1 Test Commander\nMainboard\n1 Sol Ring', after: 'Mainboard\n1 Test Commander\n1 Sol Ring', expected: [] },
    { name: 'an explicitly empty command zone', before: '1 Test Commander\n1 Sol Ring', after: 'Commander\nMainboard\n1 Test Commander\n1 Sol Ring', expected: [] },
    { name: 'manual metadata on an untagged draft', before: '1 Test Commander\n1 Sol Ring', after: '1 Test Commander\n2 Sol Ring', expected: ['Test Commander'] },
  ])('respects $name when accepting reviewed text', ({ before, after, expected }) => {
    const latestId = addSnapshot(before);
    db.run('UPDATE tracked_decks SET commanders = ? WHERE id = 1', [JSON.stringify(['Test Commander'])]);
    const receipt = proposals.submitProposal(1, '1', submission({
      baseSnapshotId: latestId, baseText: before, baseTextHash: snapshots.textHash(before), proposedText: after,
    })).receipt;
    proposals.reviewProposal(1, '1', receipt.proposalId, review(receipt));
    expect(JSON.parse(db.get('SELECT commanders FROM tracked_decks WHERE id = 1').commanders)).toEqual(expected);
  });

  it('preserves manual commanders on an untagged current latest when revising an obsolete tagged proposal', () => {
    const receipt = proposals.submitProposal(1, '1', submission()).receipt;
    addSnapshot('1 Test Commander\n1 Sol Ring');
    db.run('UPDATE tracked_decks SET commanders = ? WHERE id = 1', [JSON.stringify(['Test Commander'])]);
    const stale = proposals.readProposal(1, '1', receipt.proposalId);
    proposals.reviewProposal(1, '1', receipt.proposalId, review(stale, {
      action: 'revise', reviewedText: '1 Test Commander\n2 Sol Ring',
    }));
    expect(JSON.parse(db.get('SELECT commanders FROM tracked_decks WHERE id = 1').commanders)).toEqual(['Test Commander']);
  });

  it('retains the basis when pruned; rejects without creating a snapshot and blocks another review', () => {
    const first = proposals.submitProposal(1,'1',submission()).receipt;
    db.run('DELETE FROM deck_snapshots WHERE id = ?', [baseId]);
    const receipt = proposals.readProposal(1,'1',first.proposalId);
    expect(receipt.baseText).toBe(baseText);
    expect(receipt.status).toBe('needs_rebase');
    const result = proposals.reviewProposal(1,'1',receipt.proposalId,review(receipt,{action:'reject'}));
    expect(result.resultSnapshotId).toBeNull();
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(0);
    expect(() => proposals.reviewProposal(1,'1',receipt.proposalId,review(receipt,{action:'reject'}))).toThrow('proposal_changed');
  });

  it('isolates accounts and rejects normalized or fabricated basis text', () => {
    const receipt = proposals.submitProposal(1,'1',submission()).receipt;
    expect(() => proposals.submitProposal(2,'1',submission())).toThrow('deck_not_found');
    expect(() => proposals.readProposal(2,'1',receipt.proposalId)).toThrow('deck_not_found');
    expect(() => proposals.readProposal(2,'2',receipt.proposalId)).toThrow('proposal_not_found');
    expect(() => proposals.reviewProposal(2,'2',receipt.proposalId,review(receipt))).toThrow('proposal_not_found');
    expect(() => proposals.submitProposal(1,'1',submission({baseText:baseText.trim()}))).toThrow(/exact saved base text/);
    expect(() => proposals.submitProposal(1,'1',submission({baseText:'fabricated',baseTextHash:snapshots.textHash('fabricated')}))).toThrow(/supplied base differs/);
  });

  it('rolls back snapshot and decision together if storing the review receipt fails', () => {
    db.run('UPDATE tracked_decks SET commanders = ? WHERE id = 1', [JSON.stringify(['Test Commander'])]);
    const receipt = proposals.submitProposal(1,'1',submission({ proposedText: 'Commander\n1 New Commander\nMainboard\n1 Sol Ring' })).receipt;
    db.run("CREATE TRIGGER fail_review BEFORE INSERT ON proposal_reviews BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    expect(() => proposals.reviewProposal(1,'1',receipt.proposalId,review(receipt))).toThrow('receipt failure');
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(1);
    expect(JSON.parse(db.get('SELECT commanders FROM tracked_decks WHERE id = 1').commanders)).toEqual(['Test Commander']);
    expect(proposals.readProposal(1,'1',receipt.proposalId).status).toBe('pending_review');
  });

  it('later source refreshes stay latest while accepted proposal receipts keep their own result', () => {
    const receipt = proposals.submitProposal(1,'1',submission()).receipt;
    const operation = review(receipt);
    const accepted = proposals.reviewProposal(1,'1',receipt.proposalId,operation);
    const newer = addSnapshot('1 Newer Source Card');
    const polled = proposals.readProposal(1,'1',receipt.proposalId);
    expect(polled.resultSnapshotId).toBe(accepted.resultSnapshotId);
    expect(polled.currentLatestSnapshotId).toBe(newer);
    proposals.reviewProposal(1,'1',receipt.proposalId,operation);
    expect(String(snapshots.latestSnapshot(1).id)).toBe(newer);
  });
});
