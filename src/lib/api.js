const API_BASE = '/api';
const DEFAULT_TIMEOUT = 15_000; // 15 seconds

function getToken() {
  return localStorage.getItem('clc-auth-token');
}

async function apiFetch(path, options = {}) {
  const token = getToken();
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

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
    }
    throw new Error('Network error. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    localStorage.removeItem('clc-auth-token');
    window.dispatchEvent(new Event('auth-expired'));
    throw new Error('Session expired. Please log in again.');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

// Auth
export const register = (username, password, inviteCode) =>
  apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, inviteCode: inviteCode || undefined }) });

export const login = (username, password) =>
  apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });

export const getMe = () => apiFetch('/auth/me');

export const changePassword = (currentPassword, newPassword) =>
  apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });

export const updateEmail = (email) =>
  apiFetch('/auth/email', { method: 'PUT', body: JSON.stringify({ email }) });

export const forgotPassword = (email) =>
  apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });

export const resetPassword = (token, newPassword) =>
  apiFetch('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });

export const deleteAccount = (confirmUsername) =>
  apiFetch('/auth/account', { method: 'DELETE', body: JSON.stringify({ confirmUsername }) });

export const getEmailConfigured = () => apiFetch('/auth/email-configured');

export const verifyEmail = (token) =>
  apiFetch('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });

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

export const updateDeckPriceAlert = (deckId, priceAlertThreshold, priceAlertMode) =>
  apiFetch(`/decks/${deckId}`, { method: 'PATCH', body: JSON.stringify({ priceAlertThreshold, priceAlertMode }) });

export const updateDeckAutoRefresh = (deckId, autoRefreshHours) =>
  apiFetch(`/decks/${deckId}`, { method: 'PATCH', body: JSON.stringify({ autoRefreshHours }) });

export const getDeckRecommendations = (deckId) => apiFetch(`/decks/${deckId}/recommendations`);

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

export const updateDeckNotes = (deckId, notes) =>
  apiFetch(`/decks/${deckId}`, {
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

// Collection
export const getCollection = () => apiFetch('/collection');

export const getCollectionSummary = () => apiFetch('/collection/summary');

export const importCollection = (text) =>
  apiFetch('/collection/import', { method: 'POST', body: JSON.stringify({ text }) });

export const updateCollectionCard = (id, quantity) =>
  apiFetch(`/collection/${id}`, { method: 'PATCH', body: JSON.stringify({ quantity }) });

export const deleteCollectionCard = (id) =>
  apiFetch(`/collection/${id}`, { method: 'DELETE' });

export const clearCollection = () =>
  apiFetch('/collection', { method: 'DELETE' });

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
export const createShare = (beforeText, afterText, title) =>
  apiFetch('/share', { method: 'POST', body: JSON.stringify({ beforeText, afterText, title }) });

export const getShare = (id) => apiFetch(`/share/${id}`);

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
