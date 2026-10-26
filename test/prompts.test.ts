import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  builtinDefaults,
  loadConfig,
  validateConfig,
  writeProjectConfig,
  type Config,
} from '../src/core/config.js';
import { PromptError } from '../src/core/errors.js';
import {
  planRolePrompts,
  readRolesSnapshot,
  renderRolePrompt,
  roleOverridePath,
  saveRolePrompts,
  type RolesSnapshot,
} from '../src/core/prompts.js';
import { cleanup, tempRepo, write } from './helpers.js';

const dirs: string[] = [];
const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-xdg-'));
const previousXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = xdg;

after(() => {
  for (const dir of dirs) cleanup(dir);
  fs.rmSync(xdg, { recursive: true, force: true });
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

function project(prefix: string, mutate?: (raw: Config) => void): string {
  const root = tempRepo(prefix);
  dirs.push(root);
  const raw = builtinDefaults('demo');
  mutate?.(raw);
  writeProjectConfig(root, validateConfig(raw));
  return root;
}

function roleOf(snapshot: RolesSnapshot, name: string) {
  const role = snapshot.roles.find((item) => item.name === name);
  assert.ok(role, `missing role ${name}`);
  return role;
}

function isPromptError(error: unknown, kind: string): boolean {
  return error instanceof PromptError && error.kind === kind;
}

test('默认模板按 flow 顺序提供四个内置角色', () => {
  const root = project('prompt-defaults');
  const snapshot = readRolesSnapshot(root);

  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.valid, true);
  assert.equal(snapshot.locale, 'zh-CN');
  assert.equal(snapshot.templatesLocale, 'zh-CN');
  assert.equal(snapshot.localeFallback, false);
  assert.deepEqual(snapshot.rounds, { design_review: 3, dev_test: 3 });
  assert.deepEqual(
    snapshot.roles.map((role) => role.name),
    ['designer', 'reviewer', 'developer', 'tester'],
  );

  const designer = roleOf(snapshot, 'designer');
  assert.deepEqual(designer.stages, ['design']);
  assert.equal(designer.defaultSource, 'builtin');
  assert.match(designer.defaultPrompt, /角色契约：方案设计/);
  assert.equal(designer.overrideRevision, null);
  assert.equal(designer.effectivePrompt, designer.defaultPrompt);
  assert.equal(designer.overridePath, '.orca-team-orchestration/roles/designer.md');
  assert.ok(snapshot.roles.every((role) => role.defaultSource === 'builtin'));
});

test('locale 为 en 时使用英文模板，缺失时整体回退', () => {
  const english = project('prompt-en', (raw) => {
    raw.locale = 'en';
  });
  const enSnapshot = readRolesSnapshot(english);
  assert.equal(enSnapshot.locale, 'en');
  assert.equal(enSnapshot.templatesLocale, 'en');
  assert.match(roleOf(enSnapshot, 'designer').defaultPrompt, /Role contract: design/);

  const templates = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-templates-'));
  write(templates, 'zh-CN/system.md', '# 系统约束\n\n回退系统段\n');
  write(templates, 'zh-CN/designer.md', '# 角色契约：回退设计\n');
  const previous = process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES;
  process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES = templates;
  try {
    const fallbackRoot = project('prompt-fallback', (raw) => {
      raw.locale = 'en';
    });
    const snapshot = readRolesSnapshot(fallbackRoot);
    assert.equal(snapshot.locale, 'en');
    assert.equal(snapshot.templatesLocale, 'zh-CN');
    assert.equal(snapshot.localeFallback, true);
    assert.match(roleOf(snapshot, 'designer').defaultPrompt, /回退设计/);
    assert.ok(snapshot.warnings.some((warning) => warning.includes('回退到 zh-CN')));
  } finally {
    if (previous === undefined) delete process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES;
    else process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES = previous;
    cleanup(templates);
  }
});

test('模板目录完全缺失时使用内置系统段与通用契约', () => {
  const templates = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-templates-empty-'));
  const previous = process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES;
  process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES = templates;
  try {
    const root = project('prompt-no-templates', (raw) => {
      raw.locale = 'en';
    });
    const snapshot = readRolesSnapshot(root);
    assert.equal(snapshot.localeFallback, true);
    assert.ok(snapshot.roles.every((role) => role.defaultSource === 'generic'));
    assert.ok(snapshot.warnings.some((warning) => warning.includes('未找到默认提示词模板')));

    write(root, 'features/story-0.1.0-001.md', '需求\n');
    const rendered = renderRolePrompt(root, loadConfig(root), 'designer', { story: 'story-0.1.0-001' });
    assert.ok(rendered.prompt.includes('# System constraints'));
    assert.ok(rendered.prompt.includes('# Role contract: designer'));
    assert.ok(rendered.warnings.some((warning) => warning.includes('未找到默认提示词模板')));
  } finally {
    if (previous === undefined) delete process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES;
    else process.env.ORCA_TEAM_ORCHESTRATION_TEMPLATES = previous;
    cleanup(templates);
  }
});

test('自定义角色没有内置模板时使用通用契约', () => {
  const root = project('prompt-generic', (raw) => {
    raw.roles = {
      solo: {
        agent: 'claude-main',
        writes: ['docs/design/'],
        artifact: { path: 'docs/design/{{story}}.md' },
      },
    };
    raw.flow = { design: 'solo', review: null, develop: 'solo', test: null, accept: null };
  });
  const snapshot = readRolesSnapshot(root);
  const solo = roleOf(snapshot, 'solo');
  assert.deepEqual(solo.stages, ['design', 'develop']);
  assert.equal(solo.defaultSource, 'generic');
  assert.match(solo.defaultPrompt, /角色契约：solo/);
  assert.match(solo.defaultPrompt, /方案设计/);
  assert.deepEqual(snapshot.roles.map((role) => role.name), ['solo']);
});

test('覆盖文件优先，保存写入备份，恢复默认删除覆盖', () => {
  const root = project('prompt-override');
  const file = roleOverridePath(root, 'designer');
  write(root, '.orca-team-orchestration/roles/designer.md', '# 自定义契约\n\n只做设计。\n');

  const snapshot = readRolesSnapshot(root);
  const designer = roleOf(snapshot, 'designer');
  assert.equal(designer.overridePrompt, '# 自定义契约\n\n只做设计。\n');
  assert.equal(designer.effectivePrompt, designer.overridePrompt);
  assert.match(String(designer.overrideRevision), /^[a-f0-9]{64}$/);
  assert.match(designer.defaultPrompt, /角色契约：方案设计/);

  const plan = saveRolePrompts(root, {
    baseConfigRevision: snapshot.configRevision,
    roles: { designer: { baseRevision: designer.overrideRevision, prompt: '# 第二版\n' } },
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.configChanged, false);
  assert.equal(plan.files[0]?.action, 'write');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 第二版\n');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '# 自定义契约\n\n只做设计。\n');

  const second = readRolesSnapshot(root);
  const secondDesigner = roleOf(second, 'designer');
  const restored = saveRolePrompts(root, {
    baseConfigRevision: second.configRevision,
    roles: { designer: { baseRevision: secondDesigner.overrideRevision, prompt: null } },
  });
  assert.equal(restored.files[0]?.action, 'delete');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '# 第二版\n');

  const third = readRolesSnapshot(root);
  const idempotent = saveRolePrompts(root, {
    baseConfigRevision: third.configRevision,
    roles: { designer: { baseRevision: roleOf(third, 'designer').overrideRevision, prompt: null } },
  });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.files[0]?.action, 'unchanged');
});

