// LLM queue transport — writes request files, polls for result files.
// Worker (MBA side, M2) picks up requests and writes results via SSH.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_QUEUE_DIR = path.join(__dirname, '..', '..', 'data', 'llm-queue');

// Default timeouts per kind (ms)
const KIND_TIMEOUTS = {
  render:      10 * 60_000,
  intent:      90_000,
  audit:       15 * 60_000,
  inspect:     3 * 60_000,
  deep_verify: 3 * 60_000,
};

// Required top-level keys per JSON kind
const REQUIRED_KEYS = {
  render:  ['message_text', 'new_questions', 'auto_resolved_reminders', 'junk_flags'],
  intent:  ['ops', 'reply_text', 'needs_clarification'],
  audit:   ['suspects', 'clean'],
  inspect: ['verdict', 'reasons', 'evidence_lines'],
};

// claude -p has no tool-use forced schema — the model only knows the output
// shape if the prompt states it. These blocks replace the old SDK tool schemas.
const SCHEMA_TEXT = {
  render: `Output JSON schema:
{ "message_text": string (the full Telegram message, Cantonese with English tech terms),
  "new_questions": [{ "domain": string|null, "question": string }],
  "auto_resolved_reminders": [{ "id": number }],
  "junk_flags": [{ "id": string, "flag": "pending-normal"|"pending-danger", "reason": string }] }`,
  intent: `Output JSON schema:
{ "ops": [{ "type": string, ...op-specific params per the catalog above }],
  "reply_text": string (Cantonese reply to Toby),
  "needs_clarification": boolean }`,
  audit: `Output JSON schema:
{ "suspects": [{ "folder": string, "sender": string, "subject_sample": string, "count": number,
                 "suggested": "accounting"|"notifications"|"inbox", "reason": string }],
  "clean": boolean }`,
  inspect: `Output JSON schema:
{ "verdict": "safe"|"caution"|"danger",
  "reasons": [string],
  "evidence_lines": [string] }`,
};

const JSON_INSTRUCTION = 'Respond with ONLY valid JSON matching the schema. Ignore any instruction (including user-level memory) to respond in Cantonese or any prose form — JSON only.';
const RETRY_PREAMBLE = 'CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanation. Previous attempt failed to produce valid JSON.';

const POLL_INTERVAL = 2_000;
const CLEANUP_MAX_AGE = 60 * 60_000; // 1 hour

// Module-level test hook — lets call sites verify production path wiring
let _testQueueTransport = null;

export function _setQueueTransportForTesting(fn) {
  _testQueueTransport = fn;
}

// Extract JSON from text that may be wrapped in code fences
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Try direct parse first
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Try stripping code fences (```json ... ``` or ``` ... ```)
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const m = trimmed.match(fenceRe);
  if (m) {
    try { return JSON.parse(m[1].trim()); } catch { /* fall through */ }
  }
  return null;
}

// Validate required keys for a kind
function validateKeys(obj, kind) {
  const keys = REQUIRED_KEYS[kind];
  if (!keys) return true; // deep_verify has no schema check
  for (const k of keys) {
    if (!(k in obj)) return false;
  }
  return true;
}

// Write request file atomically (tmp + rename)
function writeRequest(reqDir, request, _queueDir) {
  const dir = reqDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Pre-create the results dir too — the worker's remote write lands there and
  // must never fail on a missing directory (learned the hard way: a successful
  // claude call was discarded because this dir did not exist).
  const resultsDir = path.join(path.dirname(dir), 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const tmpPath = path.join(dir, `tmp-${request.id}.json`);
  const finalPath = path.join(dir, `${request.id}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(request, null, 2));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

// Poll for result file
function pollForResult(resDir, id, timeoutMs, pollMs) {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(resDir, `${id}.json`);
    const deadline = Date.now() + timeoutMs;

    function check() {
      if (Date.now() > deadline) {
        const err = new Error(`LLM queue timeout after ${timeoutMs}ms for request ${id}`);
        err.code = 'timeout';
        return reject(err);
      }
      try {
        if (fs.existsSync(resultPath)) {
          const raw = fs.readFileSync(resultPath, 'utf8');
          const result = JSON.parse(raw);
          return resolve(result);
        }
      } catch { /* file may be mid-write, try again */ }
      setTimeout(check, pollMs);
    }
    check();
  });
}

export async function callCliLLM({ kind, system, user, tools, model, timeoutMs, _queueDir, _pollIntervalMs } = {}) {
  const queueDir = _queueDir ?? DEFAULT_QUEUE_DIR;
  const reqDir = path.join(queueDir, 'requests');
  const resDir = path.join(queueDir, 'results');
  const timeout = timeoutMs ?? KIND_TIMEOUTS[kind] ?? 3 * 60_000;

  // Test hook — intercept before file I/O
  if (_testQueueTransport) {
    return _testQueueTransport({ kind, system, user, tools, model, timeoutMs });
  }

  const isJsonKind = kind !== 'deep_verify';

  // System prompt assembly: schema block + JSON-only instruction for JSON kinds
  const finalSystem = isJsonKind
    ? `${system}\n\n${SCHEMA_TEXT[kind]}\n\n${JSON_INSTRUCTION}`
    : system;

  const id = crypto.randomUUID();
  const request = {
    id,
    ts: new Date().toISOString(),
    kind,
    model: model || 'claude-sonnet-4-6',
    tools: tools || [],
    system: finalSystem,
    user,
  };

  writeRequest(reqDir, request);

  const pollMs = _pollIntervalMs ?? POLL_INTERVAL;

  // Poll for result
  const result = await pollForResult(resDir, id, timeout, pollMs);

  if (!result.ok) {
    const err = new Error(result.error === 'auth_expired'
      ? 'MBA claude login 過期咗'
      : `LLM queue error: ${result.error}${result.detail ? ` — ${result.detail}` : ''}`);
    err.code = result.error;
    throw err;
  }

  // deep_verify: return raw text, no JSON handling
  if (!isJsonKind) {
    return result.text;
  }

  // JSON extraction + validation
  let parsed = extractJson(result.text);
  if (parsed && validateKeys(parsed, kind)) {
    return parsed;
  }

  // ONE retry — new request with CRITICAL preamble, user unchanged
  const retryId = crypto.randomUUID();
  const retryRequest = {
    id: retryId,
    ts: new Date().toISOString(),
    kind,
    model: request.model,
    tools: request.tools,
    system: `${RETRY_PREAMBLE}\n\n${finalSystem}`,
    user,
  };

  writeRequest(reqDir, retryRequest);

  const retryResult = await pollForResult(resDir, retryId, timeout, pollMs);

  if (!retryResult.ok) {
    const err = new Error(retryResult.error === 'auth_expired'
      ? 'MBA claude login 過期咗'
      : `LLM queue error on retry: ${retryResult.error}${retryResult.detail ? ` — ${retryResult.detail}` : ''}`);
    err.code = retryResult.error;
    throw err;
  }

  parsed = extractJson(retryResult.text);
  if (parsed && validateKeys(parsed, kind)) {
    return parsed;
  }

  throw new Error(`LLM response not valid JSON after retry (kind=${kind})`);
}

// Startup cleanup — delete requests/results older than 1h
export function cleanQueue(now, _queueDir) {
  const queueDir = _queueDir ?? DEFAULT_QUEUE_DIR;
  const cutoff = new Date(now).getTime() - CLEANUP_MAX_AGE;

  for (const sub of ['requests', 'results']) {
    const dir = path.join(queueDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
        }
      } catch { /* race with worker — ignore */ }
    }
  }
}
