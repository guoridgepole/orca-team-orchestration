import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { EXIT } from '../src/core/errors.js';
import { runGit } from '../src/core/git.js';
import { findExecutable } from '../src/core/orca.js';
import { cleanup, commitAll, tempRepo, tempWorkspace, write, VALID_STORY } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
const dirs: string[] = [];
const supportDirs: string[] = [];

function fakeExecutable(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orca-team-orchestration-bin-${name}-`));
  supportDirs.push(dir);
  if (process.platform === 'win32') {
    write(dir, `${name}.CMD`, '@exit /b 0\r\n');
  } else {
    write(dir, name, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

const fakeOrcaDir = fakeExecutable('orca-ide');
const fakeAgentDirs = [fakeExecutable('claude'), fakeExecutable('codex')];
const defaultPath = [...fakeAgentDirs, fakeOrcaDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);

function repo(): string {
  const root = tempRepo('cli');
  dirs.push(root);
  write(root, 'package.json', JSON.stringify({ scripts: { dev: 'node app.js', test: 'node --test' } }));
  write(root, 'app.js', 'console.log("hi");\n');
  commitAll(root);
  return root;
}

function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_TEAM_ORCHESTRATION_REPO: '',
      PATH: defaultPath,
      ...env,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

after(() => {
  for (const dir of dirs) cleanup(dir);
  for (const dir of supportDirs) cleanup(dir);
});

describe('init → new → lint → start → status', () => {
  const root = repo();

  it('requires Orca before writing any project files', () => {
    const withoutOrca = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-orchestration-no-orca-'));
    supportDirs.push(withoutOrca);
    const missing = cli(root, ['--repo', root, 'init'], { PATH: withoutOrca });

    assert.equal(missing.code, EXIT.orchestrator, missing.stderr);
    assert.match(missing.stderr, /必须依赖 Orca/);
    assert.match(missing.stderr, /安装 Orca/);
    assert.match(missing.stderr, /orca-ide --version/);
    assert.equal(fs.existsSync(path.join(root, '.orca-team-orchestration/config.yaml')), false);
  });

  it('initializes a git repo and refuses to overwrite without --force', () => {
    const first = cli(root, ['init']);
    assert.equal(first.code, EXIT.ok, first.stderr);
    assert.ok(fs.existsSync(path.join(root, '.orca-team-orchestration/config.yaml')));
    assert.ok(fs.existsSync(path.join(root, 'features')));
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.orca-team-orchestration\/runs\//);
    assert.match(
      fs.readFileSync(path.join(root, '.orca-team-orchestration/config.yaml'), 'utf8'),
      /orchestrator: orca/,
    );

    const second = cli(root, ['init']);
    assert.equal(second.code, EXIT.config);
    assert.match(second.stderr, /已存在/);
  });

  it('updates project commands in place', () => {
    const result = cli(root, ['config', '--base-url', 'http://127.0.0.1:5173/']);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /5173/);
    assert.match(fs.readFileSync(path.join(root, '.orca-team-orchestration/config.yaml'), 'utf8'), /5173/);
  });

  it('creates a story skeleton that fails lint until it is filled in', () => {
    const created = cli(root, ['new', 'story-001', '--title', '午餐抽签']);
    assert.equal(created.code, EXIT.ok, created.stderr);
    assert.ok(fs.existsSync(path.join(root, 'features/story-001.md')));

    const lint = cli(root, ['lint', 'story-001']);
    assert.equal(lint.code, EXIT.config);
    assert.match(lint.stdout, /第 \d+ 行/);
  });

  it('lints a filled story and lists it as 未开始', () => {
    write(root, 'features/story-001.md', VALID_STORY);

    assert.equal(cli(root, ['lint', 'story-001']).code, EXIT.ok);

    const listed = cli(root, ['list', '--json']);
    assert.equal(listed.code, EXIT.ok, listed.stderr);
    const rows = JSON.parse(listed.stdout) as Array<{ id: string; status: string; features: number }>;
    assert.equal(rows[0]?.id, 'story-001');
    assert.equal(rows[0]?.status, '未开始');
    assert.equal(rows[0]?.features, 2);
  });

  it('does not persist a run on --dry-run', () => {
    const dry = cli(root, ['start', 'story-001', '--dry-run', '--orchestrator', 'orca']);
    assert.equal(dry.code, EXIT.ok, dry.stderr);
    assert.match(dry.stdout, /DRY-RUN/);
    assert.equal(fs.existsSync(path.join(root, '.orca-team-orchestration/runs/story-001.json')), false);
  });

  it('requires Orca in auto mode instead of falling back', () => {
    const withoutOrca = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-orchestration-no-orca-auto-'));
    supportDirs.push(withoutOrca);
    const result = cli(
      root,
      ['--repo', root, 'start', 'story-001', '--dry-run', '--orchestrator', 'auto'],
      { PATH: withoutOrca },
    );

    assert.equal(result.code, EXIT.orchestrator, result.stderr);
    assert.match(result.stderr, /必须依赖 Orca/);
    assert.equal(fs.existsSync(path.join(root, '.orca-team-orchestration/runs/story-001.json')), false);
  });

  it('rejects the unsupported sequential orchestrator', () => {
    const result = cli(root, ['start', 'story-001', '--dry-run', '--orchestrator', 'sequential']);

    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /必须依赖 Orca/);
  });

  it('start 在 agent 命令缺失时以退出码 5 失败', () => {
    // 只保留 fake orca-ide 与 git 所在目录，确定性模拟“本机未安装 claude/codex”
    const git = findExecutable('git');
    const noAgentPath = [fakeOrcaDir, ...(git ? [path.dirname(git)] : [])].join(path.delimiter);
    const result = cli(root, ['start', 'story-001', '--orchestrator', 'orca'], { PATH: noAgentPath });
    assert.equal(result.code, EXIT.agent, result.stderr);
    assert.match(result.stderr, /未检测到 agent 命令 claude/);
    assert.equal(fs.existsSync(path.join(root, '.orca-team-orchestration/runs/story-001.json')), false);
  });

  it('start 打开 run 后因 fake orchestrator 无法解析 run id 而退出 4', () => {
    const started = cli(root, ['start', 'story-001', '--orchestrator', 'orca']);
    assert.equal(started.code, EXIT.orchestrator, started.stderr);
    assert.ok(fs.existsSync(path.join(root, '.orca-team-orchestration/runs/story-001.json')));
    assert.ok(fs.existsSync(path.join(root, '.orca-team-orchestration/runs/story-001/spec.md')));
  });

  it('reports stage, next step and snapshot drift', () => {
    const status = cli(root, ['status', 'story-001', '--json']);
    assert.equal(status.code, EXIT.ok, status.stderr);
    const payload = JSON.parse(status.stdout) as { status: string; next: string; specChanged: boolean };
    assert.equal(payload.status, '进行中');
    assert.equal(payload.next, 'design');
    assert.equal(payload.specChanged, false);

    fs.appendFileSync(path.join(root, 'features/story-001.md'), '\n补充说明\n');
    const drifted = cli(root, ['status', 'story-001', '--json']);
    assert.equal((JSON.parse(drifted.stdout) as { specChanged: boolean }).specChanged, true);
  });

  it('passes the design stage check only when the artifact is complete', () => {
    write(root, 'features/story-001.md', VALID_STORY);
    commitAll(root, 'story: filled');

    const missing = cli(root, ['check', 'design', 'story-001']);
    assert.equal(missing.code, EXIT.validation);
    assert.match(missing.stdout, /ARTIFACT FAIL/);

    write(
      root,
      'docs/design/story-001-r1.md',
      '# 目标\n\n## 目标\n\n抽签。\n\n## 验收映射\n\n- story-001-1\n- story-001-2\n\n## 数据库变更\n\n无。\n\n## 失败路径\n\n无菜可选。\n\n## 回滚\n\n删除页面。\n',
    );
    const passed = cli(root, ['check', 'design', 'story-001']);
    assert.equal(passed.code, EXIT.ok, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /STAGE-CHECK: PASS/);
  });

  it('renders a full role prompt as text or JSON', () => {
    const text = cli(root, ['render', 'designer', 'story-001', '--round', '2']);
    assert.equal(text.code, EXIT.ok, text.stderr);
    assert.match(text.stdout, /oto prompt v1 role=designer stage=design round=2/);
    assert.match(text.stdout, /## 需求数据/);
    assert.match(text.stdout, /docs\/design\/story-001-r2\.md/);

    const json = cli(root, ['render', 'designer', 'story-001', '--round', '2', '--json']);
    assert.equal(json.code, EXIT.ok, json.stderr);
    const payload = JSON.parse(json.stdout) as {
      role: string;
      stage: string;
      round: number;
      locale: string;
      prompt: string;
      warnings: string[];
    };
    assert.equal(payload.role, 'designer');
    assert.equal(payload.stage, 'design');
    assert.equal(payload.round, 2);
    assert.equal(payload.locale, 'zh-CN');
    assert.ok(Array.isArray(payload.warnings));
    assert.match(payload.prompt, /## 本次任务/);
  });

  it('renders a previous report from --previous', () => {
    write(root, 'docs/review/story-001-r1.md', '上一轮发现：缺少失败路径。\n');
    const result = cli(root, [
      'render',
      'reviewer',
      'story-001',
      '--round',
      '2',
      '--previous',
      'docs/review/story-001-r1.md',
    ]);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /上一轮报告/);
    assert.match(result.stdout, /缺少失败路径/);
  });

  it('rejects unknown roles and missing stories', () => {
    const unknown = cli(root, ['render', 'nope', 'story-001']);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.stderr, /未知角色/);

    const missing = cli(root, ['render', 'designer', 'missing-001']);
    assert.equal(missing.code, EXIT.usage);
    assert.match(missing.stderr, /不存在/);
  });
});

describe('guards through the CLI', () => {
  it('rejects edits to an append-only SQL file with exit 6', () => {
    const root = tempRepo('cli-guard');
    dirs.push(root);
    write(root, 'package.json', JSON.stringify({ scripts: { dev: 'node app.js', test: 'node --test' } }));
    write(root, 'db/update.sql', 'CREATE TABLE a (id int);\n');
    commitAll(root);

    assert.equal(cli(root, ['init']).code, EXIT.ok);

    fs.appendFileSync(path.join(root, 'db/update.sql'), '-- migration: add b\nALTER TABLE a ADD COLUMN b int;\n');
    assert.equal(cli(root, ['guard', 'run']).code, EXIT.ok);

    write(root, 'db/update.sql', 'DROP TABLE a;\n');
    const failed = cli(root, ['guard', 'run']);
    assert.equal(failed.code, EXIT.guard);
    assert.match(failed.stdout, /sql-append-only/);
  });
});

describe('usage and argument errors', () => {
  it('rejects unknown commands with exit 2', () => {
    const root = repo();
    const result = cli(root, ['nope']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /未知命令/);
  });

  it('requires a story id for start in a non-interactive shell', () => {
    const root = repo();
    assert.equal(cli(root, ['init']).code, EXIT.ok);
    const result = cli(root, ['start', '--orchestrator', 'orca']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /显式指定 story/);
  });
});

describe('resume 与 accept', () => {
  const stateFile = (root: string): string =>
    path.join(root, '.orca-team-orchestration', 'runs', 'story-001.json');

  function startedRepo(): string {
    const root = repo();
    assert.equal(cli(root, ['init']).code, EXIT.ok);
    write(root, 'features/story-001.md', VALID_STORY);
    commitAll(root, 'story: filled');
    const start = cli(root, ['start', 'story-001', '--orchestrator', 'orca']);
    assert.equal(start.code, EXIT.orchestrator, start.stderr);
    return root;
  }

  function markAllPassed(root: string): void {
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
      stages: Record<string, { round: number; status: string }>;
    };
    for (const stage of ['design', 'review', 'develop', 'test']) {
      state.stages[stage] = { round: 1, status: 'passed' };
    }
    fs.writeFileSync(stateFile(root), `${JSON.stringify(state, null, 2)}\n`);
  }

  it('resume 在需求漂移时要求 --refresh-spec', () => {
    const root = startedRepo();
    const drifted = VALID_STORY.replace('- 明确不做:', '- 背景补充: 漂移说明\n- 明确不做:');
    write(root, 'features/story-001.md', drifted);

    const blocked = cli(root, ['resume', 'story-001']);
    assert.equal(blocked.code, EXIT.config, blocked.stderr);
    assert.match(blocked.stderr, /--refresh-spec/);

    const refreshed = cli(root, ['resume', 'story-001', '--refresh-spec']);
    assert.equal(refreshed.code, EXIT.orchestrator, refreshed.stderr);

    const status = cli(root, ['status', 'story-001', '--json']);
    assert.equal((JSON.parse(status.stdout) as { specChanged: boolean }).specChanged, false);
  });

  it('accept 记录验收文档、更新状态并可重复执行', () => {
    const root = startedRepo();
    markAllPassed(root);

    const accepted = cli(root, ['accept', 'story-001']);
    assert.equal(accepted.code, EXIT.ok, accepted.stderr);
    assert.ok(fs.existsSync(path.join(root, 'docs/test/story-001-accept.md')));
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as { acceptedAt?: string };
    assert.ok(state.acceptedAt, 'accept 应写入 acceptedAt');

    const again = cli(root, ['accept', 'story-001']);
    assert.equal(again.code, EXIT.ok, again.stderr);
    assert.match(again.stdout, /已.*验收/);
  });

  it('accept 在阶段未完成时拒绝', () => {
    const root = startedRepo();
    const result = cli(root, ['accept', 'story-001']);
    assert.equal(result.code, EXIT.validation, result.stderr);
    assert.match(result.stderr, /尚未完成所有阶段/);
  });
});

describe('pre-commit hook 与审批（端到端）', () => {
  it('违规提交被 hook 拦截，审批放行后新基线再次拦截', () => {
    const root = tempRepo('cli-hook');
    dirs.push(root);
    write(root, 'package.json', JSON.stringify({ scripts: { dev: 'node app.js', test: 'node --test' } }));
    write(root, 'db/update.sql', 'CREATE TABLE a (id int);\n');
    commitAll(root);

    const initialized = cli(root, ['init']);
    assert.equal(initialized.code, EXIT.ok, initialized.stderr);
    assert.match(initialized.stdout, /pre-commit installed|pre-commit 已安装|hook/);
    const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
    assert.ok(fs.existsSync(hookFile));
    assert.match(fs.readFileSync(hookFile, 'utf8'), /guard run --staged/);

    write(root, 'db/update.sql', 'DROP TABLE a;\n');
    runGit(root, ['add', '--', 'db/update.sql']);
    const blocked = runGit(root, ['commit', '-m', 'bad']);
    assert.equal(blocked.ok, false, `${blocked.stdout}\n${blocked.stderr}`);
    assert.match(blocked.stdout + blocked.stderr, /sql-append-only/);
    assert.match(blocked.stdout + blocked.stderr, /guard allow/);

    assert.equal(cli(root, ['guard', 'allow', 'sql-append-only', '--reason', '重构', '--by', 'tester']).code, EXIT.ok);
    assert.equal(cli(root, ['guard', 'allow', 'no-delete-schema', '--reason', '重构', '--by', 'tester']).code, EXIT.ok);
    const approved = runGit(root, ['commit', '-m', 'ok']);
    assert.equal(approved.ok, true, `${approved.stdout}\n${approved.stderr}`);

    const listed = cli(root, ['guard', 'approvals', '--json']);
    assert.equal(listed.code, EXIT.ok);
    assert.equal((JSON.parse(listed.stdout) as unknown[]).length, 2);

    write(root, 'db/update.sql', 'TRUNCATE TABLE a;\n');
    runGit(root, ['add', '--', 'db/update.sql']);
    const expired = runGit(root, ['commit', '-m', 'again']);
    assert.equal(expired.ok, false, '审批应随新基线失效');
  });
});

describe('explain', () => {
  it('解释未开始、进行中缺产物与待验收', () => {
    const root = tempRepo('cli-explain');
    dirs.push(root);
    write(root, 'package.json', JSON.stringify({ scripts: { dev: 'node app.js', test: 'node --test' } }));
    commitAll(root, 'baseline');
    assert.equal(cli(root, ['init']).code, EXIT.ok);
    write(root, 'features/story-001.md', VALID_STORY);
    commitAll(root, 'story: filled');

    const notStarted = cli(root, ['explain', 'story-001', '--json']);
    assert.equal(notStarted.code, EXIT.ok, notStarted.stderr);
    const before = JSON.parse(notStarted.stdout) as { next: string; status: string; actions: string[] };
    assert.equal(before.next, 'start');
    assert.equal(before.status, '未开始');
    assert.ok(before.actions.some((line) => line.includes('lint')));

    assert.equal(cli(root, ['start', 'story-001', '--orchestrator', 'orca']).code, EXIT.orchestrator);
    const running = cli(root, ['explain', 'story-001', '--json']);
    const mid = JSON.parse(running.stdout) as { next: string; round: number; reasons: string[] };
    assert.equal(mid.next, 'design');
    assert.equal(mid.round, 1);
    assert.match(mid.reasons.join('\n'), /docs\/design\/story-001-r1\.md/);

    const stateFile = path.join(root, '.orca-team-orchestration', 'runs', 'story-001.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      stages: Record<string, { round: number; status: string }>;
    };
    for (const stage of ['design', 'review', 'develop', 'test']) {
      state.stages[stage] = { round: 1, status: 'passed' };
    }
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const pendingAccept = cli(root, ['explain', 'story-001']);
    assert.equal(pendingAccept.code, EXIT.ok, pendingAccept.stderr);
    assert.match(pendingAccept.stdout, /下一步：accept/);
    assert.match(pendingAccept.stdout, /accept story-001/);
  });
});

describe('init --workspace', () => {
  it('在非 git 父目录自动建仓，写配置/ignore、初始提交并安装双仓 hook', () => {
    const ws = tempWorkspace({ gitRoot: false });
    dirs.push(ws.root);

    const result = cli(ws.root, ['init', '--workspace']);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /关联仓库 api（api\/）、web（web\/）/);

    const config = fs.readFileSync(path.join(ws.root, '.orca-team-orchestration/config.yaml'), 'utf8');
    assert.match(config, /repos:/);
    assert.match(config, /name: api/);
    assert.match(config, /path: api/);
    assert.match(config, /worktree: path:\./);

    const ignore = fs.readFileSync(path.join(ws.root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\/api\/$/m);
    assert.match(ignore, /^\/web\/$/m);
    assert.match(ignore, /^\.orca-team-orchestration\/runs\/$/m);

    const head = runGit(ws.root, ['rev-parse', '--verify', 'HEAD']);
    assert.equal(head.ok, true);
    assert.match(runGit(ws.root, ['log', '--format=%s']).stdout, /workspace init/);
    const committed = runGit(ws.root, ['show', '--name-only', '--format=', 'HEAD'])
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(committed, ['.gitignore', '.orca-team-orchestration/config.yaml']);

    const rootHook = fs.readFileSync(path.join(ws.root, '.git/hooks/pre-commit'), 'utf8');
    assert.doesNotMatch(rootHook, /--staged-repo/);
    const apiHook = fs.readFileSync(path.join(ws.api, '.git/hooks/pre-commit'), 'utf8');
    assert.ok(apiHook.includes(`--repo "${ws.root.split('\\').join('/')}"`));
    assert.match(apiHook, /guard run --staged --staged-repo "api"/);

    const second = cli(ws.root, ['init', '--workspace']);
    assert.equal(second.code, EXIT.config);
    assert.match(second.stderr, /已存在/);
  });

  it('--force 只替换 managed ignore block，保留其他行', () => {
    const ws = tempWorkspace({ gitRoot: false });
    dirs.push(ws.root);
    assert.equal(cli(ws.root, ['init', '--workspace']).code, EXIT.ok);

    const ignoreFile = path.join(ws.root, '.gitignore');
    fs.appendFileSync(ignoreFile, '# keep me\n');
    const forced = cli(ws.root, ['init', '--workspace', '--force']);
    assert.equal(forced.code, EXIT.ok, forced.stderr);

    const ignore = fs.readFileSync(ignoreFile, 'utf8');
    assert.match(ignore, /# keep me/);
    assert.equal((ignore.match(/orca-team-orchestration managed >>>/g) ?? []).length, 1);
    assert.equal((ignore.match(/^\/api\/$/gm) ?? []).length, 1);
  });

  it('--repos 覆盖自动发现，--no-commit 跳过初始提交', () => {
    const ws = tempWorkspace({ gitRoot: false });
    dirs.push(ws.root);

    const result = cli(ws.root, ['init', '--workspace', '--repos', 'web', '--no-commit']);
    assert.equal(result.code, EXIT.ok, result.stderr);
    const config = fs.readFileSync(path.join(ws.root, '.orca-team-orchestration/config.yaml'), 'utf8');
    assert.match(config, /name: web/);
    assert.doesNotMatch(config, /name: api/);
    assert.equal(runGit(ws.root, ['rev-parse', '--verify', 'HEAD']).ok, false);
  });

  it('拒绝已被根仓跟踪的子仓并给出索引修复提示', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    runGit(ws.root, ['add', 'api']);

    const result = cli(ws.root, ['init', '--workspace']);
    assert.equal(result.code, EXIT.config);
    assert.match(result.stderr, /被 workspace 根跟踪/);
    assert.match(result.stderr, /git rm -r --cached api/);
  });

  it('在关联仓库内执行时自动解析到 workspace 根', () => {
    const ws = tempWorkspace({ gitRoot: false });
    dirs.push(ws.root);
    assert.equal(cli(ws.root, ['init', '--workspace']).code, EXIT.ok);
    write(ws.root, 'features/story-001.md', VALID_STORY);

    const listed = cli(ws.api, ['list', '--json']);
    assert.equal(listed.code, EXIT.ok, listed.stderr);
    const rows = JSON.parse(listed.stdout) as Array<{ id: string }>;
    assert.equal(rows[0]?.id, 'story-001');
  });

  it('doctor 报告 workspace、关联仓库、ignore 与 worktree', () => {
    const ws = tempWorkspace({ gitRoot: false });
    dirs.push(ws.root);
    assert.equal(cli(ws.root, ['init', '--workspace']).code, EXIT.ok);

    const result = cli(ws.root, ['doctor', '--json']);
    assert.equal(result.code, EXIT.ok, result.stderr + result.stdout);
    const items = JSON.parse(result.stdout) as Array<{ name: string; status: string; detail: string }>;
    const find = (name: string) => items.find((item) => item.name === name);
    assert.equal(find('workspace')?.status, 'OK');
    assert.equal(find('repo api')?.status, 'OK');
    assert.equal(find('repo web')?.status, 'OK');
    assert.equal(find('workspace ignore')?.status, 'OK');
    assert.match(find('worktree')?.detail ?? '', /path:\./);
  });
});

describe('workspace guards through the CLI', () => {
  it('--staged 默认只查根仓，--staged-repo 选中子仓，审批按仓放行', () => {
    const ws = tempWorkspace();
    dirs.push(ws.root);
    write(ws.api, 'db/update.sql', 'CREATE TABLE a (id int);\n');
    commitAll(ws.api, 'db: init');

    const initialized = cli(ws.root, ['init', '--workspace']);
    assert.equal(initialized.code, EXIT.ok, initialized.stderr);
    assert.match(
      fs.readFileSync(path.join(ws.root, '.orca-team-orchestration/config.yaml'), 'utf8'),
      /sql-append-only-api/,
    );

    write(ws.api, 'db/update.sql', 'DROP TABLE a;\n');
    runGit(ws.api, ['add', '--', 'db/update.sql']);

    const rootOnly = cli(ws.root, ['guard', 'run', '--staged']);
    assert.equal(rootOnly.code, EXIT.ok, rootOnly.stdout);

    const failed = cli(ws.root, ['guard', 'run', '--staged', '--staged-repo', 'api']);
    assert.equal(failed.code, EXIT.guard, failed.stdout);
    assert.match(failed.stdout, /api\/db\/update\.sql/);

    const withoutStaged = cli(ws.root, ['guard', 'run', '--staged-repo', 'api']);
    assert.equal(withoutStaged.code, EXIT.usage);
    assert.match(withoutStaged.stderr, /--staged/);

    for (const guardId of ['sql-append-only-api', 'no-delete-schema-api']) {
      const allowed = cli(ws.root, ['guard', 'allow', guardId, '--reason', '迁移', '--by', 'tester']);
      assert.equal(allowed.code, EXIT.ok, allowed.stderr);
      assert.match(allowed.stdout, /workspace@/);
      assert.match(allowed.stdout, /api@/);
    }

    const approved = cli(ws.root, ['guard', 'run', '--staged', '--staged-repo', 'api']);
    assert.equal(approved.code, EXIT.ok, approved.stdout);
    assert.match(approved.stdout, /APPROVED/);

    const listed = cli(ws.root, ['guard', 'approvals']);
    assert.equal(listed.code, EXIT.ok, listed.stderr);
    assert.match(listed.stdout, /workspace@/);
    assert.match(listed.stdout, /api@/);
  });
});

describe('ui command', () => {
  it('starts the console for the current project without specifying a repo', async () => {
    const root = repo();
    write(
      root,
      '.orca-team-orchestration/config.yaml',
      `version: 1
project:
  name: ui-demo
  commands:
    start: npm run dev
    test: npm test
    base_url: http://127.0.0.1:5173/
runtime:
  max_rounds:
    design_review: 3
    dev_test: 3
`,
    );
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-orchestration-ui-xdg-'));
    supportDirs.push(xdg);

    const child = spawn(process.execPath, [CLI, 'ui', '--port', '0'], {
      cwd: root,
      env: {
        ...process.env,
        ORCA_TEAM_ORCHESTRATION_REPO: '',
        XDG_CONFIG_HOME: xdg,
        PATH: defaultPath,
      },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`ui 启动超时：${output}`)), 5_000);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match = /ORCA_TEAM_ORCHESTRATION_READY (http:\/\/\S+)/.exec(output);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`ui 提前退出（${code}）：${output}`));
        });
      });

      const status = (await (await fetch(new URL('/api/status', url))).json()) as {
        projectRoot: string;
        projectName: string;
        configFound: boolean;
      };
      assert.equal(status.projectRoot, root);
      assert.equal(status.projectName, 'ui-demo');
      assert.equal(status.configFound, true);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
    }
  });
});
