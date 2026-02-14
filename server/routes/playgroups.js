import { Router } from 'express';
import crypto from 'crypto';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// List my playgroups
router.get('/', (req, res) => {
  const groups = all(`
    SELECT p.id, p.name, p.invite_code, p.created_by, p.created_at,
           pm.role,
           (SELECT COUNT(*) FROM playgroup_members WHERE playgroup_id = p.id) as member_count,
           (SELECT COUNT(*) FROM playgroup_decks WHERE playgroup_id = p.id) as deck_count
    FROM playgroups p
    JOIN playgroup_members pm ON pm.playgroup_id = p.id AND pm.user_id = ?
    ORDER BY p.name ASC
  `, [req.user.userId]);

  res.json({ playgroups: groups });
});

// Create playgroup
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (name.length > 100) {
    return res.status(400).json({ error: 'Name must be under 100 characters' });
  }

  const inviteCode = crypto.randomBytes(4).toString('hex');

  const result = run(
    'INSERT INTO playgroups (name, invite_code, created_by) VALUES (?, ?, ?)',
    [name.trim(), inviteCode, req.user.userId]
  );

  // Add creator as owner
  run(
    'INSERT INTO playgroup_members (playgroup_id, user_id, role) VALUES (?, ?, ?)',
    [result.lastInsertRowid, req.user.userId, 'owner']
  );

  const group = get('SELECT * FROM playgroups WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json({ playgroup: { ...group, role: 'owner', member_count: 1, deck_count: 0 } });
});

// Join playgroup via invite code
router.post('/join', (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode || typeof inviteCode !== 'string') {
    return res.status(400).json({ error: 'Invite code is required' });
  }

  const group = get('SELECT * FROM playgroups WHERE invite_code = ?', [inviteCode.trim()]);
  if (!group) {
    return res.status(404).json({ error: 'Invalid invite code' });
  }

  const existing = get(
    'SELECT * FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?',
    [group.id, req.user.userId]
  );
  if (existing) {
    return res.status(409).json({ error: 'You are already in this playgroup' });
  }

  run(
    'INSERT INTO playgroup_members (playgroup_id, user_id, role) VALUES (?, ?, ?)',
    [group.id, req.user.userId, 'member']
  );

  res.json({ playgroup: group });
});

// Get playgroup details with members and decks
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid playgroup ID' });

  const membership = get(
    'SELECT * FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?',
    [id, req.user.userId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Playgroup not found' });
  }

  const group = get('SELECT * FROM playgroups WHERE id = ?', [id]);
  const members = all(`
    SELECT pm.user_id, pm.role, pm.joined_at, u.username
    FROM playgroup_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.playgroup_id = ?
    ORDER BY pm.role DESC, u.username ASC
  `, [id]);

  const decks = all(`
    SELECT pd.id as share_id, pd.shared_at,
           d.id as deck_id, d.deck_name, d.commanders, d.last_refreshed_at,
           u.username as shared_by_username,
           (SELECT COUNT(*) FROM deck_snapshots s WHERE s.tracked_deck_id = d.id) as snapshot_count
    FROM playgroup_decks pd
    JOIN tracked_decks d ON d.id = pd.tracked_deck_id
    JOIN users u ON u.id = pd.shared_by
    WHERE pd.playgroup_id = ?
    ORDER BY d.deck_name ASC
  `, [id]);

  res.json({ playgroup: group, members, decks, role: membership.role });
});

// Share a deck to a playgroup
router.post('/:id/decks', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid playgroup ID' });

  const membership = get(
    'SELECT * FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?',
    [id, req.user.userId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Playgroup not found' });
  }

  const { deckId } = req.body;
  if (!deckId) return res.status(400).json({ error: 'deckId is required' });

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, req.user.userId]);
  if (!deck) {
    return res.status(404).json({ error: 'Deck not found' });
  }

  const existing = get(
    'SELECT * FROM playgroup_decks WHERE playgroup_id = ? AND tracked_deck_id = ?',
    [id, deckId]
  );
  if (existing) {
    return res.status(409).json({ error: 'Deck already shared in this playgroup' });
  }

  run(
    'INSERT INTO playgroup_decks (playgroup_id, tracked_deck_id, shared_by) VALUES (?, ?, ?)',
    [id, deckId, req.user.userId]
  );

  res.status(201).json({ success: true });
});

// Remove a deck from a playgroup
router.delete('/:id/decks/:deckShareId', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deckShareId = parseInt(req.params.deckShareId, 10);
  if (isNaN(id) || isNaN(deckShareId)) return res.status(400).json({ error: 'Invalid ID' });

  const membership = get(
    'SELECT * FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?',
    [id, req.user.userId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Playgroup not found' });
  }

  const deckShare = get('SELECT * FROM playgroup_decks WHERE id = ? AND playgroup_id = ?', [deckShareId, id]);
  if (!deckShare) {
    return res.status(404).json({ error: 'Shared deck not found' });
  }

  // Only owner or the person who shared can remove
  if (membership.role !== 'owner' && deckShare.shared_by !== req.user.userId) {
    return res.status(403).json({ error: 'Only the deck sharer or group owner can remove shared decks' });
  }

  run('DELETE FROM playgroup_decks WHERE id = ?', [deckShareId]);
  res.json({ success: true });
});

// Leave playgroup
router.delete('/:id/leave', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid playgroup ID' });

  const membership = get(
    'SELECT * FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?',
    [id, req.user.userId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Playgroup not found' });
  }

  // If owner and last member, delete the group
  const memberCount = get('SELECT COUNT(*) as count FROM playgroup_members WHERE playgroup_id = ?', [id]);
  if (membership.role === 'owner' && memberCount.count > 1) {
    return res.status(400).json({ error: 'Transfer ownership before leaving (not yet implemented — remove other members first)' });
  }

  run('DELETE FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?', [id, req.user.userId]);

  // If no members left, delete the group
  const remaining = get('SELECT COUNT(*) as count FROM playgroup_members WHERE playgroup_id = ?', [id]);
  if (remaining.count === 0) {
    run('DELETE FROM playgroups WHERE id = ?', [id]);
  }

  res.json({ success: true });
});

export default router;
