import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.js';

export function findRepoRoot(start = process.cwd()): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return path.resolve(out.trim());
  } catch {
    throw new CliError(EXIT.usage, `不是 git 仓库：${start}；多仓父目录请先运行 orca-team-orchestration init --workspace`);
  }
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export function relativePosix(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute));
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertInside(root: string, target: string, label: string): void {
  if (!isInside(root, target)) {
    throw new CliError(EXIT.config, `${label} 必须位于仓库内：${target}`);
  }
}

export function normalizePattern(pattern: string): string {
  let value = toPosix(pattern.trim());
  if (value.startsWith('./')) value = value.slice(2);
  if (value.endsWith('/')) value = `${value}**`;
  return value;
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
