import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../config/agent.json');

const REPORT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function loadAgentConfig(configPath) {
  const p = configPath ?? DEFAULT_CONFIG_PATH;
  const raw = fs.readFileSync(p, 'utf-8');
  const cfg = JSON.parse(raw);

  if (typeof cfg.model !== 'string' || cfg.model.trim() === '') {
    throw new Error('agent.json: model is required and must be a non-empty string');
  }

  if (cfg.reportTime !== undefined) {
    if (cfg.reportTime !== 'auto' && (typeof cfg.reportTime !== 'string' || !REPORT_TIME_RE.test(cfg.reportTime))) {
      throw new Error(`agent.json: reportTime must be "HH:MM" (24h) or "auto", got: ${JSON.stringify(cfg.reportTime)}`);
    }
  }

  if (cfg.timezone !== undefined) {
    if (typeof cfg.timezone !== 'string' || cfg.timezone.trim() === '') {
      throw new Error('agent.json: timezone must be a non-empty string');
    }
  }

  return {
    model: cfg.model,
    reportTime: cfg.reportTime ?? '08:30',
    timezone: cfg.timezone ?? 'Asia/Hong_Kong',
  };
}

export function requireEnv(name) {
  const val = process.env[name];
  if (val === undefined || val === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return val;
}
