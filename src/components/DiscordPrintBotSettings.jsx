import { useEffect, useState } from 'react';
import { getDiscordPrintBotSettings, saveDiscordPrintBotSettings, registerDiscordPrintBotCommands, disconnectDiscordPrintBot } from '../lib/api';
import './DiscordPrintBotSettings.css';

const empty = { applicationId: '', publicKey: '', guildId: '', channelId: '', operatorDiscordId: '' };
const fields = [
  ['applicationId', 'Application ID', 'General Information in the Developer Portal'],
  ['publicKey', 'Public key', 'The 64-character public key in General Information'],
  ['guildId', 'Discord server ID', 'Enable Discord Developer Mode, then copy the server ID'],
  ['channelId', 'Printer channel ID', 'Commands are accepted only in this channel'],
  ['operatorDiscordId', 'Your Discord user ID', 'Only this person can control printing through Discord'],
];

export default function DiscordPrintBotSettings({ defaultOperatorDiscordId = '' }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(empty);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getDiscordPrintBotSettings(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSettings(value);
      setForm(Object.fromEntries(Object.keys(empty).map(key => [key, value[key] || (key === 'operatorDiscordId' ? defaultOperatorDiscordId : '')])));
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [defaultOperatorDiscordId]);

  async function act(callback, success) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await callback();
      setSettings(next);
      setForm(Object.fromEntries(Object.keys(empty).map(key => [key, next[key] || (key === 'operatorDiscordId' ? defaultOperatorDiscordId : '')])));
      setNotice(success);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); setToken(''); }
  }

  const hasUnsavedChanges = settings?.configured && Object.keys(empty).some(key => form[key] !== settings[key]);
  const endpoint = settings?.endpointUrl || `${window.location.origin}/api/discord/interactions`;
  const secureEndpoint = endpoint.startsWith('https://');
  const state = !settings?.configured ? 'Setup needed' : !settings.operatorActive ? 'Operator access removed'
    : settings.registeredAt ? 'Commands registered' : 'Finish Discord setup';

  return <details className="station-card station-management station-discord-bot" aria-label="Discord printer commands">
    <summary><span className="station-disclosure-title"><span>Discord printer commands<small>Check status and continue after fixing the printer</small></span></span><span className="station-badge">{state}</span></summary>
    <div className="station-disclosure-content">
      <p>Connect a Discord application to use <code>/proxy status</code> and <code>/proxy continue batch:…</code> in the printer channel. Your existing webhook still sends alerts.</p>
      <p className="station-small">The continue command confirms that you fixed the problem and loaded the correct paper. For a canceled pass, also enter the first unprinted sheet’s position within that interrupted attempt, starting at 1. Use its position in the displayed print order, rather than its PDF page number. Back-side recovery requires the paper check in CLC.</p>
      <p className="station-small">Changing or disconnecting this connection withdraws commands that have not reached the Mac. An action already delivered to the Mac may still finish.</p>
      {loading && <p role="status">Loading command settings…</p>}
      {error && <p className="station-message station-message--warning" role="alert">{error}</p>}
      {notice && <p className="station-message" role="status">{notice}</p>}
      {!loading && <>
        <ol className="station-bot-steps">
          <li>Create or open <strong>Proxy Balboa</strong> in the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a>. Save its IDs and public key below. This binds your Discord user to your current CLC administrator account{settings?.currentAdmin?.username ? ` (${settings.currentAdmin.username})` : ''}.</li>
          <li>Set the application’s <strong>Interactions Endpoint URL</strong> to <code className="station-bot-endpoint">{endpoint}</code>. Discord verifies the signed connection when you save it.{!secureEndpoint && <span className="station-message station-message--warning">Set CLC’s APP_URL to its public HTTPS address before connecting Discord.</span>}</li>
          <li>Install the application in your server{settings?.inviteUrl && <> using <a href={settings.inviteUrl} target="_blank" rel="noreferrer">Install Proxy Balboa commands</a></>}, then register its commands with a one-time bot token below.</li>
          <li>In the configured printer channel, run <code>/proxy status</code>. Replies are private and do not mention anyone.</li>
        </ol>
        <form className="station-discord-form" onSubmit={event => { event.preventDefault(); act(() => saveDiscordPrintBotSettings(Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()]))), 'Application settings saved. Finish the endpoint and server installation steps in Discord, then register commands.'); }}>
          {fields.map(([key, label, help]) => <label className="station-discord-field" key={key}>{label}<span className="station-small">{help}</span><input type="text" autoComplete="off" spellCheck={false} inputMode={key === 'publicKey' ? 'text' : 'numeric'} maxLength={key === 'publicKey' ? 64 : 20} pattern={key === 'publicKey' ? '[a-fA-F0-9]{64}' : '[1-9][0-9]{0,19}'} value={form[key]} onChange={event => setForm(old => ({ ...old, [key]: event.target.value }))} required disabled={busy} /></label>)}
          <div className="station-actions"><button className="btn btn-primary" type="submit" disabled={busy}>Save command connection</button>{settings?.configured && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act(disconnectDiscordPrintBot, 'Incoming commands disconnected. Printer alert settings are managed separately.')}>Disconnect commands</button>}</div>
        </form>
        {settings?.configured && <form className="station-discord-form station-bot-register" onSubmit={event => { event.preventDefault(); act(() => registerDiscordPrintBotCommands(token.trim()), 'Discord accepted the /proxy commands. Run /proxy status in the configured channel to verify the complete connection.'); }}>
          {settings.operatorName && <p className="station-small">Linked CLC administrator: {settings.operatorName}. {settings.operatorActive ? '' : 'This account is no longer an active administrator; save the connection again to bind your account.'}</p>}
          <label className="station-discord-field">One-time bot token<span className="station-small">From the application’s Bot page. Used only to register commands and then discarded; it is never stored.</span><input type="password" autoComplete="off" spellCheck={false} maxLength={256} value={token} onChange={event => setToken(event.target.value)} required disabled={busy || !!hasUnsavedChanges || !settings.operatorActive} /></label>
          {hasUnsavedChanges && <p className="station-small">Save your changed connection settings before registering commands.</p>}
          <button className="btn btn-secondary" type="submit" disabled={busy || !token.trim() || !!hasUnsavedChanges || !settings.operatorActive}>Register /proxy commands</button>
        </form>}
      </>}
    </div>
  </details>;
}
