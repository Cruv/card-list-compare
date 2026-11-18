import { getBrowserAuthToken } from './authSession.js';

export async function integrationApi(path, options = {}) {
  const authorization = options.headers?.Authorization ?? `Bearer ${getBrowserAuthToken(!!options.method && options.method !== 'GET') || ''}`;
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: authorization, ...options.headers },
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}
