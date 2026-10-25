import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builtinDefaults,
  mergeConfig,
  validateConfig,
  validateRoleName,
  type Config,
} from '../src/core/config.js';

function defaults(): Record<string, unknown> {
  return builtinDefaults('demo') as unknown as Record<string, unknown>;
}

test('内置默认配置通过校验', () => {
  const config = validateConfig(defaults());
  assert.equal(config.version, 1);
  assert.equal(config.runtime.orchestrator, 'orca');
  assert.equal(config.runtime.max_rounds.design_review, 3);
  assert.equal(Object.keys(config.roles).length, 4);
});

test('agents 接受 qoder 与 codebuddy，拒绝已移除的 kind 与 command 字段', () => {
  for (const kind of ['qoder', 'codebuddy']) {
    const merged = mergeConfig(defaults(), {
      agents: { extra: { kind } },
      roles: {
        designer: {
          agent: 'extra',
          writes: ['docs/design/'],
          artifact: { path: 'docs/design/{{story}}.md' },
        },
      },
      flow: { design: 'designer', review: null, develop: 'designer', test: null, accept: 'coordinator' },
    });
    const config = validateConfig(merged);
    assert.equal(config.agents.extra.kind, kind);
  }
  for (const kind of ['cursor', 'antigravity', 'muse', 'custom']) {
    const merged = mergeConfig(defaults(), { agents: { extra: { kind } } });
    assert.throws(() => validateConfig(merged), new RegExp('kind 不支持：' + kind));
  }
  const withCommand = mergeConfig(defaults(), {
    agents: { extra: { kind: 'qoder', command: 'qodercli' } },
  });
  assert.throws(() => validateConfig(withCommand), /command 是未知字段/);
});


test('项目可以整体替换 roles 与 flow', () => {
  const merged = mergeConfig(defaults(), {
    roles: {
      solo: {
        agent: 'claude-main',
        writes: ['docs/design/'],
        artifact: { path: 'docs/design/{{story}}-r{{round}}.md' },
      },
    },
    flow: { design: 'solo', review: null, develop: 'solo', test: null, accept: 'coordinator' },
  });
  const config = validateConfig(merged);
  assert.deepEqual(Object.keys(config.roles), ['solo']);
  assert.equal(config.flow.review, null);
});

test('project 与 runtime 深合并', () => {
  const merged = mergeConfig(defaults(), {
    project: { commands: { start: 'npm run dev', test: 'npm test' } },
    runtime: { max_rounds: { design_review: 5 } },
  });
  const config = validateConfig(merged);
  assert.equal(config.project.commands.start, 'npm run dev');
  assert.equal(config.project.commands.test, 'npm test');
  assert.equal(config.runtime.max_rounds.design_review, 5);
  assert.equal(config.runtime.max_rounds.dev_test, 3);
});

test('未知字段报错', () => {
  const raw = { ...defaults(), extra: true };
  assert.throws(() => validateConfig(raw), /未知字段/);
});

test('push 不能为 true', () => {
  const raw = defaults();
  const runtime = raw.runtime as Record<string, unknown>;
  runtime.push = true;
  assert.throws(() => validateConfig(raw), /绝不推送/);
});

test('orchestrator 不能使用 sequential', () => {
  const raw = defaults();
  const runtime = raw.runtime as Record<string, unknown>;
  runtime.orchestrator = 'sequential';
  assert.throws(() => validateConfig(raw), /必须依赖 Orca/);
});

test('角色引用不存在的 agent 报错', () => {
  const merged = mergeConfig(defaults(), {
    roles: {
      designer: {
        agent: 'missing',
        writes: ['docs/design/'],
        artifact: { path: 'docs/design/{{story}}.md' },
      },
    },
    flow: { design: 'designer', review: null, develop: 'designer', test: null, accept: 'coordinator' },
  });
  assert.throws(() => validateConfig(merged), /不存在的 agent/);
});

test('writes 过宽报错', () => {
  const merged = mergeConfig(defaults(), {
    roles: {
      designer: {
        agent: 'claude-main',
        writes: ['**'],
        artifact: { path: 'docs/design/{{story}}.md' },
      },
    },
    flow: { design: 'designer', review: null, develop: 'designer', test: null, accept: 'coordinator' },
  });
  assert.throws(() => validateConfig(merged), /范围过宽/);
});

test('start 命令在 requireCommands 时要求 start/test', () => {
  assert.throws(() => validateConfig(defaults(), { requireCommands: true }), /commands\.start/);
});

