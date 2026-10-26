import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinDefaults, validateConfig, type Config } from '../src/core/config.js';
import { runGit } from '../src/core/git.js';

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Orca Team Orchestration Test']);
}

// macOS 上 git rev-parse --show-toplevel 与 fs.realpathSync 会把 /var 解析为 /private/var，
// 测试断言若混用两种形式会误报；darwin 下统一返回真实路径形式。
function normalizeTempDir(dir: string): string {
  return process.platform === 'darwin' ? fs.realpathSync(dir) : dir;
}

export function tempRepo(prefix = 'repo'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orca-team-orchestration-${prefix}-`));
  initRepo(dir);
  return normalizeTempDir(dir);
}

export interface TempWorkspace {
  root: string;
  api: string;
  web: string;
}

export function tempWorkspace(options: { gitRoot?: boolean } = {}): TempWorkspace {
  const root = normalizeTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-orchestration-workspace-')));
  if (options.gitRoot !== false) {
    initRepo(root);
    fs.writeFileSync(path.join(root, 'README.md'), '# workspace\n', 'utf8');
    runGit(root, ['add', 'README.md']);
    runGit(root, ['commit', '-q', '-m', 'init']);
  }
  const api = path.join(root, 'api');
  const web = path.join(root, 'web');
  for (const repo of [api, web]) {
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
    commitAll(repo, 'init');
  }
  return { root, api, web };
}

export function workspaceConfig(overrides: Record<string, unknown> = {}): Config {
  const raw = builtinDefaults('workspace-demo') as unknown as Record<string, unknown>;
  const project = raw.project as Record<string, unknown>;
  project.repos = [
    { name: 'api', path: 'api' },
    { name: 'web', path: 'web' },
  ];
  return validateConfig(mergeOverrides(raw, overrides));
}

function mergeOverrides(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
    ) {
      out[key] = mergeOverrides(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export function commitAll(root: string, message = 'baseline'): string {
  runGit(root, ['add', '-A']);
  const result = runGit(root, ['commit', '-q', '-m', message]);
  if (!result.ok) throw new Error(`git commit failed: ${result.stderr}`);
  return runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
}

export function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export const VALID_STORY = `# story-0.1.0-001 午餐抽签

- 背景: 中午不知道吃什么
- 明确不做:
  - 后端接口

## 功能清单

- F1 随机抽签
- F2 展示结果

## 验收标准

- [ ] story-0.1.0-001-1 打开页面能看到抽签按钮
- [ ] story-0.1.0-001-2 点击后显示一个菜名
`;
