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
export const register = (username, password) =>
  apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });

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

// Sharing
export const createShare = (beforeText, afterText, title) =>
  apiFetch('/share', { method: 'POST', body: JSON.stringify({ beforeText, afterText, title }) });

export const getShare = (id) => apiFetch(`/share/${id}`);

// Single snapshot (includes deck_text)
export const getSnapshot = (deckId, snapshotId) =>
  apiFetch(`/decks/${deckId}/snapshots/${snapshotId}`);

// Registration status (public)
export const getRegistrationStatus = () => apiFetch('/auth/registration-status');

// Admin
export const getAdminStats = () => apiFetch('/admin/stats');

export const getAdminUsers = () => apiFetch('/admin/users');

export const adminResetPassword = (userId, newPassword) =>
  apiFetch(`/admin/users/${userId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });

export const adminDeleteUser = (userId) =>
  apiFetch(`/admin/users/${userId}`, { method: 'DELETE' });

export const adminToggleAdmin = (userId) =>
  apiFetch(`/admin/users/${userId}/toggle-admin`, { method: 'PATCH' });

export const getAdminSettings = () => apiFetch('/admin/settings');

export const updateAdminSetting = (key, value) =>
  apiFetch(`/admin/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });

export const getAdminShares = () => apiFetch('/admin/shares');

export const adminDeleteShare = (shareId) =>
  apiFetch(`/admin/shares/${shareId}`, { method: 'DELETE' });
