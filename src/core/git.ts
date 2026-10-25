import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './paths.js';
import type { WorkspaceLayout } from './workspace.js';

export interface GitResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

export interface RepoCommit {
  repo: string;
  sha: string;
}

export function runGit(root: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function gitShow(root: string, revision: string, file?: string): string | null {
  const spec = file ? `${revision}:${file}` : revision;
  const result = runGit(root, ['show', spec]);
  return result.ok ? result.stdout : null;
}

export function gitCommit(root: string, message: string, paths: string[]): string | null {
  const add = runGit(root, ['add', '--', ...paths]);
  if (!add.ok) return null;
  const commit = runGit(root, ['commit', '-m', message, '--', ...paths]);
  if (!commit.ok) return null;
  const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
  return head.ok ? head.stdout.trim() : null;
}

export function gitHasHead(root: string): boolean {
  return runGit(root, ['rev-parse', '--verify', 'HEAD']).ok;
}

export function headCommit(root: string): string {
  const result = runGit(root, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}

export function gitPath(root: string, pathWithinGit: string): string | null {
  const result = runGit(root, ['rev-parse', '--git-path', pathWithinGit]);
  if (!result.ok) return null;
  const relative = result.stdout.trim();
  if (relative === '') return null;
  return relative.startsWith('/') ? relative : `${root.split('\\').join('/')}/${relative}`;
}

export function checkpointCommit(root: string, message: string): string | null {
  const status = runGit(root, ['status', '--porcelain']);
  if (!status.ok || status.stdout.trim() === '') return null;
  const add = runGit(root, ['add', '-A', '--', '.', ':(exclude).orca-team-orchestration/runs']);
  if (!add.ok) return null;
  const commit = runGit(root, ['commit', '-q', '-m', message]);
  if (!commit.ok) return null;
  const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
  return head.ok ? head.stdout.trim() : null;
}

export function headCommits(layout: WorkspaceLayout): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const repo of layout.all) heads[repo.name] = headCommit(repo.root);
  return heads;
}

function shortHead(root: string): string {
  const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
  return head.ok ? head.stdout.trim() : '';
}

function stagedChanges(root: string, pathspecs: string[]): boolean {
  const diff = runGit(root, pathspecs.length > 0 ? ['diff', '--cached', '--quiet', '--', ...pathspecs] : ['diff', '--cached', '--quiet']);
  return !diff.ok;
}

function checkpointRootRepo(
  layout: WorkspaceLayout,
  message: string,
  managedPaths: string[],
): RepoCommit | null {
  const root = layout.root;
  const repo = layout.all[0];
  if (!repo) return null;
  const managed = [...new Set([...managedPaths, '.orca-team-orchestration/config.yaml', '.gitignore'])]
    .map((item) => toPosix(item).replace(/^\.\//, ''))
    .filter((item) => item !== '' && item !== '.' && fs.existsSync(path.join(root, item)));
  if (managed.length === 0) return null;

  const excludes = ['.orca-team-orchestration/runs', ...layout.repos.map((item) => item.path)]
    .map((item) => `:(exclude)${toPosix(item)}`);
  const add = runGit(root, ['add', '-A', '--', ...managed, ...excludes]);
  if (!add.ok) return null;
  if (!stagedChanges(root, managed)) return null;
  const commit = runGit(root, ['commit', '-q', '-m', message, '--', ...managed]);
  if (!commit.ok) return null;
  const sha = shortHead(root);
  return sha === '' ? null : { repo: repo.name, sha };
}

function checkpointChildRepo(root: string, name: string, message: string): RepoCommit | null {
  const add = runGit(root, ['add', '-A']);
  if (!add.ok) return null;
  if (!stagedChanges(root, [])) return null;
  const commit = runGit(root, ['commit', '-q', '-m', message]);
  if (!commit.ok) return null;
  const sha = shortHead(root);
  return sha === '' ? null : { repo: name, sha };
}

export function checkpointCommits(
  layout: WorkspaceLayout,
  message: string,
  options: { managedPaths?: string[] } = {},
): RepoCommit[] {
  const rootRepo = layout.all[0];
  if (!rootRepo) return [];
  if (layout.repos.length === 0) {
    const sha = checkpointCommit(layout.root, message);
    return sha === null ? [] : [{ repo: rootRepo.name, sha }];
  }
  const commits: RepoCommit[] = [];
  const rootCommit = checkpointRootRepo(layout, message, options.managedPaths ?? []);
  if (rootCommit) commits.push(rootCommit);
  for (const repo of layout.repos) {
    const commit = checkpointChildRepo(repo.root, repo.name, message);
    if (commit) commits.push(commit);
  }
  return commits;
}
