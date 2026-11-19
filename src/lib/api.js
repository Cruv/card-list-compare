import { AUTH_TOKEN_KEY, getBrowserAuthToken as getToken, getStoredAuthToken } from './authSession.js';

const API_BASE = '/api';

// Incoming Discord commands use a separate signed application connection.
export const getDiscordPrintBotSettings = signal => apiFetch('/print-station-management/discord-bot', { signal });
export const saveDiscordPrintBotSettings = body => apiFetch('/print-station-management/discord-bot', { method: 'PUT', body: JSON.stringify(body) });
export const registerDiscordPrintBotCommands = botToken => apiFetch('/print-station-management/discord-bot/register', { method: 'POST', body: JSON.stringify({ botToken }) });
export const disconnectDiscordPrintBot = () => apiFetch('/print-station-management/discord-bot/disconnect', { method: 'POST', body: '{}' });
const DEFAULT_TIMEOUT = 15_000; // 15 seconds

async function apiFetch(path, { sessionToken, ...options } = {}) {
  const token = sessionToken === undefined ? getToken(!!options.method && options.method !== 'GET') : sessionToken;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const callerSignal = options.signal;
  const cancel = () => controller.abort();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) controller.abort();

  let res;
  let data;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    // Keep cancellation and timeout active until the response body is consumed.
    data = res.ok ? await res.json() : await res.json().catch(() => ({}));
  } catch (err) {
    if (callerSignal?.aborted) throw err;
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
    }
    throw new Error('Network error. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }

  if (!res.ok) {
    const invalidSession = res.status === 401 && data.code === 'SESSION_INVALID';
    if (invalidSession && token && !callerSignal?.aborted && getStoredAuthToken() === token) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      window.dispatchEvent(new Event('auth-expired'));
    }
    const error = new Error(invalidSession ? 'Session expired. Please log in again.' : data.error || `Request failed: ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

// Auth
export const createLibraryDeck = body => apiFetch('/decks/import', { method: 'POST', body: JSON.stringify(body), timeout: 60_000 });

export const register = (username, password, inviteCode) =>
  apiFetch('/auth/register', { sessionToken: null, method: 'POST', body: JSON.stringify({ username, password, inviteCode: inviteCode || undefined }) });

export const login = (username, password) =>
  apiFetch('/auth/login', { sessionToken: null, method: 'POST', body: JSON.stringify({ username, password }) });

export const getMe = (sessionToken, signal) => apiFetch('/auth/me', { sessionToken, signal });

export const changePassword = (currentPassword, newPassword, sessionToken) =>
  apiFetch('/auth/change-password', { sessionToken, method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });

export const updateEmail = (email) =>
  apiFetch('/auth/email', { method: 'PUT', body: JSON.stringify({ email }) });

export const forgotPassword = (email) =>
  apiFetch('/auth/forgot-password', { sessionToken: null, method: 'POST', body: JSON.stringify({ email }) });

export const resetPassword = (token, newPassword) =>
  apiFetch('/auth/reset-password', { sessionToken: null, method: 'POST', body: JSON.stringify({ token, newPassword }) });

export const deleteAccount = (confirmUsername, sessionToken) =>
  apiFetch('/auth/account', { sessionToken, method: 'DELETE', body: JSON.stringify({ confirmUsername }) });

export const getEmailConfigured = () => apiFetch('/auth/email-configured');

export const verifyEmail = (token) =>
  apiFetch('/auth/verify-email', { sessionToken: null, method: 'POST', body: JSON.stringify({ token }) });

export const resendVerification = () =>
  apiFetch('/auth/resend-verification', { method: 'POST' });

// Invites (user)
export const createInviteCode = (maxUses) =>
  apiFetch('/auth/invite', { method: 'POST', body: JSON.stringify({ maxUses }) });

export const getMyInvites = () => apiFetch('/auth/my-invites');

export const deleteInviteCode = (id) =>
  apiFetch(`/auth/invite/${id}`, { method: 'DELETE' });

// Owners
export const getOwners = () => apiFetch('/owners');

export const addOwner = (archidektUsername) =>
  apiFetch('/owners', { method: 'POST', body: JSON.stringify({ archidektUsername }) });

export const removeOwner = (id) =>
  apiFetch(`/owners/${id}`, { method: 'DELETE' });

export const getOwnerDecks = (id) =>
  apiFetch(`/owners/${id}/decks`);

// Decks
export const getTrackedDecks = () => apiFetch('/decks');
export const getTrackedDeck = deckId => apiFetch(`/decks/${deckId}`);

export const trackDeck = (trackedOwnerId, archidektDeckId, deckName, deckUrl) =>
  apiFetch('/decks', { method: 'POST', body: JSON.stringify({ trackedOwnerId, archidektDeckId, deckName, deckUrl }) });

export const untrackDeck = (id) =>
  apiFetch(`/decks/${id}`, { method: 'DELETE' });

export const refreshDeck = (id) =>
  apiFetch(`/decks/${id}/refresh`, { method: 'POST' });

export const refreshAllDecks = () =>
  apiFetch('/decks/refresh-all', { method: 'POST', timeout: 60_000 });

export const getDeckOverlap = () => apiFetch('/decks/overlap');

export const getDeckPrices = (deckId) => apiFetch(`/decks/${deckId}/prices`);
export const getDeckPriceHistory = (deckId) => apiFetch(`/decks/${deckId}/price-history`);

export const updateDeckPriceAlert = (deckId, priceAlertThreshold, priceAlertMode) =>
  apiFetch(`/decks/${deckId}`, { method: 'PATCH', body: JSON.stringify({ priceAlertThreshold, priceAlertMode }) });

export const updateDeckAutoRefresh = (deckId, autoRefreshHours) =>
  apiFetch(`/decks/${deckId}`, { method: 'PATCH', body: JSON.stringify({ autoRefreshHours }) });

export const getDeckRecommendations = (deckId) => apiFetch(`/decks/${deckId}/recommendations`);

export const getNotificationHistory = (page = 1, limit = 20) =>
  apiFetch(`/decks/notifications/history?page=${page}&limit=${limit}`);

// Snapshots
export const getDeckSnapshots = (deckId) =>
  apiFetch(`/decks/${deckId}/snapshots`);

export const deleteSnapshot = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}`, { method: 'DELETE' });

export const renameSnapshot = (deckId, snapshotId, nickname) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}`, {
    method: 'PATCH',
    body: JSON.stringify({ nickname }),
  });

export const getDeckChangelog = (deckId, snapshotA, snapshotB) => {
  const params = snapshotA && snapshotB ? `?a=${snapshotA}&b=${snapshotB}` : '';
  return apiFetch(`/decks/${deckId}/changelog${params}`);
};

export const createSnapshot = (deckId, deckText, nickname) =>
  apiFetch(`/decks/${deckId}/snapshots`, {
    method: 'POST',
    body: JSON.stringify({ deck_text: deckText, nickname }),
  });

export const lockSnapshot = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}/lock`, { method: 'PATCH' });

