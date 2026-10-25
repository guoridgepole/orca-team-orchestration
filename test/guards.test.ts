import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runGit } from '../src/core/git.js';
import { collectWorkspaceChanges, runGuards } from '../src/core/guards.js';
import type { GuardConfig } from '../src/core/config.js';
import { workspaceLayout } from '../src/core/workspace.js';
import {
  cleanup,
  commitAll,
  tempRepo,
  tempWorkspace,
  workspaceConfig,
  write,
} from './helpers.js';

const dirs: string[] = [];

function repoWith(files: Record<string, string>): string {
  const root = tempRepo('guards');
  dirs.push(root);
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  commitAll(root);
  return root;
}

function appendGuard(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return { id: 'sql', type: 'append-only', paths: ['db/update.sql'], ...overrides };
}

after(() => {
  for (const dir of dirs) cleanup(dir);
});

describe('append-only guard', () => {
  it('allows appending to the end', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    fs.appendFileSync(path.join(root, 'db/update.sql'), 'ALTER TABLE a ADD COLUMN b int;\n');

    assert.deepEqual(runGuards(root, [appendGuard()]), []);
  });

  it('rejects edits to existing lines', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    write(root, 'db/update.sql', 'CREATE TABLE a (id bigint);\n');

    const violations = runGuards(root, [appendGuard()]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.guardId, 'sql');
    assert.match(violations[0]?.action ?? '', /修改或删除了已有内容/);
  });

  it('rejects deleting the guarded file', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    fs.rmSync(path.join(root, 'db/update.sql'));

    const violations = runGuards(root, [appendGuard()]);
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.action ?? '', /删除或重命名/);
  });

  it('requires the appended block to start with the configured header', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    const guard = appendGuard({ require_header: '-- migration:' });

    fs.appendFileSync(path.join(root, 'db/update.sql'), 'ALTER TABLE a ADD COLUMN b int;\n');
    assert.equal(runGuards(root, [guard]).length, 1);

    write(root, 'db/update.sql', 'CREATE TABLE a (id int);\n\n-- migration: add b\nALTER TABLE a ADD COLUMN b int;\n');
    assert.equal(runGuards(root, [guard]).length, 0);
  });

  it('treats CRLF rewrites with no content change as an append', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    write(root, 'db/update.sql', 'CREATE TABLE a (id int);\r\nALTER TABLE a ADD COLUMN b int;\r\n');

    assert.deepEqual(runGuards(root, [appendGuard()]), []);
  });

  it('ignores files outside its scope', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n', 'src/app.ts': 'let a = 1;\n' });
    write(root, 'src/app.ts', 'let a = 2;\n');

    assert.deepEqual(runGuards(root, [appendGuard()]), []);
  });
});

describe('staged mode', () => {
  it('checks the index instead of the working tree', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    write(root, 'db/update.sql', 'CREATE TABLE a (id bigint);\n');
    runGit(root, ['add', 'db/update.sql']);

    assert.equal(runGuards(root, [appendGuard()], { staged: true }).length, 1);
  });

  it('passes when the staged content is a pure append', () => {
    const root = repoWith({ 'db/update.sql': 'CREATE TABLE a (id int);\n' });
    write(root, 'db/update.sql', 'CREATE TABLE a (id int);\nALTER TABLE a ADD COLUMN b int;\n');
    runGit(root, ['add', 'db/update.sql']);

    assert.deepEqual(runGuards(root, [appendGuard()], { staged: true }), []);
  });
});

describe('immutable guard', () => {
  it('rejects any modification', () => {
    const root = repoWith({ '.orca-team-orchestration/config.yaml': 'version: 1\n' });
    write(root, '.orca-team-orchestration/config.yaml', 'version: 2\n');
    const guard: GuardConfig = { id: 'config', type: 'immutable', paths: ['.orca-team-orchestration/config.yaml'] };

    const violations = runGuards(root, [guard]);
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.action ?? '', /修改了受保护文件/);
  });

  it('rejects new files unless allow_new is set', () => {
    const root = repoWith({ 'src/app.ts': 'export {};\n' });
    write(root, 'db/schema.sql', 'CREATE TABLE a (id int);\n');
    const guard: GuardConfig = { id: 'db', type: 'immutable', paths: ['db/**'] };

    assert.equal(runGuards(root, [guard]).length, 1);
    assert.equal(runGuards(root, [{ ...guard, allow_new: true }]).length, 0);
  });
});

describe('no-delete guard', () => {
  it('rejects removing lines from a matched file', () => {
    const root = repoWith({ 'src/list.ts': 'a\nb\nc\n' });
    write(root, 'src/list.ts', 'a\nc\n');
    const guard: GuardConfig = { id: 'nodelete', type: 'no-delete', paths: ['src/**'] };

    const violations = runGuards(root, [guard]);
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.action ?? '', /删除了 1 行/);
  });

  it('rejects deleting a matched file', () => {
    const root = repoWith({ 'src/legacy.ts': 'export {};\n' });
    fs.rmSync(path.join(root, 'src/legacy.ts'));
    const guard: GuardConfig = { id: 'nodelete', type: 'no-delete', paths: ['src/**'] };

    const violations = runGuards(root, [guard]);
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.action ?? '', /删除了文件/);
  });

  it('allows additions', () => {
    const root = repoWith({ 'src/list.ts': 'a\n' });
    write(root, 'src/list.ts', 'a\nb\n');
    const guard: GuardConfig = { id: 'nodelete', type: 'no-delete', paths: ['src/**'] };

    assert.deepEqual(runGuards(root, [guard]), []);
  });
});

