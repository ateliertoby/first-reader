import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicClientApplication } from '@azure/msal-node';

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.first-reader', 'token-cache.json');

export class TokenCache {
  constructor(cachePath = DEFAULT_CACHE_PATH) {
    this.cachePath = cachePath;
  }

  save(data) {
    const dir = path.dirname(this.cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.cachePath, data, { mode: 0o600 });
  }

  load() {
    try {
      return fs.readFileSync(this.cachePath, 'utf8');
    } catch {
      return null;
    }
  }
}

const SCOPES = ['Mail.ReadWrite', 'Mail.Send'];

export async function getAuthenticatedClient() {
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    console.error('Error: AZURE_CLIENT_ID not set. Copy .env.example to .env and fill in your Azure app client ID.');
    process.exit(1);
  }

  const tokenCache = new TokenCache();
  const pca = new PublicClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/consumers' }
  });

  const cacheData = tokenCache.load();
  if (cacheData) {
    pca.getTokenCache().deserialize(cacheData);
  }

  let tokenResponse;
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      tokenResponse = await pca.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
    } catch {
      tokenResponse = await deviceCodeLogin(pca);
    }
  } else {
    tokenResponse = await deviceCodeLogin(pca);
  }

  tokenCache.save(pca.getTokenCache().serialize());
  return tokenResponse.accessToken;
}

export async function deviceCodeLogin(pca) {
  const response = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (resp) => {
      console.log(resp.message);
    }
  });
  return response;
}

export async function login() {
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    console.error('Error: AZURE_CLIENT_ID not set. Copy .env.example to .env and fill in your Azure app client ID.');
    process.exit(1);
  }

  const tokenCache = new TokenCache();
  const pca = new PublicClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/consumers' }
  });

  const response = await deviceCodeLogin(pca);
  tokenCache.save(pca.getTokenCache().serialize());
  console.log(`Logged in as ${response.account.username}`);
}