export const unlockSnapshot = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}/unlock`, { method: 'PATCH' });

export const setPaperSnapshot = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}/paper`, { method: 'PATCH' });

export const clearPaperSnapshot = (deckId) =>
  apiFetch(`/decks/${deckId}/paper`, { method: 'DELETE' });

export const updateDeckCommanders = (deckId, commanders) =>
  apiFetch(`/decks/${deckId}`, {
    method: 'PATCH',
    body: JSON.stringify({ commanders }),
  });

export const updateDeckNotify = (deckId, notifyOnChange) =>
  apiFetch(`/decks/${deckId}`, {
    method: 'PATCH',
    body: JSON.stringify({ notifyOnChange }),
  });

export const updateDeckNotes = (deckId, notes, sessionToken) =>
  apiFetch(`/decks/${deckId}`, {
    sessionToken,
    method: 'PATCH',
    body: JSON.stringify({ notes }),
  });

export const updateDeckPinned = (deckId, pinned) =>
  apiFetch(`/decks/${deckId}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  });

export const updateDeckTags = (deckId, tags) =>
  apiFetch(`/decks/${deckId}`, {
    method: 'PATCH',
    body: JSON.stringify({ tags }),
  });

export const updateDeckDiscordWebhook = (deckId, discordWebhookUrl) =>
  apiFetch(`/decks/${deckId}`, {
    method: 'PATCH',
    body: JSON.stringify({ discordWebhookUrl }),
  });

// Playgroups removed — future TapTogether integration planned

// Timeline
export const getDeckTimeline = (deckId) =>
  apiFetch(`/decks/${deckId}/timeline`);

// Batch export
export const exportDecks = (deckIds) =>
  apiFetch('/decks/export-batch', { method: 'POST', body: JSON.stringify({ deckIds }) });

// Shared deck views
export const shareDeck = (deckId) =>
  apiFetch(`/decks/${deckId}/share`, { method: 'POST' });

export const unshareDeck = (deckId) =>
  apiFetch(`/decks/${deckId}/share`, { method: 'DELETE' });

export const getSharedDeck = (shareId) =>
  apiFetch(`/shared-deck/${shareId}`);

export const getSharedDeckChangelog = (shareId, a, b) => {
  const params = a && b ? `?a=${a}&b=${b}` : '';
  return apiFetch(`/shared-deck/${shareId}/changelog${params}`);
};

export const getSharedDeckSnapshot = (shareId, snapshotId) =>
  apiFetch(`/shared-deck/${shareId}/snapshot/${snapshotId}`);

// Sharing
export const createShare = (beforeText, afterText, title, expiresAt = null, sessionToken) =>
  apiFetch('/share', { sessionToken, method: 'POST', body: JSON.stringify({ beforeText, afterText, title, expiresAt }) });

export const getShare = (id) => apiFetch(`/share/${id}`);

export const getMyComparisonShares = signal => apiFetch('/share/mine', { signal });
export const updateComparisonShareExpiry = (id, expiresAt) =>
  apiFetch(`/share/${id}`, { method: 'PATCH', body: JSON.stringify({ expiresAt }) });
export const revokeComparisonShare = id => apiFetch(`/share/${id}`, { method: 'DELETE' });

// Single snapshot (includes deck_text)
export const getSnapshot = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}`);

