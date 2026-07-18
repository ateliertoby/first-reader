// Op executor — validates strictly, runs each op, collects result lines
// Never throws past executeOps — all errors become result lines

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { addRule, removeRule, addGuard, removeGuard, writeConfig } from '../commands/rule.js';
import { SortLogDB } from '../sorter/db.js';

const VALID_OP_TYPES = new Set([
  'rule_add', 'rule_rm', 'guard_add', 'guard_rm',
  'rescue', 'reminder_ack', 'junk_rescue', 'junk_dismiss',
  'trigger_report', 'trigger_audit',
  'deep_verify', 'inspect', 'note_add'
]);

const VALID_BUCKETS = new Set(['accounting', 'notifications', 'keep']);

// Strict validation — LLM schema is loose, executor is the gatekeeper
function validateOp(op) {
  if (!op || typeof op.type !== 'string') return 'op 冇 type';
  if (!VALID_OP_TYPES.has(op.type)) return `唔識呢個 operation: ${op.type}`;

  switch (op.type) {
    case 'rule_add':
      if (!VALID_BUCKETS.has(op.bucket)) return 'bucket 必須係 accounting/notifications/keep';
      if (!Array.isArray(op.domains) || op.domains.length === 0) return 'domains 必須有至少一個';
      for (const d of op.domains) {
        if (typeof d !== 'string') return 'domain 必須係 string';
        if (d.includes('@')) return `domain "${d}" 唔可以有 @`;
        if (!d.includes('.')) return `domain "${d}" 必須有 dot`;
        if (d !== d.toLowerCase()) return `domain "${d}" 必須 lowercase`;
      }
      if (op.subject) {
        try { new RegExp(op.subject, 'i'); } catch (e) { return `subject regex 唔啱：${e.message}`; }
      }
      if (op.subjectExclude) {
        try { new RegExp(op.subjectExclude, 'i'); } catch (e) { return `subjectExclude regex 唔啱：${e.message}`; }
      }
      return null;
    case 'rule_rm':
      if (!op.id || typeof op.id !== 'string') return 'id 必須係 non-empty string';
      return null;
    case 'guard_add':
    case 'guard_rm':
      if (!op.word || typeof op.word !== 'string') return 'word 必須係 non-empty string';
      return null;
    case 'rescue':
      if (!op.sender && !op.rule && !op.email_id) return 'rescue 要至少一個 filter (sender/rule/email_id)';
      return null;
    case 'reminder_ack': {
      if (op.id == null) return 'id 必須提供';
      const n = Number(op.id);
      if (!Number.isFinite(n)) return 'reminder id 必須係 number';
      return null;
    }
    case 'junk_rescue':
    case 'junk_dismiss':
      if (!op.email_id || typeof op.email_id !== 'string') return 'email_id 必須係 non-empty string';
      return null;
    case 'trigger_report':
    case 'trigger_audit':
      return null;
    case 'deep_verify':
      if (!op.claim || typeof op.claim !== 'string') return 'claim 必須係 non-empty string';
      return null;
    case 'inspect':
      return null;
    case 'note_add':
      if (!op.text || typeof op.text !== 'string') return 'text 必須係 non-empty string';
      return null;
    default:
      return `唔識呢個 operation: ${op.type}`;
  }
}

export { validateOp as _validateOp };

