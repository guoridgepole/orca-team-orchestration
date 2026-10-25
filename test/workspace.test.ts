import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { builtinDefaults } from '../src/core/config.js';
import { runGit } from '../src/core/git.js';
import {
  ROOT_REPO_NAME,
  discoverRepos,
  findWorkspaceRoot,
  repoByName,
  validateWorkspace,
  workspaceLayout,
  workspacePath,
} from '../src/core/workspace.js';
import { cleanup, tempRepo, tempWorkspace, workspaceConfig } from './helpers.js';

test('workspaceLayout 把根仓放在最前并解析绝对路径', () => {
  const layout = workspaceLayout('/tmp/ws', workspaceConfig());
  assert.equal(layout.root, '/tmp/ws');
  assert.deepEqual(
    layout.all.map((repo) => repo.name),
    [ROOT_REPO_NAME, 'api', 'web'],
  );
  assert.equal(layout.all[0]?.path, '.');
  assert.equal(layout.repos[0]?.root, path.resolve('/tmp/ws', 'api'));
});

test('workspacePath 生成 workspace 相对路径', () => {
  const layout = workspaceLayout('/tmp/ws', workspaceConfig());
  const root = repoByName(layout, 'workspace');
  const api = repoByName(layout, 'api');
  assert.equal(workspacePath(layout, root, 'docs/a.md'), 'docs/a.md');
  assert.equal(workspacePath(layout, api, 'src/a.ts'), 'api/src/a.ts');
  assert.equal(workspacePath(layout, api, ''), 'api');
  assert.throws(() => repoByName(layout, 'missing'), /未知关联仓库/);
});

test('discoverRepos 只返回含 .git 的一级目录', () => {
  const { root } = tempWorkspace();
  try {
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hidden', '.git'), '');
    assert.deepEqual(discoverRepos(root), ['api', 'web']);
  } finally {
    cleanup(root);
  }
});

test('validateWorkspace 接受合法的 workspace 与子仓', () => {
  const { root } = tempWorkspace();
  try {
    const layout = validateWorkspace(root, workspaceConfig());
    assert.equal(layout.repos.length, 2);
  } finally {
    cleanup(root);
  }
});

test('validateWorkspace 拒绝非 git 根', () => {
  const { root } = tempWorkspace({ gitRoot: false });
  try {
    assert.throws(() => validateWorkspace(root, workspaceConfig()), /不是 git 仓库顶层/);
  } finally {
    cleanup(root);
  }
});

test('validateWorkspace 拒绝位于其他仓库内部的根', () => {
  const outer = tempRepo('outer');
  try {
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner);
    assert.throws(() => validateWorkspace(inner, workspaceConfig()), /不是 git 仓库顶层/);
  } finally {
    cleanup(outer);
  }
});

test('validateWorkspace 拒绝缺失或非目录的子仓', () => {
  const { root } = tempWorkspace();
  try {
    const config = workspaceConfig();
    fs.rmSync(path.join(root, 'web'), { recursive: true, force: true });
    assert.throws(() => validateWorkspace(root, config), /关联仓库不存在：web/);
    fs.writeFileSync(path.join(root, 'api2'), 'file');
    const config2 = workspaceConfig({
      project: { repos: [{ name: 'api2', path: 'api2' }] },
    });
    assert.throws(() => validateWorkspace(root, config2), /不是目录/);
  } finally {
    cleanup(root);
  }
});

test('validateWorkspace 拒绝符号链接形式的子仓', () => {
  const { root } = tempWorkspace();
  const outside = tempRepo('outside');
  try {
    fs.renameSync(path.join(root, 'api'), path.join(root, 'api-real'));
    fs.symlinkSync(outside, path.join(root, 'api'), 'dir');
    assert.throws(() => validateWorkspace(root, workspaceConfig()), /符号链接/);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('validateWorkspace 拒绝 .git 文件的 worktree/submodule', () => {
  const { root } = tempWorkspace();
  try {
    fs.rmSync(path.join(root, 'api', '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'api', '.git'), 'gitdir: ../.git/modules/api\n');
    assert.throws(() => validateWorkspace(root, workspaceConfig()), /worktree\/submodule/);
  } finally {
    cleanup(root);
  }
});

test('validateWorkspace 拒绝被根仓跟踪的子仓', () => {
  const { root } = tempWorkspace();
  try {
    runGit(root, ['add', 'api']);
    assert.throws(() => validateWorkspace(root, workspaceConfig()), /被 workspace 根跟踪/);
  } finally {
    cleanup(root);
  }
});

test('findWorkspaceRoot 从子仓或其子目录向上解析 workspace', () => {
  const { root, api } = tempWorkspace();
  try {
    fs.mkdirSync(path.join(root, '.orca-team-orchestration'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.orca-team-orchestration', 'config.yaml'),
      'version: 1\nproject:\n  repos:\n    - name: api\n      path: api\n',
      'utf8',
    );
    assert.equal(findWorkspaceRoot(api), root);
    const nested = path.join(api, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findWorkspaceRoot(nested), root);
  } finally {
    cleanup(root);
  }
});

test('findWorkspaceRoot 没有 workspace 配置时返回 null', () => {
  const repo = tempRepo();
  try {
    assert.equal(findWorkspaceRoot(repo), null);
  } finally {
    cleanup(repo);
  }
});

test('单仓配置不产生额外关联仓库', () => {
  const layout = workspaceLayout('/tmp/ws', builtinDefaults('demo'));
  assert.deepEqual(layout.repos, []);
  assert.equal(layout.all.length, 1);
});