test('提示词内容等于默认时视为继承默认并删除覆盖文件', () => {
  const root = project('prompt-default-equal');
  const snapshot = readRolesSnapshot(root);
  const designer = roleOf(snapshot, 'designer');
  const file = roleOverridePath(root, 'designer');
  write(root, '.orca-team-orchestration/roles/designer.md', designer.defaultPrompt);

  const withOverride = readRolesSnapshot(root);
  const plan = saveRolePrompts(root, {
    baseConfigRevision: withOverride.configRevision,
    roles: { designer: { baseRevision: roleOf(withOverride, 'designer').overrideRevision, prompt: designer.defaultPrompt } },
  });
  assert.equal(plan.files[0]?.action, 'delete');
  assert.equal(fs.existsSync(file), false);
});

test('非法角色、超大提示词、非法轮次与过期 revision 被拒绝', () => {
  const root = project('prompt-invalid');
  const snapshot = readRolesSnapshot(root);
  const revision = snapshot.configRevision;

  assert.throws(
    () =>
      planRolePrompts(root, {
        baseConfigRevision: revision,
        roles: { nope: { baseRevision: null, prompt: '# x\n' } },
      }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () =>
      planRolePrompts(root, {
        baseConfigRevision: revision,
        roles: { designer: { baseRevision: null, prompt: 'x'.repeat(64 * 1024 + 1) } },
      }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, rounds: { design_review: 0, dev_test: 3 } }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () =>
      planRolePrompts(root, {
        baseConfigRevision: 'stale',
        roles: { designer: { baseRevision: null, prompt: '# x\n' } },
      }),
    (error) => isPromptError(error, 'conflict'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, extra: true }),
    (error) => isPromptError(error, 'bad_request'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision }),
    (error) => isPromptError(error, 'bad_request'),
  );

  const file = roleOverridePath(root, 'designer');
  write(root, '.orca-team-orchestration/roles/designer.md', '# one\n');
  const withOverride = readRolesSnapshot(root);
  const staleRevision = roleOf(withOverride, 'designer').overrideRevision;
  write(root, '.orca-team-orchestration/roles/designer.md', '# two\n');
  assert.throws(
    () =>
      saveRolePrompts(root, {
        baseConfigRevision: withOverride.configRevision,
        roles: { designer: { baseRevision: staleRevision, prompt: '# three\n' } },
      }),
    (error) => isPromptError(error, 'conflict'),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '# two\n');
});

