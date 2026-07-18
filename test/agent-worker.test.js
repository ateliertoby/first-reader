// Tests for src/agent/worker.js — MBA-side LLM worker (all deps mocked)

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { runWorker, pickJob, POLL_SLEEP } from '../src/agent/worker.js';

// --- Helper: build mock deps ---

function makeDeps(overrides = {}) {
  const log = [];
  const deps = {
    ssh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runClaude: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
    sleep: async (ms) => { log.push({ type: 'sleep', ms }); },
    now: () => '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
  return { deps, log };
}

// Build a valid request JSON
function makeRequest(id, kind = 'render', ts = '2026-07-18T10:00:00Z') {
  return {
    id, ts, kind,
    model: 'claude-sonnet-4-6',
    tools: kind === 'deep_verify' ? ['WebSearch'] : [],
    system: 'test system prompt',
    user: 'test user content',
  };
}

// Standard claude success envelope
function claudeEnvelope(text = 'hello') {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: text, session_id: 'sess-1', total_cost_usd: 0.01,
  });
}

// --- pickJob priority ---

describe('pickJob priority', () => {
  test('intent beats older non-intent', () => {
    const jobs = [
      makeRequest('aaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'render', '2026-07-18T08:00:00Z'),
      makeRequest('bbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'intent', '2026-07-18T09:00:00Z'),
    ];
    const picked = pickJob(jobs);
    assert.strictEqual(picked.kind, 'intent');
    assert.strictEqual(picked.id, 'bbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  test('oldest within same kind (non-intent)', () => {
    const jobs = [
      makeRequest('ccc-cccc-cccc-cccc-cccccccccccc', 'render', '2026-07-18T11:00:00Z'),
      makeRequest('ddd-dddd-dddd-dddd-dddddddddddd', 'audit', '2026-07-18T09:00:00Z'),
      makeRequest('eee-eeee-eeee-eeee-eeeeeeeeeeee', 'render', '2026-07-18T08:00:00Z'),
    ];
    const picked = pickJob(jobs);
    assert.strictEqual(picked.id, 'eee-eeee-eeee-eeee-eeeeeeeeeeee');
  });

  test('oldest intent wins among multiple intents', () => {
    const jobs = [
      makeRequest('fff-ffff-ffff-ffff-ffffffffffff', 'intent', '2026-07-18T10:00:00Z'),
      makeRequest('ggg-gggg-gggg-gggg-gggggggggggg', 'intent', '2026-07-18T08:00:00Z'),
    ];
    const picked = pickJob(jobs);
    assert.strictEqual(picked.id, 'ggg-gggg-gggg-gggg-gggggggggggg');
  });

  test('returns null for empty array', () => {
    assert.strictEqual(pickJob([]), null);
  });
});

// --- Full happy cycle ---

describe('full happy cycle', () => {
  const REQ_ID = '11111111-2222-3333-4444-555555555555';

  test('request fetched, claude called correctly, result written atomically, request deleted', async () => {
    const sshCalls = [];
    const claudeCalls = [];
    let capturedSystemContent;
    const request = makeRequest(REQ_ID, 'intent');

    const { deps } = makeDeps({
      ssh: async (args, stdin) => {
        sshCalls.push({ args, stdin });
        // ls requests
        if (args[1].includes('ls ')) {
          return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        }
        // cat request
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        // write result (cat > tmp && mv)
        if (args[1].includes('cat >')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // rm request
        if (args[1].includes('rm ')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async (params) => {
        claudeCalls.push(params);
        // Read system file while it still exists
        capturedSystemContent = fs.readFileSync(params.systemFile, 'utf8');
        return { exitCode: 0, stdout: claudeEnvelope('intent result'), stderr: '' };
      },
    });

    await runWorker({ deps, _maxCycles: 1 });

    // claude called with correct params
    assert.strictEqual(claudeCalls.length, 1);
    assert.strictEqual(claudeCalls[0].model, 'claude-sonnet-4-6');
    assert.strictEqual(claudeCalls[0].tools, '');
    assert.strictEqual(claudeCalls[0].userContent, 'test user content');
    // system file had correct content (read inside mock before cleanup)
    assert.strictEqual(capturedSystemContent, 'test system prompt');
    assert.ok(claudeCalls[0].systemFile.includes('outlook-worker-sys-'));

    // Atomic write-back: find the ssh call with 'cat >'
    const writeCall = sshCalls.find((c) => c.args[1].includes('cat >'));
    assert.ok(writeCall, 'should have atomic write call');
    assert.ok(writeCall.args[1].includes(`tmp-${REQ_ID}.json`), 'writes to tmp first');
    assert.ok(writeCall.args[1].includes(`&& mv`), 'atomic rename');
    assert.ok(writeCall.args[1].includes(`results/${REQ_ID}.json`), 'final path correct');
    // Result payload piped via stdin
    const writtenResult = JSON.parse(writeCall.stdin);
    assert.strictEqual(writtenResult.ok, true);
    assert.strictEqual(writtenResult.text, 'intent result');
    assert.strictEqual(writtenResult.id, REQ_ID);

    // Request deleted
    const rmCall = sshCalls.find((c) => c.args[1].includes('rm '));
    assert.ok(rmCall);
    assert.ok(rmCall.args[1].includes(`requests/${REQ_ID}.json`));
  });
});

// --- Envelope parsing ---

describe('envelope parsing', () => {
  const REQ_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function sshForRequest(request) {
    return async (args) => {
      if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
      if (args[1].includes('cat ') && args[1].includes('requests/')) {
        return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  test('is_error envelope produces claude_error result', async () => {
    const request = makeRequest(REQ_ID);
    let writtenResult;
    const { deps } = makeDeps({
      ssh: async (args, stdin) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        if (args[1].includes('cat >') && stdin) {
          writtenResult = JSON.parse(stdin);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: 'result', is_error: true, result: 'model refused' }),
        stderr: '',
      }),
    });

    await runWorker({ deps, _maxCycles: 1 });

    assert.strictEqual(writtenResult.ok, false);
    assert.strictEqual(writtenResult.error, 'claude_error');
    assert.strictEqual(writtenResult.detail, 'model refused');
  });

  test('non-zero exit + auth stderr produces auth_expired result', async () => {
    const request = makeRequest(REQ_ID);
    let writtenResult;
    const { deps } = makeDeps({
      ssh: async (args, stdin) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        if (args[1].includes('cat >') && stdin) {
          writtenResult = JSON.parse(stdin);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Please run /login to authenticate',
      }),
    });

    await runWorker({ deps, _maxCycles: 1 });

    assert.strictEqual(writtenResult.ok, false);
    assert.strictEqual(writtenResult.error, 'auth_expired');
  });

  test('non-zero exit without auth keyword produces claude_error', async () => {
    const request = makeRequest(REQ_ID);
    let writtenResult;
    const { deps } = makeDeps({
      ssh: async (args, stdin) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        if (args[1].includes('cat >') && stdin) {
          writtenResult = JSON.parse(stdin);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'rate limit exceeded',
      }),
    });

    await runWorker({ deps, _maxCycles: 1 });

    assert.strictEqual(writtenResult.ok, false);
    assert.strictEqual(writtenResult.error, 'claude_error');
    assert.ok(writtenResult.detail.includes('rate limit'));
  });
});

// --- Malformed request ---

describe('malformed request JSON', () => {
  const REQ_ID = '12345678-1234-1234-1234-123456789012';

  test('malformed request writes error result and deletes request', async () => {
    const sshCalls = [];
    const { deps } = makeDeps({
      ssh: async (args, stdin) => {
        sshCalls.push({ args, stdin });
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: 'not valid json {{{{', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await runWorker({ deps, _maxCycles: 1 });

    // Should have written an error result
    const writeCall = sshCalls.find((c) => c.args[1].includes('cat >') && c.stdin);
    assert.ok(writeCall, 'error result written');
    const result = JSON.parse(writeCall.stdin);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'claude_error');
    assert.strictEqual(result.detail, 'malformed request');
    assert.strictEqual(result.id, REQ_ID);

    // Should have deleted the request
    const rmCall = sshCalls.find((c) => c.args[1].includes('rm ') && c.args[1].includes('requests/'));
    assert.ok(rmCall, 'request deleted');
    assert.ok(rmCall.args[1].includes(REQ_ID));
  });
});

// --- deep_verify tools ---

describe('deep_verify job', () => {
  const REQ_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  test('deep_verify request passes WebSearch to claude --tools', async () => {
    const request = makeRequest(REQ_ID, 'deep_verify');
    let claudeParams;
    const { deps } = makeDeps({
      ssh: async (args) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async (params) => {
        claudeParams = params;
        return { exitCode: 0, stdout: claudeEnvelope('verified'), stderr: '' };
      },
    });

    await runWorker({ deps, _maxCycles: 1 });

    assert.strictEqual(claudeParams.tools, 'WebSearch');
  });
});

// --- Sleep / busy cycle behavior ---

describe('cycle sleep behavior', () => {
  test('empty cycle sleeps', async () => {
    const { deps, log } = makeDeps({
      ssh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await runWorker({ deps, _maxCycles: 1 });

    const sleeps = log.filter((e) => e.type === 'sleep');
    assert.strictEqual(sleeps.length, 1);
    assert.strictEqual(sleeps[0].ms, POLL_SLEEP);
  });

  test('busy cycle does not sleep', async () => {
    const REQ_ID = '99999999-9999-9999-9999-999999999999';
    const request = makeRequest(REQ_ID);
    const { deps, log } = makeDeps({
      ssh: async (args) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async () => ({ exitCode: 0, stdout: claudeEnvelope('ok'), stderr: '' }),
    });

    await runWorker({ deps, _maxCycles: 1 });

    const sleeps = log.filter((e) => e.type === 'sleep');
    assert.strictEqual(sleeps.length, 0, 'busy cycle must not sleep');
  });

  test('ssh failure during list causes sleep (empty cycle)', async () => {
    const { deps, log } = makeDeps({
      ssh: async () => { throw new Error('connection refused'); },
    });

    await runWorker({ deps, _maxCycles: 1 });

    const sleeps = log.filter((e) => e.type === 'sleep');
    assert.strictEqual(sleeps.length, 1);
    assert.strictEqual(sleeps[0].ms, POLL_SLEEP);
  });
});

// --- SIGTERM stops ---

describe('SIGTERM handling', () => {
  test('SIGTERM stops worker after current cycle', async () => {
    let cycleCount = 0;
    const { deps } = makeDeps({
      ssh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      sleep: async () => {
        cycleCount++;
        if (cycleCount >= 2) {
          process.emit('SIGTERM');
        }
      },
    });

    await runWorker({ deps, _maxCycles: 100 });

    // Should have stopped after SIGTERM, not run all 100 cycles
    assert.ok(cycleCount <= 3, `stopped after ${cycleCount} cycles`);
  });
});

// --- UUID validation ---

describe('id validation', () => {
  test('non-UUID id in filename is skipped and logged', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (msg) => { errors.push(msg); };

    const { deps, log } = makeDeps({
      ssh: async (args) => {
        if (args[1].includes('ls ')) {
          return { exitCode: 0, stdout: 'not-a-uuid.json\n../escape.json\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    try {
      await runWorker({ deps, _maxCycles: 1 });
    } finally {
      console.error = originalError;
    }

    // Should have logged the invalid ids
    assert.ok(errors.some((e) => e.includes('skipping invalid id')));
    // Should have slept (no valid jobs to process)
    const sleeps = log.filter((e) => e.type === 'sleep');
    assert.strictEqual(sleeps.length, 1);
  });

  test('valid UUID in filename is fetched', async () => {
    const REQ_ID = 'abcdef01-2345-6789-abcd-ef0123456789';
    const request = makeRequest(REQ_ID);
    let fetched = false;
    const { deps } = makeDeps({
      ssh: async (args) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          fetched = true;
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async () => ({ exitCode: 0, stdout: claudeEnvelope('ok'), stderr: '' }),
    });

    await runWorker({ deps, _maxCycles: 1 });

    assert.strictEqual(fetched, true);
  });
});

// --- System prompt file ---

describe('system prompt file handling', () => {
  const REQ_ID = '77777777-7777-7777-7777-777777777777';

  test('system prompt written to temp file and passed to runClaude', async () => {
    const request = makeRequest(REQ_ID);
    request.system = 'custom system prompt for testing';
    let capturedSystemFile;
    let systemFileContent;

    const { deps } = makeDeps({
      ssh: async (args) => {
        if (args[1].includes('ls ')) return { exitCode: 0, stdout: `${REQ_ID}.json\n`, stderr: '' };
        if (args[1].includes('cat ') && args[1].includes('requests/')) {
          return { exitCode: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async (params) => {
        capturedSystemFile = params.systemFile;
        // Read the file while it exists (before cleanup)
        systemFileContent = fs.readFileSync(params.systemFile, 'utf8');
        return { exitCode: 0, stdout: claudeEnvelope('done'), stderr: '' };
      },
    });

    await runWorker({ deps, _maxCycles: 1 });

    assert.ok(capturedSystemFile);
    assert.strictEqual(systemFileContent, 'custom system prompt for testing');
    // File should be cleaned up after
    assert.strictEqual(fs.existsSync(capturedSystemFile), false);
  });
});

describe('result write failure', () => {
  test('failed write keeps the request (no rm issued)', async () => {
    const { runWorker } = await import('../src/agent/worker.js');
    const sshCalls = [];
    const reqJson = JSON.stringify({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000', ts: '2026-07-18T08:00:00Z',
      kind: 'render', model: 'm', tools: [], system: 's', user: 'u'
    });
    const deps = {
      ssh: async (args, stdin) => {
        sshCalls.push({ args, stdin });
        const cmd = args[1] || '';
        if (cmd.startsWith('ls ')) return { exitCode: 0, stdout: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000.json\n', stderr: '' };
        if (cmd.startsWith('cat ') && cmd.includes('requests/')) return { exitCode: 0, stdout: reqJson, stderr: '' };
        if (cmd.includes('results/tmp-')) return { exitCode: 1, stdout: '', stderr: 'No such file or directory' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runClaude: async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: '{}' }), stderr: '' }),
      sleep: async () => {},
      now: () => '2026-07-18T08:01:00Z',
    };
    await runWorker({ deps, _maxCycles: 1 });
    const rmCalls = sshCalls.filter(c => (c.args[1] || '').startsWith('rm '));
    assert.strictEqual(rmCalls.length, 0, 'request must be kept when result write fails');
  });
});
