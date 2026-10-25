import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Config } from './config.js';
import { projectConfigPath } from './config.js';
import { CliError, EXIT } from './errors.js';
import { runGit } from './git.js';
import { isInside, readText, toPosix } from './paths.js';

export const ROOT_REPO_NAME = 'workspace';

export interface RepoRef {
  name: string;
  path: string;
  root: string;
}

export interface WorkspaceLayout {
  root: string;
  repos: RepoRef[];
  all: RepoRef[];
}

function realpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparable(realpath(left)) === comparable(realpath(right));
}

function gitTopLevel(dir: string): string | null {
  const result = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value === '' ? null : path.resolve(value);
}

export function discoverRepos(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (fs.existsSync(path.join(root, entry.name, '.git'))) repos.push(toPosix(entry.name));
  }
  return repos.sort();
}

export function workspaceLayout(
  root: string,
  config: Config,
  options: { validateFs?: boolean } = {},
): WorkspaceLayout {
  const absoluteRoot = path.resolve(root);
  const repos: RepoRef[] = (config.project.repos ?? []).map((repo) => ({
    name: repo.name,
    path: repo.path,
    root: path.resolve(absoluteRoot, repo.path),
  }));
  const layout: WorkspaceLayout = {
    root: absoluteRoot,
    repos,
    all: [{ name: ROOT_REPO_NAME, path: '.', root: absoluteRoot }, ...repos],
  };
  if (options.validateFs === true) validateWorkspaceLayout(layout);
  return layout;
}

export function validateWorkspace(root: string, config: Config): WorkspaceLayout {
  return workspaceLayout(root, config, { validateFs: true });
}

function validateWorkspaceLayout(layout: WorkspaceLayout): void {
  const root = layout.root;
  const top = gitTopLevel(root);
  if (top === null || !samePath(top, root)) {
    throw new CliError(EXIT.config, `workspace 根不是 git 仓库顶层：${root}`);
  }
  const rootReal = realpath(root);
  for (const repo of layout.repos) {
    const absolute = path.resolve(root, repo.path);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      throw new CliError(EXIT.config, `关联仓库不存在：${repo.name}（${repo.path}）`);
    }
    if (stat.isSymbolicLink()) {
      throw new CliError(EXIT.config, `关联仓库不能是符号链接：${repo.name}（${repo.path}）`);
    }
    if (!stat.isDirectory()) {
      throw new CliError(EXIT.config, `关联仓库不是目录：${repo.name}（${repo.path}）`);
    }
    const expectedReal = path.resolve(rootReal, repo.path);
    if (comparable(realpath(absolute)) !== comparable(expectedReal) || !isInside(rootReal, realpath(absolute))) {
      throw new CliError(EXIT.config, `关联仓库路径越界或含符号链接：${repo.name}（${repo.path}）`);
    }
    let gitStat: fs.Stats;
    try {
      gitStat = fs.lstatSync(path.join(absolute, '.git'));
    } catch {
      throw new CliError(EXIT.config, `关联仓库缺少 .git：${repo.name}（${repo.path}）`);
    }
    if (!gitStat.isDirectory()) {
      throw new CliError(EXIT.config, `暂不支持 worktree/submodule 形式的关联仓库：${repo.name}`);
    }
    const repoTop = gitTopLevel(absolute);
    if (repoTop === null || !samePath(repoTop, absolute)) {
      throw new CliError(EXIT.config, `关联仓库不是 git 顶层：${repo.name}（${repo.path}）`);
    }
    const tracked = runGit(root, ['ls-files', '--error-unmatch', '--', repo.path]);
    if (tracked.ok) {
      throw new CliError(
        EXIT.config,
        `关联仓库被 workspace 根跟踪：${repo.path}；先执行 git rm -r --cached ${repo.path}`,
      );
    }
  }
}

export function workspacePath(layout: WorkspaceLayout, repo: RepoRef, relPath: string): string {
  const normalized = toPosix(relPath).replace(/^\.\//, '');
  if (repo.path === '.' || repo.name === ROOT_REPO_NAME) return normalized;
  return normalized === '' ? repo.path : `${repo.path}/${normalized}`;
}

export function repoByName(layout: WorkspaceLayout, name: string): RepoRef {
  if (name === '.' || name === 'root' || name === ROOT_REPO_NAME) return layout.all[0]!;
  const repo = layout.repos.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!repo) throw new CliError(EXIT.usage, `未知关联仓库：${name}`);
  return repo;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectRepoPaths(raw: string): string[] | null {
  try {
    const parsed: unknown = parseYaml(raw);
    if (!isPlainObject(parsed)) return null;
    const project = parsed.project;
    if (!isPlainObject(project) || !Array.isArray(project.repos)) return null;
    return project.repos.flatMap((item) =>
      isPlainObject(item) && typeof item.path === 'string' ? [item.path] : [],
    );
  } catch {
    return null;
  }
}

export function findWorkspaceRoot(start: string): string | null {
  const startAbs = path.resolve(start);
  const gitRoot = gitTopLevel(startAbs) ?? startAbs;
  let current = gitRoot;
  while (true) {
    const raw = readText(projectConfigPath(current));
    if (raw !== null) {
      const repoPaths = projectRepoPaths(raw);
      if (repoPaths?.some((repoPath) => samePath(path.resolve(current, repoPath), gitRoot))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