test('保存轮次保留 YAML 注释并生成备份', () => {
  const root = tempRepo('prompt-rounds');
  dirs.push(root);
  const raw = `# 顶部注释
version: 1
project:
  name: demo
runtime:
  max_rounds:
    design_review: 3 # 设计轮次
    dev_test: 3
`;
  write(root, '.orca-team-orchestration/config.yaml', raw);
  const snapshot = readRolesSnapshot(root);
  assert.equal(snapshot.valid, true);

  const preview = planRolePrompts(root, {
    baseConfigRevision: snapshot.configRevision,
    rounds: { design_review: 7, dev_test: 5 },
  });
  assert.equal(preview.configChanged, true);
  assert.deepEqual(preview.rounds.before, { design_review: 3, dev_test: 3 });
  assert.deepEqual(preview.rounds.after, { design_review: 7, dev_test: 5 });
  assert.equal(fs.readFileSync(path.join(root, '.orca-team-orchestration', 'config.yaml'), 'utf8'), raw);

  const plan = saveRolePrompts(root, {
    baseConfigRevision: snapshot.configRevision,
    rounds: { design_review: 7, dev_test: 5 },
  });
  assert.equal(plan.changed, true);
  const file = path.join(root, '.orca-team-orchestration', 'config.yaml');
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /# 顶部注释/);
  assert.match(saved, /# 设计轮次/);
  assert.match(saved, /design_review: 7/);
  assert.match(saved, /dev_test: 5/);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), raw);
  assert.deepEqual(readRolesSnapshot(root).rounds, { design_review: 7, dev_test: 5 });
});

test('渲染顺序、需求快照、围栏与轮次上限', () => {
  const root = project('prompt-render');
  write(root, 'features/story-0.1.0-001.md', '实时需求\n');
  write(
    root,
    '.orca-team-orchestration/runs/story-0.1.0-001/spec.md',
    '# 快照需求\n\n包含 `inline` 和 ``` 围栏\n',
  );
  const rendered = renderRolePrompt(root, loadConfig(root), 'designer', {
    story: 'story-0.1.0-001',
    round: 2,
  });

  assert.equal(rendered.role, 'designer');
  assert.equal(rendered.stage, 'design');
  assert.equal(rendered.round, 2);
  const prompt = rendered.prompt;
  assert.ok(
    prompt.startsWith(
      '<!-- oto prompt v1 role=designer stage=design round=2 locale=zh-CN contract=default -->',
    ),
  );
  const order = ['# 系统约束', '# 角色契约：方案设计', '## 项目约束', '## 需求数据', '## 本次任务'].map(
    (marker) => prompt.indexOf(marker),
  );
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(prompt.includes('快照需求'));
  assert.ok(!prompt.includes('实时需求'));
  assert.match(prompt, /sha256：[a-f0-9]{64}/);
  assert.match(prompt, /\n````\n/);
  assert.match(prompt, /docs\/v0.1.0\/design\/story-0.1.0-001-r2\.md/);
  assert.match(prompt, /轮次：2 \/ 上限 3/);
  assert.equal(rendered.warnings.some((warning) => warning.includes('实时')), false);
});

test('缺少需求快照时读取实时文件并给出 warning', () => {
  const root = project('prompt-live');
  write(root, 'features/story-0.1.0-001.md', '实时需求内容\n');
  const rendered = renderRolePrompt(root, loadConfig(root), 'designer', { story: 'story-0.1.0-001' });
  assert.ok(rendered.prompt.includes('实时需求内容'));
  assert.ok(rendered.warnings.some((warning) => warning.includes('需求快照不存在')));
});

