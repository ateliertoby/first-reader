import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../config/agent.json');

export function loadAgentConfig(configPath) {
  const p = configPath ?? DEFAULT_CONFIG_PATH;
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        `Config file not found: ${p}\n` +
        'Copy config/agent.example.json to config/agent.json and fill in your settings.'
      );
    }
    throw e;
  }
  const cfg = JSON.parse(raw);

  if (typeof cfg.model !== 'string' || cfg.model.trim() === '') {
    throw new Error('agent.json: model is required and must be a non-empty string');
  }

  if (cfg.timezone !== undefined) {
    if (typeof cfg.timezone !== 'string' || cfg.timezone.trim() === '') {
      throw new Error('agent.json: timezone must be a non-empty string');
    }
  }

  return {
    model: cfg.model,
    // Report rendering is judgment-heavy and may run a stronger model than
    // interactive intent parsing (which stays latency-sensitive).
    renderModel: (typeof cfg.renderModel === 'string' && cfg.renderModel.trim() !== '') ? cfg.renderModel : cfg.model,
    timezone: cfg.timezone ?? 'Asia/Hong_Kong',
    idleHours: typeof cfg.idleHours === 'number' && cfg.idleHours > 0 ? cfg.idleHours : 24,
    renderDeadlineHours: typeof cfg.renderDeadlineHours === 'number' && cfg.renderDeadlineHours > 0 ? cfg.renderDeadlineHours : 8,
    readBodyCap: typeof cfg.readBodyCap === 'number' && cfg.readBodyCap > 0 ? cfg.readBodyCap : 40,
    ownerName: (typeof cfg.ownerName === 'string' && cfg.ownerName.trim() !== '') ? cfg.ownerName : 'the user',
    workerName: (typeof cfg.workerName === 'string' && cfg.workerName.trim() !== '') ? cfg.workerName : 'worker',
    replyLanguage: (typeof cfg.replyLanguage === 'string' && cfg.replyLanguage.trim() !== '') ? cfg.replyLanguage : 'English',
  };
}

export function requireEnv(name) {
  const val = process.env[name];
  if (val === undefined || val === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return val;
}
