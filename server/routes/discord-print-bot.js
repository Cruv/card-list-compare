import express, { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { discordPrintBotSettings, saveDiscordPrintBotSettings, registerDiscordPrintBotCommands, disconnectDiscordPrintBot, handleDiscordPrintInteraction } from '../lib/discordPrintBot.js';

export const discordPrintInteractionRouter = Router();
// This router MUST precede express.json() and body sanitizers: verification
// covers the exact timestamp + raw bytes supplied by Discord.
discordPrintInteractionRouter.post('/interactions', express.raw({ type: 'application/json', limit: '32kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(handleDiscordPrintInteraction(req.body, req.get('X-Signature-Ed25519'), req.get('X-Signature-Timestamp'))); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Discord printer command unavailable' }); }
});

const router = Router();
router.use(requireAuth, requireAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const route = callback => async (req, res) => {
  try { res.json(await callback(req)); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Discord printer command settings unavailable' }); }
};
router.get('/discord-bot', route(req => discordPrintBotSettings(req.user.userId)));
router.put('/discord-bot', route(req => saveDiscordPrintBotSettings(req.user.userId, req.body)));
router.post('/discord-bot/register', route(req => registerDiscordPrintBotCommands(req.user.userId, req.body)));
router.post('/discord-bot/disconnect', route(req => disconnectDiscordPrintBot(req.user.userId)));
export default router;
