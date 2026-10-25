import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApproval, listApprovals, settleViolations } from '../src/core/approvals.js';
import type { Violation } from '../src/core/guards.js';
import { headCommit } from '../src/core/git.js';
import { hookStatus, installPreCommitHook, renderHook } from '../src/core/hooks.js';
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
after(() => {
  for (const dir of dirs) cleanup(dir);
});

function repo(): string {
  const root = tempRepo('hooks');
  dirs.push(root);
  write(root, 'app.js', 'console.log("hi");\n');
  commitAll(root);
  return root;
}

function violation(guardId: string, file = 'db/update.sql', repo?: string): Violation {
  return {
    guardId,
    guardType: 'append-only',
    repo,
    file,
    action: '修改了已有行',
    fix: '恢复原内容并追加',
  };
}

describe('pre-commit hook', () => {
  it('安装、识别自身、备份外部 hook 并保留原内容', () => {
    const root = repo();
    const cliEntry = path.join(root, 'dist', 'cli.js');

    assert.equal(hookStatus(root), 'missing');
    const first = installPreCommitHook(root, cliEntry);
    assert.equal(first.status, 'installed');
    assert.equal(hookStatus(root), 'ours');
    const content = fs.readFileSync(first.file!, 'utf8');
    assert.match(content, /#!\/bin\/sh/);
    assert.match(content, /guard run --staged/);
    assert.ok(content.includes(`"${cliEntry.split('\\').join('/')}"`));

    assert.equal(installPreCommitHook(root, cliEntry).status, 'unchanged');

    const foreign = installPreCommitHook(root, '/elsewhere/cli.js');
    assert.equal(foreign.status, 'updated');
    assert.equal(foreign.backup, null);

    write(root, '.git/hooks/pre-commit', '#!/bin/sh\necho mine\n');
    const takeover = installPreCommitHook(root, cliEntry);
    assert.equal(takeover.status, 'installed');
    assert.ok(takeover.backup && fs.existsSync(takeover.backup));
    assert.match(fs.readFileSync(takeover.backup, 'utf8'), /echo mine/);
    assert.equal(hookStatus(root), 'ours');
  });

  it('renderHook 对 Windows 反斜杠路径使用正斜杠', () => {
    const line = renderHook('C:\\tools\\cli.js', 'C:\\repo\\proj');
    assert.match(line, /"C:\/tools\/cli\.js"/);
    assert.match(line, /"C:\/repo\/proj"/);
  });

  it('子仓 hook 固定 workspace 根并带 --staged-repo', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      const cliEntry = path.join(ws.root, 'dist', 'cli.js');
      const root = installPreCommitHook(ws.root, cliEntry);
      const rootContent = fs.readFileSync(root.file!, 'utf8');
      assert.match(rootContent, /guard run --staged\n/);
      assert.doesNotMatch(rootContent, /--staged-repo/);

      write(ws.api, '.git/hooks/pre-commit', '#!/bin/sh\necho mine\n');
      const child = installPreCommitHook(ws.api, cliEntry, {
        workspaceRoot: ws.root,
        stagedRepo: 'api',
      });
      assert.equal(child.status, 'installed');
      assert.ok(child.backup && fs.existsSync(child.backup));
      const childContent = fs.readFileSync(child.file!, 'utf8');
      assert.ok(childContent.includes(`--repo "${ws.root.split('\\').join('/')}"`));
      assert.match(childContent, /guard run --staged --staged-repo "api"/);
      assert.equal(hookStatus(ws.api), 'ours');
    } finally {
      cleanup(ws.root);
    }
  });
});

describe('守则审批', () => {
  it('审批只对本基线有效，提交后自动失效', () => {
    const root = repo();
    const baseline = headCommit(root);

    const approval = createApproval(root, 'sql-append-only', '紧急修复', 'tester');
    assert.equal(approval.baseline, baseline);
    assert.match(approval.file, /approvals\/.*sql-append-only\.json$/);

    const settled = settleViolations(root, [violation('sql-append-only'), violation('other-guard')]);
    assert.equal(settled.approved.length, 1);
    assert.equal(settled.blocking[0]?.guardId, 'other-guard');

    write(root, 'app.js', 'console.log("changed");\n');
    commitAll(root, 'next');
    assert.notEqual(headCommit(root), baseline);

    const expired = settleViolations(root, [violation('sql-append-only')]);
    assert.equal(expired.approved.length, 0);
    assert.equal(expired.blocking.length, 1);

    const listed = listApprovals(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.requester, 'tester');
  });

  it('无违规时 settle 不读取审批目录，损坏审批文件被忽略', () => {
    const root = repo();
    assert.deepEqual(settleViolations(root, []), { blocking: [], approved: [] });

    fs.mkdirSync(path.join(root, '.orca-team-orchestration', 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(root, '.orca-team-orchestration', 'approvals', 'broken.json'), '{not json');
    assert.deepEqual(listApprovals(root), []);
  });

  it('多仓审批按仓记录基线，子仓提交后只有该仓失效', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      const layout = workspaceLayout(ws.root, workspaceConfig());
      const approval = createApproval(ws.root, 'sql', '紧急修复', 'tester', layout);
      assert.deepEqual(approval.baselines, {
        workspace: headCommit(ws.root),
        api: headCommit(ws.api),
        web: headCommit(ws.web),
      });
      assert.equal(approval.baseline, headCommit(ws.root));

      const rootViolation = violation('sql', 'docs/a.sql', 'workspace');
      const apiViolation = violation('sql', 'api/db/update.sql', 'api');
      const settled = settleViolations(ws.root, [rootViolation, apiViolation], layout);
      assert.equal(settled.approved.length, 2);
      assert.equal(settled.blocking.length, 0);

      write(ws.api, 'README.md', '# api changed\n');
      commitAll(ws.api, 'next');
      const after = settleViolations(ws.root, [rootViolation, apiViolation], layout);
      assert.equal(after.approved.length, 1);
      assert.equal(after.approved[0]?.repo, 'workspace');
      assert.equal(after.blocking[0]?.repo, 'api');
    } finally {
      cleanup(ws.root);
    }
  });

  it('旧审批没有 baselines 时只对根仓违规生效', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    try {
      const layout = workspaceLayout(ws.root, workspaceConfig());
      const dir = path.join(ws.root, '.orca-team-orchestration', 'approvals');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'legacy.json'),
        JSON.stringify({
          guardId: 'legacy',
          reason: '旧审批',
          requester: 'tester',
          baseline: headCommit(ws.root),
          createdAt: new Date().toISOString(),
          file: '.orca-team-orchestration/approvals/legacy.json',
        }),
      );

      const settled = settleViolations(
        ws.root,
        [violation('legacy', 'docs/a.sql', 'workspace'), violation('legacy', 'api/db/update.sql', 'api')],
        layout,
      );
      assert.equal(settled.approved.length, 1);
      assert.equal(settled.approved[0]?.repo, 'workspace');
      assert.equal(settled.blocking[0]?.repo, 'api');
    } finally {
      cleanup(ws.root);
    }
  });
});