test('角色名必须能安全用作文件名', () => {
  for (const name of ['designer', '设计-1', 'team.lead', 'a_b']) {
    assert.doesNotThrow(() => validateRoleName(name));
  }
  for (const name of ['../evil', 'a/b', 'a\\b', '.hidden', '-lead', 'con', 'NUL.md', 'name.', 'name ']) {
    assert.throws(() => validateRoleName(name), /安全文件名/);
  }
});

test('角色名仅大小写不同时报错', () => {
  const raw = defaults();
  const roles = raw.roles as Record<string, unknown>;
  roles.Designer = roles.designer;
  const flow = raw.flow as Record<string, unknown>;
  flow.design = 'Designer';
  assert.throws(() => validateConfig(raw), /仅大小写不同/);
});

function withRepos(repos: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = defaults();
  const project = raw.project as Record<string, unknown>;
  project.repos = repos;
  return mergeConfig(raw, extra);
}

test('project.repos 接受合法关联仓库并保持顺序', () => {
  const config = validateConfig(withRepos([{ name: 'api', path: 'api' }, { name: 'web', path: 'apps/web' }]));
  assert.deepEqual(config.project.repos, [
    { name: 'api', path: 'api' },
    { name: 'web', path: 'apps/web' },
  ]);
});

test('project.repos 拒绝空数组与未知字段', () => {
  assert.throws(() => validateConfig(withRepos([])), /不能为空数组/);
  assert.throws(() => validateConfig(withRepos([{ name: 'api', path: 'api', url: 'x' }])), /未知字段/);
});

test('project.repos 名称唯一（大小写不敏感）且不能是保留名', () => {
  assert.throws(
    () => validateConfig(withRepos([{ name: 'api', path: 'api' }, { name: 'API', path: 'web' }])),
    /重复/,
  );
  for (const name of ['workspace', 'all', 'root', 'Workspace']) {
    assert.throws(() => validateConfig(withRepos([{ name, path: 'api' }])), /保留名称/);
  }
  for (const name of ['../evil', 'a/b', '.hidden', 'con', 'name.']) {
    assert.throws(() => validateConfig(withRepos([{ name, path: 'api' }])), /安全文件名/);
  }
});

test('project.repos 路径必须是安全的 workspace 相对路径', () => {
  const invalid = [
    '/abs/api',
    '../api',
    'api/../web',
    './api',
    'api\\web',
    'api/*',
    'api/',
    'api//web',
    'api/',
    'api/.',
    'api/name ',
    'api/name.',
    'con',
  ];
  for (const repoPath of invalid) {
    assert.throws(
      () => validateConfig(withRepos([{ name: 'api', path: repoPath }])),
      /相对路径|非法路径段/,
      `应拒绝：${repoPath}`,
    );
  }
});

test('project.repos 路径不能互相重叠', () => {
  assert.throws(
    () => validateConfig(withRepos([{ name: 'api', path: 'api' }, { name: 'web', path: 'api/web' }])),
    /重叠/,
  );
  assert.throws(
    () => validateConfig(withRepos([{ name: 'a', path: 'api/web' }, { name: 'b', path: 'api' }])),
    /重叠/,
  );
});

test('project.repos 下 runtime.worktree 只允许 path:.', () => {
  assert.doesNotThrow(() =>
    validateConfig(withRepos([{ name: 'api', path: 'api' }], { runtime: { worktree: 'path:.' } })),
  );
  assert.throws(
    () =>
      validateConfig(withRepos([{ name: 'api', path: 'api' }], { runtime: { worktree: 'branch:feature/x' } })),
    /只能是 path:\./,
  );
});

test('全局配置里的 project.repos 被忽略', async () => {
  const { configFromRaw } = await import('../src/core/config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-orchestration-global-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'orca-team-orchestration'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'orca-team-orchestration', 'config.yaml'),
      'project:\n  repos:\n    - name: leaked\n      path: leaked\n',
      'utf8',
    );
    const config = configFromRaw(process.cwd(), 'version: 1\nproject: {}\nruntime: {}\nagents:\n  a: {kind: claude}\nroles:\n  r:\n    agent: a\n    writes: [docs/]\n    artifact: {path: "docs/{{story}}.md"}\nflow:\n  design: r\n  review: null\n  develop: r\n  test: null\n  accept: coordinator\nguards: []\nchecks: {}\n');
    assert.equal(config.project.repos, undefined);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
