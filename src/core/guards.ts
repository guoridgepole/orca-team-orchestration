import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { GuardConfig } from './config.js';
import { gitHasHead, gitShow, runGit } from './git.js';
import { normalizePattern, toPosix } from './paths.js';
import { ROOT_REPO_NAME, repoByName, workspacePath, type WorkspaceLayout } from './workspace.js';

export interface FileChange {
  path: string;
  oldPath?: string;
  repo: string;
  repoRoot: string;
  relPath: string;
  oldRelPath?: string;
  status: string;
  added: number;
  deleted: number;
}

export interface Violation {
  guardId: string;
  guardType: GuardConfig['type'];
  file: string;
  action: string;
  fix: string;
  repo?: string;
}

function splitLines(value: string): string[] {
  return value.split('\n').filter((line) => line !== '');
}

function rawChange(root: string, file: string, extra: { oldPath?: string; status: string; added: number; deleted: number }): FileChange {
  return {
    path: toPosix(file),
    oldPath: extra.oldPath === undefined ? undefined : toPosix(extra.oldPath),
    repo: ROOT_REPO_NAME,
    repoRoot: root,
    relPath: toPosix(file),
    oldRelPath: extra.oldPath === undefined ? undefined : toPosix(extra.oldPath),
    status: extra.status,
    added: extra.added,
    deleted: extra.deleted,
  };
}

