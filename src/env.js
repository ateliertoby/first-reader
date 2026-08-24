import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The CLI is invoked from arbitrary working directories, so .env is resolved
// against the repository root rather than the caller's cwd. Import this before
// any module that reads process.env.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