// Production git runner — injectable via deps.git for testing
export function makeGitRunner(cwd) {
  return async (args) => {
    return new Promise((resolve) => {
      execFile('git', args, { cwd }, (err, stdout, stderr) => {
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ exitCode, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
  };
}

// Git flow: pull --rebase -> write -> add + commit -> push
// On any failure: restore to post-pull state, best-effort abort
async function withGitFlow(deps, filePath, writeFn, userText) {
  const filename = path.basename(filePath);
  const failMsg = `${filename} 有衝突，Air 嗰邊搞掂先`;

  // 1. Pull
  const pull = await deps.git(['pull', '--rebase']);
  if (pull.exitCode !== 0) {
    await deps.git(['rebase', '--abort']).catch(() => {});
    return { ok: false, message: failMsg };
  }

  // Save post-pull state as revert target
  let backup;
  try { backup = fs.readFileSync(filePath, 'utf8'); } catch { backup = null; }

  // 2. Write
  try {
    writeFn();
  } catch (e) {
    if (backup !== null) fs.writeFileSync(filePath, backup);
    return { ok: false, message: e.message };
  }

  // 3. Add + commit
  const truncated = userText.slice(0, 60);
  const add = await deps.git(['add', filePath]);
  if (add.exitCode !== 0) {
    if (backup !== null) fs.writeFileSync(filePath, backup);
    else { try { fs.unlinkSync(filePath); } catch {} }
    return { ok: false, message: failMsg };
  }

  const commit = await deps.git(['commit', '-m', `agent: "${truncated}"`]);
  if (commit.exitCode !== 0) {
    if (backup !== null) fs.writeFileSync(filePath, backup);
    else { try { fs.unlinkSync(filePath); } catch {} }
    return { ok: false, message: failMsg };
  }

  // 4. Push
  const push = await deps.git(['push']);
  if (push.exitCode !== 0) {
    await deps.git(['reset', 'HEAD~1']).catch(() => {});
    await deps.git(['rebase', '--abort']).catch(() => {});
    if (backup !== null) fs.writeFileSync(filePath, backup);
    else { try { fs.unlinkSync(filePath); } catch {} }
    return { ok: false, message: failMsg };
  }

  return { ok: true };
}

export async function executeOps(ops, deps) {
  const results = [];

  for (const op of ops) {
    const validationError = validateOp(op);
    if (validationError) {
      results.push(validationError);
      continue;
    }

    try {
      switch (op.type) {
        case 'rule_add': {
          let ruleId;
          let probDate;
          const gitResult = await withGitFlow(deps, deps.rulesPath, () => {
            const raw = JSON.parse(fs.readFileSync(deps.rulesPath, 'utf8'));
            const { config: newConfig, id } = addRule(raw, {
              bucket: op.bucket,
              domains: op.domains,
              subject: op.subject || null,
              subjectExclude: op.subjectExclude || null,
              ignoreGuards: op.ignoreGuards || false,
              note: op.note || null,
            });
            ruleId = id;
            probDate = newConfig.rules.find(r => r.id === id).probationUntil;
            writeConfig(newConfig, deps.rulesPath);
          }, deps.userText);

          if (!gitResult.ok) {
            results.push(gitResult.message);
          } else {
            results.push(`已落 rule ${ruleId} [${op.bucket}]，probation 至 ${probDate}`);
          }
          break;
        }

        case 'rule_rm': {
          const gitResult = await withGitFlow(deps, deps.rulesPath, () => {
            const raw = JSON.parse(fs.readFileSync(deps.rulesPath, 'utf8'));
            const newConfig = removeRule(raw, op.id);
            writeConfig(newConfig, deps.rulesPath);
          }, deps.userText);

          if (!gitResult.ok) {
            results.push(gitResult.message);
          } else {
            results.push(`已刪 rule "${op.id}"`);
          }
          break;
        }

        case 'guard_add': {
          const gitResult = await withGitFlow(deps, deps.rulesPath, () => {
            const raw = JSON.parse(fs.readFileSync(deps.rulesPath, 'utf8'));
            const newConfig = addGuard(raw, op.word);
            writeConfig(newConfig, deps.rulesPath);
          }, deps.userText);

          if (!gitResult.ok) {
            results.push(gitResult.message);
          } else {
            results.push(`已加 guard "${op.word}"`);
          }
          break;
        }

        case 'guard_rm': {
          const gitResult = await withGitFlow(deps, deps.rulesPath, () => {
            const raw = JSON.parse(fs.readFileSync(deps.rulesPath, 'utf8'));
            const newConfig = removeGuard(raw, op.word);
            writeConfig(newConfig, deps.rulesPath);
          }, deps.userText);

          if (!gitResult.ok) {
            results.push(gitResult.message);
          } else {
            results.push(`已刪 guard "${op.word}"`);
          }
          break;
        }

        case 'rescue': {
          const logDb = new SortLogDB(deps.sortDbPath);
          try {
            const rows = logDb.listUnsortable({
              sender: op.sender || undefined,
              ruleId: op.rule || undefined,
              emailId: op.email_id || undefined,
            });
            if (rows.length === 0) {
              results.push('冇搵到可以 rescue 嘅 email');
              break;
            }
            const inboxResp = await deps.graphGet('/me/mailFolders/inbox');
            const inboxId = inboxResp.id;
            let moved = 0;
            for (const row of rows) {
              try {
                const movedMsg = await deps.graphPost(
                  `/me/messages/${row.email_id}/move`,
                  { destinationId: inboxId }
                );
                const newId = movedMsg?.id || row.email_id;
                logDb.insert({
                  run_at: deps.getNow(),
                  email_id: newId,
                  sender: row.sender,
                  domain: row.domain,
                  subject: row.subject,
                  subject_key: row.subject_key,
                  received_at: row.received_at,
                  bucket: row.bucket,
                  rule_id: row.rule_id,
                  action: 'unsorted',
                  parsed: null,
                });
                moved++;
              } catch (e) {
                results.push(`rescue 失敗：${row.sender} — ${e.message}`);
              }
            }
            if (moved > 0) results.push(`已 rescue ${moved} 封 email 返 inbox`);
          } finally {
            logDb.close();
          }
          break;
        }

        case 'reminder_ack': {
          const reminderId = Number(op.id);
          const now = deps.getNow();
          const ok = deps.agentDb.resolveReminder(reminderId, 'alex', now);
          if (ok) {
            results.push(`已確認 reminder #${reminderId} 解決`);
          } else {
            results.push(`reminder #${reminderId} 搵唔到或者已經 resolved`);
          }
          break;
        }

        case 'junk_rescue': {
          try {
            await deps.graphPost(
              `/me/messages/${op.email_id}/move`,
              { destinationId: 'inbox' }
            );
            results.push('已將 junk email 救返 inbox');
          } catch (e) {
            results.push(`junk rescue 失敗：${e.message}`);
          }
          break;
        }

        case 'junk_dismiss': {
          deps.agentDb.dismissJunk(op.email_id, deps.getNow());
          results.push('已 dismiss junk email');
          break;
        }

        case 'trigger_report': {
          try {
            await deps.runReport({ dry: false });
            await deps.drainOutbox();
            results.push('報告已生成並送出');
          } catch (e) {
            results.push(`報告生成失敗：${e.message}`);
          }
          break;
        }

        case 'trigger_audit': {
          results.push('審計功能未支援，B5 上線');
          break;
        }

        case 'deep_verify': {
          try {
            const evidence = await deps.deepVerify(op.claim, op.email_id || null);
            results.push(evidence);
          } catch (e) {
            results.push(`deep verify 失敗：${e.message}`);
          }
          break;
        }

        case 'inspect': {
          results.push('未支援，B7 之後有');
          break;
        }

        case 'note_add': {
          const gitResult = await withGitFlow(deps, deps.notesPath, () => {
            let content;
            try { content = fs.readFileSync(deps.notesPath, 'utf8'); } catch { content = ''; }
            fs.writeFileSync(deps.notesPath, content + op.text + '\n');
          }, deps.userText);

          if (!gitResult.ok) {
            results.push(gitResult.message);
          } else {
            results.push('已記低');
          }
          break;
        }
      }
    } catch (e) {
      results.push(`${op.type} 失敗：${e.message}`);
    }
  }

  return results;
}