test('项目规则追加在提示词末尾', () => {
  const root = project('prompt-rules', (raw) => {
    raw.roles.designer.rules = '只允许小步提交。';
  });
  const rendered = renderRolePrompt(root, loadConfig(root), 'designer');
  assert.ok(rendered.prompt.trimEnd().endsWith('## 项目规则\n\n只允许小步提交。'));
});

test('上一轮报告可以显式传入或从运行状态读取', () => {
  const root = project('prompt-previous');
  write(root, 'features/story-0.1.0-001.md', '需求\n');
  write(root, 'docs/review/story-0.1.0-001-r1.md', '旧报告内容\n');

  const explicit = renderRolePrompt(root, loadConfig(root), 'reviewer', {
    story: 'story-0.1.0-001',
    round: 1,
    previousArtifact: 'docs/review/story-0.1.0-001-r1.md',
  });
  assert.match(explicit.prompt, /### 上一轮报告/);
  assert.match(explicit.prompt, /旧报告内容/);

  write(
    root,
    '.orca-team-orchestration/runs/story-0.1.0-001.json',
    JSON.stringify({
      version: 1,
      story: 'story-0.1.0-001',
      title: 'demo',
      runId: 'run-1',
      orchestrator: 'orca',
      startedAt: '2026-01-01T00:00:00.000Z',
      spec: { source: 'features/story-0.1.0-001.md', snapshot: 'spec.md', sha256: '0'.repeat(64) },
      features: [],
      acceptance: [],
      stages: {},
      history: [{ stage: 'review', round: 1, outcome: 'rejected', report: 'docs/review/story-0.1.0-001-r1.md' }],
    }),
  );
  const automatic = renderRolePrompt(root, loadConfig(root), 'reviewer', {
    story: 'story-0.1.0-001',
    round: 2,
  });
  assert.match(automatic.prompt, /旧报告内容/);
});

test('未进入 flow 的角色渲染为 unassigned 并给出 warning', () => {
  const root = project('prompt-extra', (raw) => {
    raw.roles.extra = {
      agent: 'claude-main',
      writes: ['docs/extra/'],
      artifact: { path: 'docs/extra/{{story}}.md' },
    };
  });
  write(root, 'features/story-0.1.0-001.md', '需求\n');
  const rendered = renderRolePrompt(root, loadConfig(root), 'extra', { story: 'story-0.1.0-001' });
  assert.equal(rendered.stage, 'unassigned');
  assert.ok(rendered.warnings.some((warning) => warning.includes('未进入 flow')));
});

test('未知角色或与该角色不匹配的阶段被拒绝', () => {
  const root = project('prompt-render-invalid');
  const config = loadConfig(root);
  assert.throws(
    () => renderRolePrompt(root, config, 'nope'),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => renderRolePrompt(root, config, 'designer', { stage: 'test' }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => renderRolePrompt(root, config, 'designer', { story: 'story-0.1.0-001' }),
    (error) => isPromptError(error, 'invalid'),
  );
});

test('快照暴露 agent 池', () => {
  const root = project('prompt-agents-snapshot');
  const snapshot = readRolesSnapshot(root);
  assert.deepEqual(Object.keys(snapshot.agents).sort(), ['claude-main', 'codex-review']);
  assert.equal(snapshot.agents['claude-main']?.kind, 'claude');
  assert.equal(roleOf(snapshot, 'designer').agent, 'claude-main');
});

test('改绑 agent 写入 config 且不动提示词覆盖文件', () => {
  const root = project('prompt-bind');
  write(root, '.orca-team-orchestration/roles/developer.md', '# dev contract\n');
  const snapshot = readRolesSnapshot(root);

  const plan = saveRolePrompts(root, {
    baseConfigRevision: snapshot.configRevision,
    roles: { developer: { agent: 'codex-review' } },
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.configChanged, true);
  assert.equal(plan.agentsChanged, false);
  assert.equal(plan.assignments.before.developer, 'claude-main');
  assert.equal(plan.assignments.after.developer, 'codex-review');
  assert.equal(plan.files.length, 0);

  assert.equal(loadConfig(root).roles.developer!.agent, 'codex-review');
  assert.equal(fs.readFileSync(roleOverridePath(root, 'developer'), 'utf8'), '# dev contract\n');
  assert.equal(roleOf(readRolesSnapshot(root), 'developer').agent, 'codex-review');

  const again = planRolePrompts(root, {
    baseConfigRevision: readRolesSnapshot(root).configRevision,
    roles: { developer: { agent: 'codex-review' } },
  });
  assert.equal(again.changed, false);
});

test('新增 agent、改定义、删除未使用 agent', () => {
  const root = project('prompt-agent-pool');
  const snapshot = readRolesSnapshot(root);

  const added = saveRolePrompts(root, {
    baseConfigRevision: snapshot.configRevision,
    agents: { 'zcode-dev': { kind: 'zcode', model: 'gpt-x', effort: 'low' } },
    roles: { developer: { agent: 'zcode-dev' } },
  });
  assert.equal(added.agentsChanged, true);
  let config = loadConfig(root);
  assert.deepEqual(config.agents['zcode-dev'], { kind: 'zcode', model: 'gpt-x', effort: 'low' });
  assert.equal(config.roles.developer!.agent, 'zcode-dev');

  const second = readRolesSnapshot(root);
  saveRolePrompts(root, {
    baseConfigRevision: second.configRevision,
    agents: {
      'zcode-dev': { model: null, effort: 'high' },
      'claude-main': { model: 'opus' },
      spare: { kind: 'opencode' },
    },
  });
  config = loadConfig(root);
  assert.deepEqual(config.agents['zcode-dev'], { kind: 'zcode', effort: 'high' });
  assert.equal(config.agents['claude-main']?.model, 'opus');
  assert.deepEqual(config.agents.spare, { kind: 'opencode' });

  const third = readRolesSnapshot(root);
  assert.throws(
    () =>
      planRolePrompts(root, {
        baseConfigRevision: third.configRevision,
        agents: { 'codex-review': null },
      }),
    (error) => isPromptError(error, 'invalid'),
  );
  const removed = saveRolePrompts(root, {
    baseConfigRevision: third.configRevision,
    agents: { spare: null },
  });
  assert.equal(removed.configChanged, true);
  config = loadConfig(root);
  assert.equal('spare' in config.agents, false);
  assert.equal('codex-review' in config.agents, true);
});

test('agent 绑定与池规则校验', () => {
  const root = project('prompt-agent-invalid');
  const snapshot = readRolesSnapshot(root);
  const revision = snapshot.configRevision;

  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, roles: { designer: { agent: 'ghost' } } }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, agents: { 'claude-main': null } }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, agents: { mine: { kind: 'cursor' } } }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, agents: { mine: { kind: 'nope' } } }),
    (error) => isPromptError(error, 'invalid'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: revision, agents: { mine: { extraField: 1 } } }),
    (error) => isPromptError(error, 'bad_request'),
  );
  assert.throws(
    () => planRolePrompts(root, { baseConfigRevision: 'stale', roles: { designer: { agent: 'codex-review' } } }),
    (error) => isPromptError(error, 'conflict'),
  );

  const addedPlan = planRolePrompts(root, {
    baseConfigRevision: revision,
    agents: { mine: { kind: 'zcode', model: 'z-1' } },
  });
  assert.equal(addedPlan.agentsChanged, true);
  assert.throws(
    () =>
      planRolePrompts(root, {
        baseConfigRevision: revision,
        agents: { mine: { kind: 'zcode', command: 'x' } },
      }),
    (error) => isPromptError(error, 'bad_request'),
  );

  const configAfter = loadConfig(root);
  assert.equal(configAfter.roles.designer!.agent, 'claude-main');
});

test('最小配置改绑会补全 roles 段并保留注释', () => {
  const root = tempRepo('prompt-bind-minimal');
  dirs.push(root);
  const raw = `# 顶部注释
version: 1
project:
  name: demo
`;
  write(root, '.orca-team-orchestration/config.yaml', raw);
  const snapshot = readRolesSnapshot(root);
  assert.equal(snapshot.valid, true);

  const plan = saveRolePrompts(root, {
    baseConfigRevision: snapshot.configRevision,
    roles: { designer: { agent: 'codex-review' } },
  });
  assert.equal(plan.configChanged, true);
  const file = path.join(root, '.orca-team-orchestration', 'config.yaml');
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /# 顶部注释/);
  assert.match(saved, /agent: codex-review/);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), raw);
  const config = loadConfig(root);
  assert.equal(config.roles.designer!.agent, 'codex-review');
  assert.equal(config.roles.developer!.agent, 'claude-main');
});
