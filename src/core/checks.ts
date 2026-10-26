import path from 'node:path';
import { minimatch } from 'minimatch';
import type { Config } from './config.js';
import { stageRoles } from './config.js';
import { runGit } from './git.js';
import { normalizePattern, readText, toPosix } from './paths.js';
import { versionFromStory } from './story.js';
import { ROOT_REPO_NAME, type WorkspaceLayout } from './workspace.js';

export interface CheckIssue {
  kind: 'artifact' | 'scope' | 'command';
  message: string;
}

export function renderArtifactPath(template: string, story: string, round: number): string {
  const version = versionFromStory(story);
  return template
    .replaceAll('{{story}}', story)
    .replaceAll('{{round}}', String(round))
    .replaceAll('{{version}}', version ?? '{{version}}');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function artifactFirstLine(content: string): string | null {
  return (
    content
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? null
  );
}

export function artifactIssuesForRole(
  root: string,
  config: Config,
  roleName: string,
  story: string,
  round: number,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const role = config.roles[roleName];
  if (!role) return issues;
  const relative = renderArtifactPath(role.artifact.path, story, round);
  const absolute = path.join(root, relative);
  const content = readText(absolute);
  if (content === null) {
    return [{ kind: 'artifact', message: `${roleName} 缺少产物：${relative}` }];
  }

  const firstLine = artifactFirstLine(content);
  const allowedFirst = role.artifact.first_line ?? [];
  if (allowedFirst.length > 0 && !allowedFirst.includes(firstLine ?? '')) {
    issues.push({
      kind: 'artifact',
      message: `${relative} 首行必须是 ${allowedFirst.join(' / ')}，实际是「${firstLine ?? ''}」`,
    });
  }

  for (const section of role.artifact.required_sections ?? []) {
    const heading = new RegExp(`^#{1,6}\\s*${escapeRegExp(section)}\\s*$`, 'm');
    if (!heading.test(content)) {
      issues.push({ kind: 'artifact', message: `${relative} 缺少章节「${section}」` });
    }
  }
  return issues;
}

export function artifactIssues(
  root: string,
  config: Config,
  stage: string,
  story: string,
  round: number,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const roleName of stageRoles(config, stage)) {
    issues.push(...artifactIssuesForRole(root, config, roleName, story, round));
  }
  return issues;
}

export function roleArtifactPath(config: Config, roleName: string, story: string, round: number): string | null {
  const role = config.roles[roleName];
  if (!role) return null;
  return renderArtifactPath(role.artifact.path, story, round);
}

function parseStatusLine(line: string): { oldPath?: string; path: string } | null {
  if (line.trim() === '') return null;
  const raw = line.slice(3);
  const file = raw.includes(' -> ') ? (raw.split(' -> ').pop() ?? raw) : raw;
  const oldRaw = raw.includes(' -> ') ? raw.split(' -> ')[0] : undefined;
  return {
    ...(oldRaw === undefined ? {} : { oldPath: toPosix(oldRaw.replace(/^"|"$/g, '')) }),
    path: toPosix(file.replace(/^"|"$/g, '')),
  };
}

export function dirtyPaths(root: string): Set<string> {
  const files = new Set<string>();
  const status = runGit(root, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return files;
  for (const line of status.stdout.split('\n')) {
    const parsed = parseStatusLine(line);
    if (parsed) files.add(parsed.path);
  }
  return files;
}

function underRepo(file: string, repoPath: string): boolean {
  return repoPath !== '.' && (file === repoPath || file.startsWith(`${repoPath}/`));
}

export function workspaceDirtyPaths(layout: WorkspaceLayout): Set<string> {
  const files = new Set<string>();
  for (const repo of layout.all) {
    const status = runGit(repo.root, ['status', '--porcelain', '--untracked-files=all']);
    if (!status.ok) continue;
    for (const line of status.stdout.split('\n')) {
      const parsed = parseStatusLine(line);
      if (!parsed) continue;
      if (repo.name === ROOT_REPO_NAME) {
        const touchesChild = layout.repos.some(
          (child) => underRepo(parsed.path, child.path) || (parsed.oldPath !== undefined && underRepo(parsed.oldPath, child.path)),
        );
        if (touchesChild) continue;
        files.add(parsed.path);
      } else {
        files.add(`${repo.path}/${parsed.path}`);
      }
    }
  }
  return files;
}

function scopeIssuesFrom(
  dirty: Iterable<string>,
  config: Config,
  stage: string,
  story: string,
  ignore: ReadonlySet<string>,
): CheckIssue[] {
  const version = versionFromStory(story) ?? '{{version}}';
  const roles = stageRoles(config, stage);
  const allowed = new Set<string>();
  for (const roleName of roles) {
    const role = config.roles[roleName];
    if (!role) continue;
    for (const pattern of role.writes) allowed.add(normalizePattern(pattern.replaceAll('{{version}}', version)));
    if (roleName === config.flow.develop) {
      for (const pattern of config.project.paths.source) allowed.add(normalizePattern(pattern));
      for (const pattern of config.project.paths.tests) allowed.add(normalizePattern(pattern));
      if (config.project.paths.db) allowed.add(normalizePattern(config.project.paths.db));
    }
  }

  const issues: CheckIssue[] = [];
  for (const normalized of dirty) {
    if (ignore.has(normalized)) continue;
    if (normalized.startsWith('.orca-team-orchestration/runs/')) continue;
    const covered = [...allowed].some((pattern) =>
      minimatch(normalized, pattern, { dot: true, nocase: process.platform === 'win32' }),
    );
    if (!covered) {
      issues.push({
        kind: 'scope',
        message: `${stage} 阶段越界改动：${normalized}（允许：${[...allowed].join(', ')}）`,
      });
    }
  }
  return issues;
}

export function scopeIssues(
  root: string,
  config: Config,
  stage: string,
  story: string,
  ignore: ReadonlySet<string> = new Set(),
): CheckIssue[] {
  return scopeIssuesFrom(dirtyPaths(root), config, stage, story, ignore);
}

export function scopeIssuesForWorkspace(
  layout: WorkspaceLayout,
  config: Config,
  stage: string,
  story: string,
  ignore: ReadonlySet<string> = new Set(),
): CheckIssue[] {
  return scopeIssuesFrom(workspaceDirtyPaths(layout), config, stage, story, ignore);
}