describe('guard selection', () => {
  it('can run a subset of guards by id', () => {
    const root = repoWith({ 'db/update.sql': 'a\n', 'src/app.ts': 'b\n' });
    write(root, 'db/update.sql', 'x\n');
    write(root, 'src/app.ts', 'y\n');
    const guards: GuardConfig[] = [
      appendGuard(),
      { id: 'nodelete', type: 'no-delete', paths: ['src/**'] },
    ];

    assert.equal(runGuards(root, guards).length, 2);
    assert.equal(runGuards(root, guards, { ids: ['sql'] }).length, 1);
  });
});

describe('workspace guards', () => {
  it('把子仓改动映射为 workspace 相对路径，并过滤根仓里的子仓目录', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      write(ws.root, 'docs/plan.md', '# plan\n');
      write(ws.api, 'src/app.ts', 'export const a = 1;\n');
      const layout = workspaceLayout(ws.root, workspaceConfig());
      const changes = collectWorkspaceChanges(layout, false);

      const rootChange = changes.find((change) => change.path === 'docs/plan.md');
      assert.equal(rootChange?.repo, 'workspace');
      assert.equal(rootChange?.repoRoot, ws.root);
      assert.equal(rootChange?.relPath, 'docs/plan.md');

      const childChange = changes.find((change) => change.path === 'api/src/app.ts');
      assert.equal(childChange?.repo, 'api');
      assert.equal(childChange?.repoRoot, ws.api);
      assert.equal(childChange?.relPath, 'src/app.ts');
      assert.equal(childChange?.status, 'A');
      assert.equal(changes.some((change) => change.path === 'api' || change.path === 'web'), false);
    } finally {
      cleanup(ws.root);
    }
  });

  it('根仓 db/** 规则不会误伤子仓 api/db/**', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      write(ws.api, 'db/update.sql', 'CREATE TABLE a (id int);\n');
      commitAll(ws.api, 'sql');
      write(ws.api, 'db/update.sql', 'CREATE TABLE a (id bigint);\n');
      const layout = workspaceLayout(ws.root, workspaceConfig());

      assert.equal(runGuards(ws.root, [appendGuard()], { layout }).length, 0);

      const apiGuard = appendGuard({ id: 'api-sql', paths: ['api/db/update.sql'] });
      assert.equal(runGuards(ws.root, [apiGuard], { layout }).length, 1);
    } finally {
      cleanup(ws.root);
    }
  });

  it('--staged-repo 默认只查根仓，可指定子仓或 all', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      write(ws.root, 'db/update.sql', 'a\n');
      write(ws.api, 'db/update.sql', 'a\n');
      commitAll(ws.root, 'sql');
      commitAll(ws.api, 'sql');
      write(ws.root, 'db/update.sql', 'b\n');
      write(ws.api, 'db/update.sql', 'b\n');
      runGit(ws.root, ['add', 'db/update.sql']);
      runGit(ws.api, ['add', 'db/update.sql']);
      const layout = workspaceLayout(ws.root, workspaceConfig());
      const guards: GuardConfig[] = [
        appendGuard({ id: 'root-sql', paths: ['db/update.sql'] }),
        appendGuard({ id: 'api-sql', paths: ['api/db/update.sql'] }),
      ];

      assert.deepEqual(
        runGuards(ws.root, guards, { staged: true, layout }).map((item) => item.guardId),
        ['root-sql'],
      );
      assert.deepEqual(
        runGuards(ws.root, guards, { staged: true, layout, stagedRepo: 'api' }).map((item) => item.guardId),
        ['api-sql'],
      );
      assert.deepEqual(
        runGuards(ws.root, guards, { staged: true, layout, stagedRepo: 'all' })
          .map((item) => item.guardId)
          .sort(),
        ['api-sql', 'root-sql'],
      );
    } finally {
      cleanup(ws.root);
    }
  });

  it('识别子仓重命名', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      write(ws.api, 'db/update.sql', 'a\n');
      commitAll(ws.api, 'sql');
      runGit(ws.api, ['mv', 'db/update.sql', 'db/update2.sql']);
      const layout = workspaceLayout(ws.root, workspaceConfig());
      const changes = collectWorkspaceChanges(layout, true, ['api']);
      const renamed = changes.find((change) => change.path === 'api/db/update2.sql');
      assert.equal(renamed?.status, 'R');
      assert.equal(renamed?.oldPath, 'api/db/update.sql');
      assert.equal(renamed?.oldRelPath, 'db/update.sql');

      const guard = appendGuard({ id: 'api-sql', paths: ['api/db/**'] });
      assert.equal(runGuards(ws.root, [guard], { staged: true, layout, stagedRepo: 'api' }).length, 1);
    } finally {
      cleanup(ws.root);
    }
  });

  it('无 HEAD 的子仓在 staged 与非 staged 模式下都能收集改动', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      const extra = path.join(ws.root, 'extra');
      fs.mkdirSync(extra, { recursive: true });
      runGit(extra, ['init', '-q']);
      write(extra, 'db/update.sql', 'a\n');
      const config = workspaceConfig({ project: { repos: [{ name: 'extra', path: 'extra' }] } });
      const layout = workspaceLayout(ws.root, config);

      const unstaged = collectWorkspaceChanges(layout, false);
      assert.equal(unstaged.find((change) => change.path === 'extra/db/update.sql')?.status, 'A');

      runGit(extra, ['add', '-A']);
      const staged = collectWorkspaceChanges(layout, true, ['extra']);
      assert.equal(staged.length, 1);
      assert.equal(staged[0]?.path, 'extra/db/update.sql');
      assert.equal(staged[0]?.repo, 'extra');
    } finally {
      cleanup(ws.root);
    }
  });
});
