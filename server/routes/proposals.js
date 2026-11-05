import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireIntegration } from '../middleware/integrationAuth.js';
import { ProposalError, submitProposal, readProposal, listProposals, reviewProposal } from '../lib/deckProposals.js';

const router = Router();
const handle = fn => (req, res, next) => {
  try { fn(req, res); } catch (error) {
    if (error instanceof ProposalError) res.status(error.status).json({ error: error.code, message: error.message });
    else next(error);
  }
};

router.post('/:deckId/proposals', requireIntegration('decks:propose'), handle((req, res) => {
  const result = submitProposal(req.user.userId, req.params.deckId, req.body);
  res.status(result.replayed ? 200 : 201).json({ ...result.receipt, replayed: result.replayed });
}));
router.get('/:deckId/proposals', requireAuth, handle((req, res) => {
  res.json({ proposals: listProposals(req.user.userId, req.params.deckId) });
}));
router.get('/:deckId/proposals/:proposalId', requireIntegration('decks:propose'), handle((req, res) => {
  res.json(readProposal(req.user.userId, req.params.deckId, req.params.proposalId));
}));
// An external integration may suggest edits. Only an interactive account session
// can decide to make those suggestions the digital latest.
router.post('/:deckId/proposals/:proposalId/review', requireAuth, handle((req, res) => {
  res.json(reviewProposal(req.user.userId, req.params.deckId, req.params.proposalId, req.body));
}));

export default router;
