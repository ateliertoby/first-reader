// LLM queue transport — writes request files, polls for result files.
// A worker process picks up requests and writes results back via SSH.

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
  "reply_text": string (reply to the owner in their configured language),
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
export const RETRY_PREAMBLE = 'CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanation. Previous attempt failed to produce valid JSON.';

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

// Parse text and validate against required keys for a kind.
// Shared by callCliLLM (sync path) and render-sweep (async completion).
export function parseAndValidate(kind, text) {
  const parsed = extractJson(text);
  if (parsed && validateKeys(parsed, kind)) {
    return { ok: true, parsed };
  }
  return { ok: false };
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

// Build the final system prompt (schema + JSON instruction for JSON kinds)
function buildFinalSystem(kind, system) {
  const isJsonKind = kind !== 'deep_verify';
  return isJsonKind
    ? `${system}\n\n${SCHEMA_TEXT[kind]}\n\n${JSON_INSTRUCTION}`
    : system;
}

// Enqueue a request without polling — returns the request ID.
// Used by runAgentReport (non-dry) to hand off render to the sweep.
export function enqueueCliLLM({ kind, system, user, tools, model, _queueDir } = {}) {
  const queueDir = _queueDir ?? DEFAULT_QUEUE_DIR;
  const reqDir = path.join(queueDir, 'requests');
  const finalSystem = buildFinalSystem(kind, system);

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
  return id;
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
  const resDir = path.join(queueDir, 'results');
  const timeout = timeoutMs ?? KIND_TIMEOUTS[kind] ?? 3 * 60_000;

  // Test hook — intercept before file I/O
  if (_testQueueTransport) {
    return _testQueueTransport({ kind, system, user, tools, model, timeoutMs });
  }

  const pollMs = _pollIntervalMs ?? POLL_INTERVAL;
  const id = enqueueCliLLM({ kind, system, user, tools, model, _queueDir });

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
  if (kind === 'deep_verify') {
    return result.text;
  }

  // JSON extraction + validation
  const pv = parseAndValidate(kind, result.text);
  if (pv.ok) return pv.parsed;

  // ONE retry — new request with CRITICAL preamble, user unchanged
  const retryId = enqueueCliLLM({
    kind,
    system: `${RETRY_PREAMBLE}\n\n${system}`,
    user,
    tools,
    model,
    _queueDir,
  });

  const retryResult = await pollForResult(resDir, retryId, timeout, pollMs);

  if (!retryResult.ok) {
    const err = new Error(retryResult.error === 'auth_expired'
      ? 'MBA claude login 過期咗'
      : `LLM queue error on retry: ${retryResult.error}${retryResult.detail ? ` — ${retryResult.detail}` : ''}`);
    err.code = retryResult.error;
    throw err;
  }

  const pv2 = parseAndValidate(kind, retryResult.text);
  if (pv2.ok) return pv2.parsed;

  throw new Error(`LLM response not valid JSON after retry (kind=${kind})`);
}

// Startup cleanup — delete requests/results older than 1h.
// protectedIds: request IDs for in-flight pending renders — skip these.
export function cleanQueue(now, _queueDir, protectedIds = []) {
  const queueDir = _queueDir ?? DEFAULT_QUEUE_DIR;
  const cutoff = new Date(now).getTime() - CLEANUP_MAX_AGE;
  const protectedSet = new Set(protectedIds);

  for (const sub of ['requests', 'results']) {
    const dir = path.join(queueDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      // Extract ID from filename (UUID.json)
      const fileId = f.replace('.json', '');
      if (protectedSet.has(fileId)) continue;
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