export function collectChanges(root: string, staged: boolean): FileChange[] {
  if (!gitHasHead(root)) {
    const tracked = splitLines(runGit(root, ['ls-files']).stdout);
    const untracked = splitLines(runGit(root, ['ls-files', '--others', '--exclude-standard']).stdout);
    return [...new Set([...tracked, ...untracked])].map((file) =>
      rawChange(root, file, { status: 'A', added: 0, deleted: 0 }),
    );
  }

  const baseArgs = staged ? ['diff', '--cached', '-M', 'HEAD'] : ['diff', '-M', 'HEAD'];
  const nameStatus = runGit(root, [...baseArgs, '--name-status']);
  const numstat = runGit(root, [...baseArgs, '--numstat']);
  const counts = new Map<string, { added: number; deleted: number }>();
  for (const line of splitLines(numstat.stdout)) {
    const [addedRaw, deletedRaw, ...rest] = line.split('\t');
    const file = toPosix(rest.join('\t'));
    if (!file) continue;
    const added = addedRaw === '-' ? 0 : Number(addedRaw);
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
    counts.set(file, { added: Number.isFinite(added) ? added : 0, deleted: Number.isFinite(deleted) ? deleted : 0 });
  }

  const changes = new Map<string, FileChange>();
  for (const line of splitLines(nameStatus.stdout)) {
    const [statusRaw, first, second] = line.split('\t');
    const status = (statusRaw ?? '').charAt(0);
    if (!first) continue;
    if (status === 'R' || status === 'C') {
      const oldPath = toPosix(first);
      const newPath = toPosix(second ?? first);
      const count = counts.get(newPath) ?? { added: 0, deleted: 0 };
      changes.set(newPath, rawChange(root, newPath, { oldPath, status, ...count }));
    } else {
      const file = toPosix(first);
      const count = counts.get(file) ?? { added: 0, deleted: 0 };
      changes.set(file, rawChange(root, file, { status, ...count }));
    }
  }

  if (!staged) {
    for (const file of splitLines(runGit(root, ['ls-files', '--others', '--exclude-standard']).stdout)) {
      const normalized = toPosix(file);
      if (!changes.has(normalized)) {
        changes.set(normalized, rawChange(root, normalized, { status: 'A', added: 0, deleted: 0 }));
      }
    }
  }

  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function underRepo(file: string, repoPath: string): boolean {
  if (repoPath === '.') return false;
  return file === repoPath || file.startsWith(`${repoPath}/`);
}

function rehome(layout: WorkspaceLayout, repo: (typeof layout.all)[number], change: FileChange): FileChange {
  return {
    ...change,
    path: workspacePath(layout, repo, change.relPath),
    oldPath: change.oldRelPath === undefined ? undefined : workspacePath(layout, repo, change.oldRelPath),
    repo: repo.name,
    repoRoot: repo.root,
  };
}

export function collectWorkspaceChanges(
  layout: WorkspaceLayout,
  staged: boolean,
  onlyRepos?: string[],
): FileChange[] {
  const wanted = onlyRepos === undefined || onlyRepos.includes('all') ? null : new Set(onlyRepos);
  const changes = new Map<string, FileChange>();
  for (const repo of layout.all) {
    if (wanted !== null && !wanted.has(repo.name)) continue;
    for (const change of collectChanges(repo.root, staged)) {
      if (repo.name === ROOT_REPO_NAME && layout.repos.some((child) => underRepo(change.relPath, child.path))) {
        continue;
      }
      const mapped = rehome(layout, repo, change);
      changes.set(mapped.path, mapped);
    }
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function matchesAny(patterns: string[], file: string): boolean {
  return patterns.some((pattern) =>
    minimatch(file, normalizePattern(pattern), { dot: true, nocase: process.platform === 'win32' }),
  );
}

function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function fixFor(guard: GuardConfig, fallback: string): string {
  return guard.message?.trim() ? guard.message.trim() : fallback;
}

function checkAppendOnly(guard: GuardConfig, changes: FileChange[], staged: boolean): Violation[] {
  const violations: Violation[] = [];
  for (const change of changes) {
    if (!matchesAny(guard.paths, change.path) && !(change.oldPath && matchesAny(guard.paths, change.oldPath))) {
      continue;
    }
    if (change.status === 'D' || change.status === 'R') {
      violations.push({
        guardId: guard.id,
        guardType: guard.type,
        repo: change.repo,
        file: change.path,
        action: '删除或重命名了只允许追加的文件',
        fix: fixFor(guard, '恢复文件，并把新内容追加到末尾'),
      });
      continue;
    }
    if (change.status !== 'A' && change.status !== 'M') continue;

    const base = normalizeEol(gitShow(change.repoRoot, 'HEAD', change.relPath) ?? '');
    const currentRaw = staged
      ? gitShow(change.repoRoot, ':0:' + change.relPath) ?? ''
      : readFileOrNull(path.join(change.repoRoot, change.relPath)) ?? '';
    const current = normalizeEol(currentRaw);

    if (!current.startsWith(base)) {
      violations.push({
        guardId: guard.id,
        guardType: guard.type,
        repo: change.repo,
        file: change.path,
        action: '修改或删除了已有内容',
        fix: fixFor(guard, '恢复原有内容，只把新增内容追加到文件末尾'),
      });
      continue;
    }

    if (guard.require_header) {
      const appended = current.slice(base.length);
      const firstLine = appended.split('\n').find((line) => line.trim() !== '') ?? '';
      if (!firstLine.startsWith(guard.require_header)) {
        violations.push({
          guardId: guard.id,
          guardType: guard.type,
          repo: change.repo,
          file: change.path,
          action: `追加段的第一条内容没有以「${guard.require_header}」开头`,
          fix: fixFor(guard, `在追加内容前补上 ${guard.require_header} 开头的迁移标记`),
        });
      }
    }
  }
  return violations;
}

function checkImmutable(guard: GuardConfig, changes: FileChange[]): Violation[] {
  const violations: Violation[] = [];
  for (const change of changes) {
    const inScope = matchesAny(guard.paths, change.path) || Boolean(change.oldPath && matchesAny(guard.paths, change.oldPath));
    if (!inScope) continue;
    if (change.status === 'A') {
      if (guard.allow_new === true) continue;
      violations.push({
        guardId: guard.id,
        guardType: guard.type,
        repo: change.repo,
        file: change.path,
        action: '新增了受保护文件',
        fix: fixFor(guard, '删除新增文件，或为这条守则设置 allow_new: true'),
      });
      continue;
    }
    violations.push({
      guardId: guard.id,
      guardType: guard.type,
      repo: change.repo,
      file: change.path,
      action: change.status === 'D' ? '删除了受保护文件' : change.status === 'R' ? '重命名了受保护文件' : '修改了受保护文件',
      fix: fixFor(guard, '恢复该文件；需要改动时走审批'),
    });
  }
  return violations;
}

function checkNoDelete(guard: GuardConfig, changes: FileChange[]): Violation[] {
  const violations: Violation[] = [];
  for (const change of changes) {
    const inScope = matchesAny(guard.paths, change.path) || Boolean(change.oldPath && matchesAny(guard.paths, change.oldPath));
    if (!inScope) continue;
    if (change.status === 'D' || change.status === 'R') {
      violations.push({
        guardId: guard.id,
        guardType: guard.type,
        repo: change.repo,
        file: change.path,
        action: change.status === 'D' ? '删除了文件' : '重命名或移动了文件',
        fix: fixFor(guard, '恢复文件，用新增代替删除'),
      });
      continue;
    }
    if (change.deleted > 0) {
      violations.push({
        guardId: guard.id,
        guardType: guard.type,
        repo: change.repo,
        file: change.path,
        action: `删除了 ${change.deleted} 行`,
        fix: fixFor(guard, '恢复被删除的行，只能新增'),
      });
    }
  }
  return violations;
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function runGuards(
  root: string,
  guards: GuardConfig[],
  options: { staged?: boolean; ids?: string[]; layout?: WorkspaceLayout; stagedRepo?: string } = {},
): Violation[] {
  const selected = options.ids?.length ? guards.filter((guard) => options.ids?.includes(guard.id)) : guards;
  const staged = options.staged === true;
  let changes: FileChange[];
  if (options.layout) {
    if (staged) {
      const selector = options.stagedRepo ?? ROOT_REPO_NAME;
      const targets =
        selector === 'all' ? options.layout.all : [repoByName(options.layout, selector)];
      changes = collectWorkspaceChanges(options.layout, true, targets.map((repo) => repo.name));
    } else {
      changes = collectWorkspaceChanges(options.layout, false);
    }
  } else {
    changes = collectChanges(root, staged);
  }
  const violations: Violation[] = [];
  for (const guard of selected) {
    if (guard.type === 'append-only') violations.push(...checkAppendOnly(guard, changes, staged));
    if (guard.type === 'immutable') violations.push(...checkImmutable(guard, changes));
    if (guard.type === 'no-delete') violations.push(...checkNoDelete(guard, changes));
  }
  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map(
      (violation) =>
        `- [${violation.guardId}] ${violation.file}：${violation.action}\n  修法：${violation.fix}`,
    )
    .join('\n');
}
