// MBA-side LLM worker — polls Mini queue via SSH, invokes local claude -p,
// writes results back atomically. All external effects injectable for testing.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const POLL_SLEEP = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_RE = /login|auth|credential|OAuth/i;
const REMOTE_QUEUE = '~/outlook-cli/data/llm-queue';

// --- Production dependency implementations ---

function prodSsh(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function prodRunClaude({ model, tools, systemFile, userContent }) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', model, '--tools', tools, '--system-prompt-file', systemFile, '--output-format', 'json'];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // spawn failures (ENOENT etc.) emit 'error', not 'close' — without this the process dies
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.write(userContent);
    child.stdin.end();
  });
}

function prodSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prodNow() {
  return new Date().toISOString();
}

// --- Pure helpers ---

// Priority: intent first, then oldest by ts within same priority tier
export function pickJob(jobs) {
  if (!jobs.length) return null;
  const intents = jobs.filter((j) => j.kind === 'intent').sort((a, b) => a.ts.localeCompare(b.ts));
  if (intents.length) return intents[0];
  const others = [...jobs].sort((a, b) => a.ts.localeCompare(b.ts));
  return others[0];
}

function isValidUUID(id) {
  return UUID_RE.test(id);
}

// --- Worker internals ---

async function handleMalformedRequest(id, deps) {
  const result = JSON.stringify({
    id, ts: deps.now(), ok: false,
    error: 'claude_error', detail: 'malformed request',
  });
  await deps.ssh(
    ['macmini', `cat > ${REMOTE_QUEUE}/results/tmp-${id}.json && mv ${REMOTE_QUEUE}/results/tmp-${id}.json ${REMOTE_QUEUE}/results/${id}.json`],
    result,
  );
  await deps.ssh(['macmini', `rm ${REMOTE_QUEUE}/requests/${id}.json`]);
}

async function listJobs(deps) {
  const { exitCode, stdout } = await deps.ssh(
    ['macmini', `ls ${REMOTE_QUEUE}/requests/ 2>/dev/null`],
  );
  if (exitCode !== 0 || !stdout.trim()) return [];

  const filenames = stdout.trim().split('\n').filter((f) => f.endsWith('.json'));
  const jobs = [];

  for (const f of filenames) {
    const id = f.replace('.json', '');
    if (!isValidUUID(id)) {
      console.error(`[worker] skipping invalid id: ${f}`);
      continue;
    }
    const result = await deps.ssh(
      ['macmini', `cat ${REMOTE_QUEUE}/requests/${id}.json`],
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const req = JSON.parse(result.stdout);
        jobs.push(req);
      } catch {
        await handleMalformedRequest(id, deps);
      }
    }
  }
  return jobs;
}

async function processJob(request, deps) {
  const { id, model, tools, system, user } = request;

  // Write system prompt to local temp file for --system-prompt-file
  const tmpFile = path.join(os.tmpdir(), `outlook-worker-sys-${id}.txt`);
  fs.writeFileSync(tmpFile, system);

  try {
    const toolsStr = (tools && tools.length) ? tools.join(',') : '';
    const { exitCode, stdout, stderr } = await deps.runClaude({
      model: model || 'claude-sonnet-4-6',
      tools: toolsStr,
      systemFile: tmpFile,
      userContent: user,
    });

    let resultPayload;

    if (exitCode !== 0) {
      const combined = (stdout || '') + (stderr || '');
      if (AUTH_RE.test(combined)) {
        resultPayload = { id, ts: deps.now(), ok: false, error: 'auth_expired' };
      } else {
        const detail = (stderr || stdout || '').slice(-200).trim();
        resultPayload = { id, ts: deps.now(), ok: false, error: 'claude_error', detail };
      }
    } else {
      // Parse claude envelope
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          resultPayload = { id, ts: deps.now(), ok: false, error: 'claude_error', detail: envelope.result || '' };
        } else {
          resultPayload = { id, ts: deps.now(), ok: true, text: envelope.result };
        }
      } catch {
        resultPayload = { id, ts: deps.now(), ok: false, error: 'claude_error', detail: 'envelope parse failed' };
      }
    }

    // Atomic write-back: single ssh command (mkdir -p; cat > tmp && mv).
    // Write failure must NOT delete the request — leave it for the next cycle.
    const resultJson = JSON.stringify(resultPayload);
    const write = await deps.ssh(
      ['macmini', `mkdir -p ${REMOTE_QUEUE}/results && cat > ${REMOTE_QUEUE}/results/tmp-${id}.json && mv ${REMOTE_QUEUE}/results/tmp-${id}.json ${REMOTE_QUEUE}/results/${id}.json`],
      resultJson,
    );
    if (write.exitCode !== 0) {
      console.error(`Result write failed for ${id} (exit ${write.exitCode}) — request kept for retry`);
      return;
    }

    // Delete request
    await deps.ssh(['macmini', `rm ${REMOTE_QUEUE}/requests/${id}.json`]);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* already cleaned or never written */ }
  }
}

// --- Main loop ---

export async function runWorker({ deps: userDeps, _maxCycles = Infinity } = {}) {
  const deps = {
    ssh: prodSsh,
    runClaude: prodRunClaude,
    sleep: prodSleep,
    now: prodNow,
    ...userDeps,
  };

  let running = true;
  let cycles = 0;

  const stop = () => { running = false; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    while (running && cycles < _maxCycles) {
      cycles++;
      let processed = false;

      try {
        const jobs = await listJobs(deps);
        if (jobs.length) {
          const job = pickJob(jobs);
          await processJob(job, deps);
          processed = true;
        }
      } catch (err) {
        console.error(`[worker] cycle error: ${err.message}`);
      }

      // Empty/error cycle → sleep; busy cycle → continue immediately
      if (!processed) {
        await deps.sleep(POLL_SLEEP);
      }
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

export { POLL_SLEEP };