// Registration status (public)
export const getRegistrationStatus = () => apiFetch('/auth/registration-status');

// App settings (public — non-sensitive settings like price display)
export const getAppSettings = () => apiFetch('/auth/app-settings');

// Admin
export const getAdminStats = () => apiFetch('/admin/stats');

export const getAdminUsers = ({ search, sort, order, page, limit } = {}) => {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (sort) params.set('sort', sort);
  if (order) params.set('order', order);
  if (page) params.set('page', String(page));
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch(`/admin/users${qs ? `?${qs}` : ''}`);
};

export const adminResetPassword = (userId, newPassword) =>
  apiFetch(`/admin/users/${userId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });

export const adminDeleteUser = (userId) =>
  apiFetch(`/admin/users/${userId}`, { method: 'DELETE' });

export const adminToggleAdmin = (userId) =>
  apiFetch(`/admin/users/${userId}/toggle-admin`, { method: 'PATCH' });

export const adminSuspendUser = (userId) =>
  apiFetch(`/admin/users/${userId}/suspend`, { method: 'PATCH' });

export const adminUnsuspendUser = (userId) =>
  apiFetch(`/admin/users/${userId}/unsuspend`, { method: 'PATCH' });

export const adminForceLogout = (userId) =>
  apiFetch(`/admin/users/${userId}/force-logout`, { method: 'PATCH' });

export const adminUnlockUser = (userId) =>
  apiFetch(`/admin/users/${userId}/unlock`, { method: 'PATCH' });

export const adminToggleInvite = (userId) =>
  apiFetch(`/admin/users/${userId}/toggle-invite`, { method: 'PATCH' });

export const getAdminInvites = () => apiFetch('/admin/invites');

export const adminDeleteInvite = (id) =>
  apiFetch(`/admin/invites/${id}`, { method: 'DELETE' });

export const getAdminSettings = () => apiFetch('/admin/settings');

export const updateAdminSetting = (key, value) =>
  apiFetch(`/admin/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });

