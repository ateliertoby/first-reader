import { getAuthenticatedClient } from './auth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let _retryDelays = [2000, 8000];
let _testToken = null;

export function setRetryDelays(delays) {
  _retryDelays = delays;
}

export function _setTokenForTesting(token) {
  _testToken = token;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function buildGraphUrl(path, params = {}) {
  const queryParts = [];
  for (const [key, value] of Object.entries(params)) {
    queryParts.push(`$${key}=${value}`);
  }
  return queryParts.length > 0 ? `${path}?${queryParts.join('&')}` : path;
}

async function graphFetch(path, options = {}) {
  const token = _testToken || await getAuthenticatedClient();
  const url = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`;

  let lastError;
  for (let attempt = 0; attempt <= _retryDelays.length; attempt++) {
    if (attempt > 0) {
      await sleep(_retryDelays[attempt - 1]);
    }

    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
    } catch (err) {
      // Network/fetch error — retryable
      lastError = err;
      continue;
    }

    if (response.ok) {
      if (response.status === 204) return null;
      return response.json();
    }

    const error = await response.json().catch(() => ({}));
    const msg = error?.error?.message || `HTTP ${response.status}`;
    lastError = new Error(`Graph API error: ${msg}`);

    // Retry 5xx and 429 (throttling); throw immediately on other 4xx
    if (response.status >= 500 || response.status === 429) continue;
    throw lastError;
  }

  throw lastError;
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
