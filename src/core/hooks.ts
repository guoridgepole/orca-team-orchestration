import fs from 'node:fs';
import path from 'node:path';
import { gitPath } from './git.js';
import { readText, writeText } from './paths.js';

export const HOOK_MARKER = '# orca-team-orchestration pre-commit guard';

export type HookStatus = 'missing' | 'ours' | 'foreign';

export interface HookInstallResult {
  status: 'installed' | 'updated' | 'unchanged' | 'skipped';
  file: string | null;
  backup: string | null;
}

export function renderHook(cliEntry: string, root: string, stagedRepo?: string): string {
  const quote = (value: string): string => `"${value.split('\\').join('/')}"`;
  const repoArg = stagedRepo ? ` --staged-repo ${quote(stagedRepo)}` : '';
  return `#!/bin/sh\n${HOOK_MARKER}\nexec node ${quote(cliEntry)} --repo ${quote(root)} guard run --staged${repoArg}\n`;
}

function hookFile(root: string): string | null {
  const resolved = gitPath(root, 'hooks/pre-commit');
  return resolved === null ? null : path.resolve(root, resolved);
}

export function hookStatus(root: string): HookStatus {
  const file = hookFile(root);
  if (file === null || !fs.existsSync(file)) return 'missing';
  return (readText(file) ?? '').includes(HOOK_MARKER) ? 'ours' : 'foreign';
}

export function installPreCommitHook(
  root: string,
  cliEntry: string,
  options: { workspaceRoot?: string; stagedRepo?: string } = {},
): HookInstallResult {
  const file = hookFile(root);
  if (file === null) return { status: 'skipped', file: null, backup: null };

  const existing = readText(file);
  const next = renderHook(cliEntry, options.workspaceRoot ?? root, options.stagedRepo);
  let backup: string | null = null;

  if (existing !== null) {
    if (existing.includes(HOOK_MARKER)) {
      if (existing === next) return { status: 'unchanged', file, backup: null };
    } else {
      backup = `${file}.bak`;
      fs.copyFileSync(file, backup);
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeText(file, next);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return { status: existing === null ? 'installed' : backup !== null ? 'installed' : 'updated', file, backup };
}