export const getAdminShares = () => apiFetch('/admin/shares');

export const adminDeleteShare = (shareId) =>
  apiFetch(`/admin/shares/${shareId}`, { method: 'DELETE' });

export const getAdminAuditLog = ({ page, limit, action } = {}) => {
  const params = new URLSearchParams();
  if (page) params.set('page', String(page));
  if (limit) params.set('limit', String(limit));
  if (action) params.set('action', action);
  const qs = params.toString();
  return apiFetch(`/admin/audit-log${qs ? `?${qs}` : ''}`);
};

export async function downloadBackup() {
  const token = getToken();
  const res = await fetch(`${API_BASE}/admin/backup`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Backup download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : 'backup.db';
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function downloadUsersExport() {
  const token = getToken();
  const res = await fetch(`${API_BASE}/admin/users/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Export failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'users-export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const adminBulkSuspend = () =>
  apiFetch('/admin/bulk/suspend-all', { method: 'POST' });

export const adminCleanupTokens = () =>
  apiFetch('/admin/cleanup/tokens', { method: 'POST' });

export const adminCleanupAuditLog = (days = 90) =>
  apiFetch('/admin/cleanup/audit-log', { method: 'POST', body: JSON.stringify({ days }) });

// MPC Autofill
export const mpcSearch = (cards, searchSettings) =>
  apiFetch('/mpc/search', {
    method: 'POST',
    body: JSON.stringify({ cards, ...(searchSettings ? { searchSettings } : {}) }),
    timeout: 30_000,
  });

export const mpcHealthCheck = () => apiFetch('/mpc/health');
export const mpcGetSources = () => apiFetch('/mpc/sources');
export const mpcGetLanguages = () => apiFetch('/mpc/languages');
export const mpcGetTags = () => apiFetch('/mpc/tags');
export const mpcGetAlternates = (cardName, searchSettings) =>
  apiFetch('/mpc/alternates', {
    method: 'POST',
    body: JSON.stringify({ cardName, ...(searchSettings ? { searchSettings } : {}) }),
  });

export async function mpcDownloadXml(cards, cardstock, foil) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/mpc/xml`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ cards, cardstock, foil }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'XML download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mpc-autofill-project.xml';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function mpcDownloadZip(cards) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/mpc/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ cards }),
    signal: AbortSignal.timeout(300_000), // 5 min timeout for large downloads
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'ZIP download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mpc-card-images.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// MPC art overrides (server-persisted)
export const getMpcOverrides = (deckId) => apiFetch(`/decks/${deckId}/mpc-overrides`);
export const saveMpcOverrides = (deckId, overrides, baseRevision) =>
  apiFetch(`/decks/${deckId}/mpc-overrides`, {
    method: 'PUT',
    body: JSON.stringify({ overrides, baseRevision }),
  });

// Image download queue
export const submitImageDownload = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/download-images`, {
    method: 'POST',
    body: JSON.stringify(snapshotId ? { snapshotId } : {}),
  });

export const getDownloadJobStatus = (deckId, jobId) =>
  apiFetch(`/decks/${deckId}/download-jobs/${jobId}`);

export async function downloadJobFile(deckId, jobId, deckName) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/decks/${deckId}/download-jobs/${jobId}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Image download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const safeName = (deckName || 'card-images').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}_images.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Household PDFs and the native Mac print queue.
export const previewPrintPlan = (deckId, options) =>
  apiFetch(`/decks/${deckId}/print-plan`, { method: 'POST', body: JSON.stringify(options), timeout: 90_000 });
export const savePrintArtToDeck = (deckId, options) =>
  apiFetch(`/decks/${deckId}/print-art`, { method: 'POST', body: JSON.stringify(options), timeout: 30_000 });
export const createPrintJob = (deckId, options) =>
  apiFetch(`/decks/${deckId}/print-jobs`, { method: 'POST', body: JSON.stringify(options), timeout: 90_000 });
export const getPrintJobs = (deckId, signal) => apiFetch(`/decks/${deckId}/print-jobs`, { signal });
const printActivityQuery = watch => watch?.length ? `?${new URLSearchParams({ watch: watch.join(',') })}` : '';
export const getPrintJobActivity = (deckId, signal, watch) => apiFetch(`/decks/${deckId}/print-jobs/activity${printActivityQuery(watch)}`, { signal });
export const getPrintJob = (deckId, jobId, signal) => apiFetch(`/decks/${deckId}/print-jobs/${jobId}`, { signal });
export const queuePrintJob = (deckId, jobId) =>
  apiFetch(`/decks/${deckId}/print-jobs/${jobId}/queue`, { method: 'POST', body: '{}' });
export const cancelPrintJob = (deckId, jobId) =>
  apiFetch(`/decks/${deckId}/print-jobs/${jobId}/cancel`, { method: 'POST', body: '{}' });
export const expirePrintArtifacts = (deckId, jobId) =>
  apiFetch(`/decks/${deckId}/print-jobs/${jobId}/artifacts`, { method: 'DELETE' });

export const previewStandalonePrintJob = options =>
  apiFetch('/print-lists/plan', { method: 'POST', body: JSON.stringify(options), timeout: 90_000 });
export const createStandalonePrintJob = options =>
  apiFetch('/print-lists/jobs', { method: 'POST', body: JSON.stringify(options), timeout: 90_000 });
export const getStandalonePrintJobs = signal => apiFetch('/print-lists/jobs', { signal });
export const getStandalonePrintJobActivity = (signal, watch) => apiFetch(`/print-lists/jobs/activity${printActivityQuery(watch)}`, { signal });
export const getStandalonePrintJob = (jobId, signal) => apiFetch(`/print-lists/jobs/${jobId}`, { signal });
export const queueStandalonePrintJob = jobId =>
  apiFetch(`/print-lists/jobs/${jobId}/queue`, { method: 'POST', body: '{}' });
export const cancelStandalonePrintJob = jobId =>
  apiFetch(`/print-lists/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' });
export const expireStandalonePrintArtifacts = jobId =>
  apiFetch(`/print-lists/jobs/${jobId}/artifacts`, { method: 'DELETE' });

const alternatePrintLayoutPath = (deckId, jobId) => {
  const jobs = deckId == null ? '/print-lists/jobs' : `/decks/${deckId}/print-jobs`;
  return `${jobs}/${encodeURIComponent(jobId)}/alternate-layout`;
};
export const previewAlternatePrintLayout = (deckId, jobId, options, signal, sessionToken) =>
  apiFetch(`${alternatePrintLayoutPath(deckId, jobId)}/preview`, {
    method: 'POST', body: JSON.stringify(options), signal, sessionToken, timeout: 90_000,
  });
export const createAlternatePrintLayout = (deckId, jobId, options, signal, sessionToken) =>
  apiFetch(alternatePrintLayoutPath(deckId, jobId), {
    method: 'POST', body: JSON.stringify(options), signal, sessionToken, timeout: 90_000,
  });

export async function downloadPrintArtifact(downloadUrl, filename) {
  // URLs come from the authenticated job response, and must stay on this origin.
  if (!/^\/api\/(?:decks\/\d+\/print-jobs|print-lists\/jobs)\/[a-zA-Z0-9-]+\/(?:manifest|artifacts\/[a-zA-Z0-9_-]+)$/.test(downloadUrl)) {
    throw new Error('Invalid PDF download address');
  }
  const token = getToken();
  const manifest = downloadUrl.endsWith('/manifest');
  let href;
  let reportStatus = false;
  if (manifest) {
    const res = await fetch(downloadUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Batch details download failed');
    }
    href = URL.createObjectURL(await res.blob());
  } else {
    const ticket = await apiFetch(`${downloadUrl.slice(API_BASE.length)}/download`, {
      sessionToken: token, method: 'POST', body: JSON.stringify({ filename, reportStatus: true }), redirect: 'error',
    });
    if (!/^\/api\/print-downloads\/[a-f0-9-]{36}$/.test(ticket.url)) throw new Error('Invalid PDF download address');
    if (getToken() !== token) throw new Error('Your sign-in changed. Start the PDF download again.');
    href = ticket.url;
    reportStatus = ticket.reportStatus === true;
  }
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = (filename || 'cards.pdf').replace(/[^a-zA-Z0-9._ -]/g, '_');
  anchor.rel = 'noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (manifest) setTimeout(() => URL.revokeObjectURL(href), 30_000);
  else if (reportStatus) await waitForPrintDownload(href, token);
}

async function waitForPrintDownload(href, token) {
  const statusPath = `${href.slice(API_BASE.length)}/status`;
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    if (getToken() !== token) throw new Error('Your sign-in changed. Start the PDF download again.');
    const receipt = await apiFetch(statusPath, { sessionToken: token, redirect: 'error' });
    if (getToken() !== token) throw new Error('Your sign-in changed. Start the PDF download again.');
    if (receipt?.state === 'started') return;
    if (receipt?.state === 'failed' && typeof receipt.error === 'string') throw new Error(receipt.error);
    if (receipt?.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('The PDF download could not be confirmed. Check your browser’s downloads before trying again.');
}

const printProofPath = paper => `/print-proofs/${encodeURIComponent(paper)}`;
function printProofQuery({ registrationMarks, dahleAlignmentMarks, key }) {
  const query = new URLSearchParams({ marks: registrationMarks ? 'on' : 'off' });
  if (dahleAlignmentMarks === true) query.set('dahleAlignmentMarks', 'on');
  if (key) query.set('key', key);
  return query;
}

export const getPrintProof = (paper, options, signal) =>
  apiFetch(`${printProofPath(paper)}?${printProofQuery(options)}`, { signal });

export async function downloadPrintProof(paper, proof, signal) {
  const token = getToken();
  const query = printProofQuery(proof);
  const response = await fetch(`${API_BASE}${printProofPath(paper)}/pdf?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, signal, redirect: 'error',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Paper proof download failed');
  }
  if (response.headers.get('x-clc-proof-key') !== proof.key) throw new Error('The proof recipe changed. Refresh the proof details.');
  const pdf = await response.blob();
  if (getToken() !== token) throw new Error('Your sign-in changed. Start the proof download again.');
  const href = URL.createObjectURL(pdf);
  const anchor = document.createElement('a');
  anchor.href = href;
  const marks = proof.dahleAlignmentMarks ? 'die-alignment' : proof.registrationMarks ? 'marks' : 'no-marks';
  anchor.download = `${proof.recipeId}-${marks}-${proof.revision.slice(0, 12)}-proof.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

// Optional ManaSync ownership and confirmed physical-print bridge.
export const getManaSyncConnection = () => apiFetch('/manasync/connection');
export const connectManaSync = data => apiFetch('/manasync/connection',{method:'PUT',body:JSON.stringify(data)});
export const checkManaSyncConnection = () => apiFetch('/manasync/connection/check',{method:'POST'});
export const disconnectManaSync = () => apiFetch('/manasync/connection',{method:'DELETE'});
export const getManaSyncAvailability = by => apiFetch(`/manasync/availability?by=${by}`);
export const getManaSyncContainers = () => apiFetch('/manasync/containers');
export const getPrintQueue = (deckId, signal) => apiFetch(`/manasync/print-queue${deckId ? `?deckId=${deckId}` : ''}`, { signal });
export const refreshPendingProxyPrints = (scope = {}) => apiFetch('/manasync/print-queue/refresh',{
  method:'POST',body:JSON.stringify({...(scope.deckId ? {deckId:scope.deckId} : {}),...(scope.printJobId ? {printJobId:scope.printJobId} : {})}),
});
export const retryPendingProxyPublication = (id, expectedConnection) => apiFetch(`/manasync/print-queue/${encodeURIComponent(id)}/retry-publication`,{
  method:'POST',body:JSON.stringify({expectedConnection}),
});
export const queuePrintItem = data => apiFetch('/manasync/print-queue',{method:'POST',body:JSON.stringify(data)});
export const cancelPrintItem = id => apiFetch(`/manasync/print-queue/${id}/cancel`,{method:'POST'});
export const confirmPrinted = (id,data) => apiFetch(`/manasync/print-queue/${id}/confirm`,{method:'POST',body:JSON.stringify(data)});
export const retryPrintReport = id => apiFetch(`/manasync/operations/${id}/retry`,{method:'POST'});
export const bindPrintReport = (id,containerId,expectedConnection) => apiFetch(`/manasync/operations/${id}/bind`,{method:'POST',body:JSON.stringify({containerId,expectedConnection})});
export const reconcilePrintReport = id => apiFetch(`/manasync/operations/${id}/reconcile`);
export const correctPrintReport = (id,data) => apiFetch(`/manasync/operations/${id}/correct`,{method:'POST',body:JSON.stringify(data)});

export const queuePrintBatch = items => apiFetch('/manasync/print-queue/batch',{method:'POST',body:JSON.stringify({items})});

export const stagePrintJobConfirmations = jobId =>
  apiFetch(`/manasync/print-jobs/${encodeURIComponent(jobId)}/confirmation-queue`, { method: 'POST', body: '{}' });

export async function getPrintQueueArtwork(itemId, face, signal) {
  if (!['front', 'back'].includes(face)) throw new Error('Invalid artwork face');
  const token = getToken();
  // Construct the same-origin route; never send credentials to an artwork URL.
  const res = await fetch(`${API_BASE}/manasync/print-queue/${encodeURIComponent(itemId)}/artwork/${face}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Saved proxy artwork could not be loaded');
  }
  return res.blob();
}
// Household station management uses the signed-in user's account, never station credentials.
export const getPrintBatches = ({ cursor, state = 'all', order = 'queue', limit = 50 } = {}, signal) => {
  const query = new URLSearchParams({ state, order, limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return apiFetch(`/print-batches?${query}`, { signal });
};
export const getPrintStationStatus = (signal) =>
  apiFetch('/print-station-management/status', { signal, timeout: 10_000 });
export const getPrintJobDiagnostics = (jobId, signal) =>
  apiFetch(`/print-station-management/jobs/${encodeURIComponent(jobId)}/diagnostics`, { signal, timeout: 10_000 });
export const cancelHouseholdPrintJob = (jobId, signal) =>
  apiFetch(`/print-station-management/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}', signal });
export const preparePrintJobBacks = (jobId, artifactId, signal) =>
  apiFetch(`/print-station-management/jobs/${encodeURIComponent(jobId)}/backs/prepare`, { method: 'POST', body: JSON.stringify({ artifactId }), signal });
export const cancelPrintJobBacks = (jobId, signal) =>
  apiFetch(`/print-station-management/jobs/${encodeURIComponent(jobId)}/backs/cancel`, { method: 'POST', body: '{}', signal });
export const sendPrintStationCommand = (command, signal) =>
  apiFetch('/print-station-management/commands', { method: 'POST', body: JSON.stringify(command), signal });

// Discord settings must never pass through UI persistence containing the webhook.
export const configurePrintStationDiscord = (settings, signal) =>
  apiFetch('/print-station-management/discord', { method: 'POST', body: JSON.stringify(settings), signal });
export const testPrintStationDiscord = (request, signal) =>
  apiFetch('/print-station-management/discord/test', { method: 'POST', body: JSON.stringify(request), signal });
export const findPrintStationCommand = (key, signal) =>
  apiFetch(`/print-station-management/commands/${encodeURIComponent(key)}`, { signal, timeout: 10_000 });
