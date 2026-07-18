// Telegram transport — raw fetch, no framework (spec §2 dependency policy)

import fs from 'node:fs';
import path from 'node:path';

const MAX_MSG_LEN = 4096;
const RETRY_COUNT = 2;
const DEFAULT_API = 'https://api.telegram.org';

let _retryDelays = [1000, 3000];
let _sleepFn = null;

export function _setTelegramDelaysForTesting(delays) {
  _retryDelays = delays;
}

export function _setTelegramSleepForTesting(fn) {
  _sleepFn = fn;
}

function sleep(ms) {
  if (_sleepFn) return _sleepFn(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Split text into parts <= MAX_MSG_LEN, preferring newline boundaries
function splitMessage(text) {
  if (text.length <= MAX_MSG_LEN) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_MSG_LEN) {
    let splitAt = remaining.lastIndexOf('\n', MAX_MSG_LEN);
    if (splitAt <= 0) splitAt = MAX_MSG_LEN;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

export class TelegramChannel {
  constructor({ token, chatId, baseUrl }) {
    this._chatId = Number(chatId);
    this._baseUrl = baseUrl ?? `${DEFAULT_API}/bot${token}`;
  }

  // Call a Bot API method with retry on transient errors (5xx, 429, network)
  async _call(method, body) {
    const url = `${this._baseUrl}/${method}`;
    let lastError;
    let retryAfterMs = null;

    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        const delay = retryAfterMs ?? (_retryDelays[attempt - 1] ?? _retryDelays.at(-1));
        await sleep(delay);
        retryAfterMs = null;
      }

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastError = err;
        continue;
      }

      if (response.ok) {
        return response.json();
      }

      const data = await response.json().catch(() => ({}));
      lastError = new Error(`Telegram API error: ${data?.description || `HTTP ${response.status}`}`);

      if (response.status === 429) {
        const ra = data?.parameters?.retry_after;
        if (ra) retryAfterMs = ra * 1000;
        continue;
      }

      if (response.status >= 500) continue;

      // Non-retryable (4xx other than 429)
      throw lastError;
    }

    throw lastError;
  }

  async send(text) {
    const parts = splitMessage(text);
    for (const part of parts) {
      await this._call('sendMessage', {
        chat_id: this._chatId,
        text: part,
        reply_markup: {
          keyboard: [[{ text: '📋 Check email' }]],
          resize_keyboard: true,
          is_persistent: true,
        },
      });
    }
  }

  // Register bot commands with BotFather — best-effort, never fatal
  async setMyCommands() {
    try {
      await this._call('setMyCommands', {
        commands: [
          { command: 'report', description: '即刻出報告' },
          { command: 'audit', description: '行 folder audit' },
        ],
      });
    } catch (err) {
      console.error(`setMyCommands failed (non-fatal): ${err.message}`);
    }
  }

  // Long-poll for updates. Advances offsetRef.value.
  // Returns only messages from the configured chatId (auth allowlist).
  async poll(offsetRef) {
    let result;
    try {
      result = await this._call('getUpdates', {
        offset: offsetRef.value,
        timeout: 30,
        allowed_updates: ['message'],
      });
    } catch {
      return [];
    }

    const updates = result?.result || [];
    if (updates.length === 0) return [];

    // Advance offset past highest update_id
    const maxId = Math.max(...updates.map(u => u.update_id));
    offsetRef.value = maxId + 1;

    // Auth allowlist — drop messages from wrong chat
    const allowed = [];
    for (const u of updates) {
      if (!u.message) continue;
      const chatId = u.message.chat?.id;
      if (chatId === this._chatId) {
        allowed.push(u.message);
      } else {
        console.log(`Dropping update from unauthorized chat ${chatId}`);
      }
    }

    return allowed;
  }

  // Send all outbox files in ts order. Stop on first failure.
  async drainOutbox(outboxDir) {
    if (!fs.existsSync(outboxDir)) return { sent: 0, remaining: 0 };

    const files = fs.readdirSync(outboxDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    let sent = 0;
    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(outboxDir, files[i]);

      // Corrupt file (partial write on crash) must not wedge the queue —
      // sidetrack it and keep draining; only SEND failures stop the drain.
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        fs.renameSync(filePath, `${filePath}.bad`);
        console.error(`Outbox file corrupt, sidetracked: ${files[i]}`);
        continue;
      }

      try {
        await this.send(data.text);
        fs.unlinkSync(filePath);
        sent++;
      } catch (err) {
        console.error(`Outbox drain failed on ${files[i]}: ${err.message}`);
        return { sent, remaining: files.length - i };
      }
    }

    return { sent, remaining: 0 };
  }
}
