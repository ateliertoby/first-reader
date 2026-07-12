import { getAuthenticatedClient } from './auth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export function buildGraphUrl(path, params = {}) {
  const queryParts = [];
  for (const [key, value] of Object.entries(params)) {
    queryParts.push(`$${key}=${value}`);
  }
  return queryParts.length > 0 ? `${path}?${queryParts.join('&')}` : path;
}

async function graphFetch(path, options = {}) {
  const token = await getAuthenticatedClient();
  const url = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const msg = error?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Graph API error: ${msg}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export async function graphGet(path) {
  return graphFetch(path);
}

export async function graphPost(path, body) {
  return graphFetch(path, { method: 'POST', body: JSON.stringify(body) });
}

export async function graphPatch(path, body) {
  return graphFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function graphDelete(path) {
  return graphFetch(path, { method: 'DELETE' });
}
