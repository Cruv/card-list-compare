import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { describePrintProof, downloadPrintProof } from '../lib/printGenerator.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const route = callback => async (req, res) => {
  try { await callback(req, res); }
  catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'The paper proof could not be prepared. Try again shortly.' }); }
};

router.get('/:paper', route((req, res) => res.json({ proof: describePrintProof(req.params.paper, req.query.marks ?? 'on',
  req.query.dahleAlignmentMarks, req.query.dahleCutGuides) })));
router.get('/:paper/pdf', route(async (req, res) => {
  const { proof, pdf } = await downloadPrintProof(req.params.paper, req.query.marks ?? 'on', req.query.key,
    req.query.dahleAlignmentMarks, req.query.dahleCutGuides);
  const marks = proof.dahleCutGuides ? 'dahle-cut-guides' : proof.dahleAlignmentMarks ? 'die-alignment' : proof.registrationMarks ? 'marks' : 'no-marks';
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length),
    'Content-Disposition': `attachment; filename="${proof.recipeId}-${marks}-${proof.revision.slice(0, 12)}-proof.pdf"`,
    'Cache-Control': 'private, no-store, no-transform', 'X-CLC-Proof-Key': proof.key }).send(pdf);
}));

export default router;
