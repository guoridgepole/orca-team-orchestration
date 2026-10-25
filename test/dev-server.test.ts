import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cleanup, tempRepo, write } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverScript = path.join(projectRoot, 'dist', 'src', 'ui', 'server.js');

const CONFIG_YAML = `# project config
version: 1
project:
  name: demo
  commands:
    start: npm run dev
    test: npm test
    build: npm run build
    base_url: http://127.0.0.1:5173/
  paths:
    features_dir: features
    docs: docs
    source:
      - src/
    tests:
      - test/
    evidence: docs/test/evidence
runtime:
  max_rounds:
    design_review: 3
    dev_test: 3
`;

interface RunningServer {
  child: ChildProcessWithoutNullStreams;
  url: string;
}

interface RolePayload {
  name: string;
  stages: string[];
  agent: string;
  defaultPrompt: string;
  defaultSource: string;
  overrideRevision: string | null;
  effectivePrompt: string;
  overridePath: string;
}

interface SnapshotPayload {
  initialized: boolean;
  valid: boolean;
  errorKind: string | null;
  error: string | null;
  configRevision: string | null;
  locale: string;
  templatesLocale: string;
  rounds: { design_review: number; dev_test: number };
  agents: Record<string, { kind: string; model?: string | null; effort?: string | null; command?: string | null }>;
  roles: RolePayload[];
  warnings: string[];
}

interface PlanPayload {
  changed: boolean;
  configChanged: boolean;
  rounds: {
    before: { design_review: number; dev_test: number };
    after: { design_review: number; dev_test: number };
  };
  agentsChanged: boolean;
  agents: {
    before: Record<string, Record<string, unknown>>;
    after: Record<string, Record<string, unknown>>;
  };
  assignments: { before: Record<string, string>; after: Record<string, string> };
  files: Array<{
    role: string;
    path: string;
    action: string;
    backupPath: string | null;
    bytes: number;
  }>;
  warnings: string[];
}

interface SavePayload {
  plan: PlanPayload;
  snapshot: SnapshotPayload;
}

function waitForUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`开发服务器启动超时：${output}`));
    }, 5_000);

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
      reject(new Error(`开发服务器提前退出（${code}）：${output}`));
    });
  });
}

async function startServer(repoRoot: string, cwd = repoRoot): Promise<RunningServer> {
  const xdg = path.join(repoRoot, '.xdg-config');
  fs.mkdirSync(xdg, { recursive: true });
  const child = spawn(process.execPath, [serverScript], {
    cwd,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      ORCA_TEAM_ORCHESTRATION_REPO: repoRoot,
      XDG_CONFIG_HOME: xdg,
    },
  }) as ChildProcessWithoutNullStreams;

  try {
    const url = await waitForUrl(child);
    return { child, url };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

async function stopServer(server: RunningServer): Promise<void> {
  server.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (server.child.exitCode !== null) {
      resolve();
      return;
    }
    server.child.once('exit', () => resolve());
  });
}

function api(server: RunningServer, pathname: string): string {
  return new URL(pathname, server.url).href;
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function rolesSnapshot(server: RunningServer): Promise<SnapshotPayload> {
  return (await (await fetch(api(server, '/api/roles'))).json()) as SnapshotPayload;
}

function roleByName(snapshot: SnapshotPayload, name: string): RolePayload {
  const role = snapshot.roles.find((item) => item.name === name);
  assert.ok(role, `missing role ${name}`);
  return role;
}

function roleFile(root: string, name = 'designer'): string {
  return path.join(root, '.orca-team-orchestration', 'roles', `${name}.md`);
}

test('页面、状态与角色快照，旧配置接口已移除', async () => {
  const root = tempRepo('ui-page');
  write(root, '.orca-team-orchestration/config.yaml', CONFIG_YAML);
  const server = await startServer(root, root);
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /角色提示词/);
    assert.doesNotMatch(await (await fetch(server.url)).text(), /编辑核心配置/);

    const health = await fetch(api(server, '/healthz'));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const status = (await (await fetch(api(server, '/api/status'))).json()) as Record<string, unknown>;
    assert.equal(status.ready, true);
    assert.equal(status.projectRoot, root);
    assert.equal(status.configFound, true);
    assert.equal(status.configValid, true);
    assert.equal(status.projectName, 'demo');
    assert.equal(status.startCommand, 'npm run dev');
    assert.equal(status.workspace, false);
    assert.deepEqual(status.repos, []);

    const snapshot = await rolesSnapshot(server);
    assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.valid, true);
    assert.equal(snapshot.locale, 'zh-CN');
    assert.equal(snapshot.templatesLocale, 'zh-CN');
    assert.match(String(snapshot.configRevision), /^[a-f0-9]{64}$/);
    assert.deepEqual(snapshot.rounds, { design_review: 3, dev_test: 3 });
    assert.deepEqual(
      snapshot.roles.map((role) => role.name),
      ['designer', 'reviewer', 'developer', 'tester'],
    );
    const designer = roleByName(snapshot, 'designer');
    assert.deepEqual(designer.stages, ['design']);
    assert.equal(designer.defaultSource, 'builtin');
    assert.equal(designer.overrideRevision, null);
    assert.match(designer.defaultPrompt, /方案设计/);
    assert.equal(designer.overridePath, '.orca-team-orchestration/roles/designer.md');

    const old = await fetch(api(server, '/api/config'));
    assert.equal(old.status, 404);

    const script = await (await fetch(api(server, '/app.js'))).text();
    assert.ok(!script.includes('innerHTML'));
    assert.match(script, /\/api\/roles/);
  } finally {
    await stopServer(server);
    cleanup(root);
  }
});

test('/api/status 暴露 workspace 与关联仓库', async () => {
  const root = tempRepo('ui-workspace');
  const config = CONFIG_YAML.replace(
    '  name: demo\n',
    '  name: demo\n  repos:\n    - name: api\n      path: api\n    - name: web\n      path: web\n',
  ).replace('runtime:\n', 'runtime:\n  worktree: path:.\n');
  write(root, '.orca-team-orchestration/config.yaml', config);
  const server = await startServer(root);
  try {
    const status = (await (await fetch(api(server, '/api/status'))).json()) as Record<string, unknown>;
    assert.equal(status.configValid, true);
    assert.equal(status.workspace, true);
    assert.deepEqual(status.repos, [
      { name: 'api', path: 'api' },
      { name: 'web', path: 'web' },
    ]);

    const snapshot = await rolesSnapshot(server);
    assert.equal(snapshot.valid, true);
  } finally {
    await stopServer(server);
    cleanup(root);
  }
});

test('预览不写盘，保存写入覆盖与备份，恢复默认删除覆盖', async () => {
  const root = tempRepo('ui-save');
  write(root, '.orca-team-orchestration/config.yaml', CONFIG_YAML);
  const server = await startServer(root);
  try {
    const file = roleFile(root);
    const snapshot = await rolesSnapshot(server);
    const firstPatch = {
      baseConfigRevision: snapshot.configRevision,
      roles: { designer: { baseRevision: null, prompt: '# custom\n' } },
    };

    const preview = await postJson(api(server, '/api/roles/preview'), firstPatch);
    assert.equal(preview.status, 200);
    const previewPlan = (await preview.json()) as PlanPayload;
    assert.equal(previewPlan.changed, true);
    assert.equal(previewPlan.configChanged, false);
    assert.equal(previewPlan.files[0]?.action, 'write');
    assert.equal(previewPlan.files[0]?.path, '.orca-team-orchestration/roles/designer.md');
    assert.equal(fs.existsSync(file), false);

    const save = await postJson(api(server, '/api/roles'), firstPatch);
    assert.equal(save.status, 200);
    const saved = (await save.json()) as SavePayload;
    assert.equal(saved.plan.changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '# custom\n');
    const savedDesigner = roleByName(saved.snapshot, 'designer');
    assert.match(String(savedDesigner.overrideRevision), /^[a-f0-9]{64}$/);
    assert.equal(savedDesigner.effectivePrompt, '# custom\n');
    assert.equal(fs.existsSync(`${file}.bak`), false);

    const secondPatch = {
      baseConfigRevision: saved.snapshot.configRevision,
      roles: { designer: { baseRevision: savedDesigner.overrideRevision, prompt: '# custom v2\n' } },
    };
    const second = await postJson(api(server, '/api/roles'), secondPatch);
    assert.equal(second.status, 200);
    const secondPayload = (await second.json()) as SavePayload;
    assert.equal(fs.readFileSync(file, 'utf8'), '# custom v2\n');
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '# custom\n');

    const current = roleByName(secondPayload.snapshot, 'designer');
    const restore = await postJson(api(server, '/api/roles'), {
      baseConfigRevision: secondPayload.snapshot.configRevision,
      roles: { designer: { baseRevision: current.overrideRevision, prompt: null } },
    });
    assert.equal(restore.status, 200);
    const restored = (await restore.json()) as SavePayload;
    assert.equal(restored.plan.files[0]?.action, 'delete');
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '# custom v2\n');
    assert.equal(roleByName(restored.snapshot, 'designer').overrideRevision, null);

    const again = await postJson(api(server, '/api/roles'), {
      baseConfigRevision: restored.snapshot.configRevision,
      roles: { designer: { baseRevision: null, prompt: null } },
    });
    assert.equal(again.status, 200);
    const againPayload = (await again.json()) as SavePayload;
    assert.equal(againPayload.plan.changed, false);
    assert.equal(againPayload.plan.files[0]?.action, 'unchanged');
  } finally {
    await stopServer(server);
    cleanup(root);
  }
});

test('保存轮次保留 YAML 注释并备份配置', async () => {
  const root = tempRepo('ui-rounds');
  const configFile = path.join(root, '.orca-team-orchestration', 'config.yaml');
  write(root, '.orca-team-orchestration/config.yaml', CONFIG_YAML);
  const server = await startServer(root);
  try {
    const before = fs.readFileSync(configFile, 'utf8');
    const snapshot = await rolesSnapshot(server);
    const patch = {
      baseConfigRevision: snapshot.configRevision,
      rounds: { design_review: 5, dev_test: 4 },
      roles: {},
    };

    const preview = await postJson(api(server, '/api/roles/preview'), patch);
    assert.equal(preview.status, 200);
    const plan = (await preview.json()) as PlanPayload;
    assert.equal(plan.configChanged, true);
    assert.deepEqual(plan.rounds.before, { design_review: 3, dev_test: 3 });
    assert.deepEqual(plan.rounds.after, { design_review: 5, dev_test: 4 });
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);

    const save = await postJson(api(server, '/api/roles'), patch);
    assert.equal(save.status, 200);
    const saved = (await save.json()) as SavePayload;
    assert.equal(saved.plan.changed, true);
    const after = fs.readFileSync(configFile, 'utf8');
    assert.match(after, /# project config/);
    assert.match(after, /design_review: 5/);
    assert.match(after, /dev_test: 4/);
    assert.equal(fs.readFileSync(`${configFile}.bak`, 'utf8'), before);
    assert.deepEqual(saved.snapshot.rounds, { design_review: 5, dev_test: 4 });
  } finally {
    await stopServer(server);
    cleanup(root);
  }
});

test('拒绝非法请求、过期 revision 与超限请求体', async () => {
  const root = tempRepo('ui-reject');
  const configFile = path.join(root, '.orca-team-orchestration', 'config.yaml');
  write(root, '.orca-team-orchestration/config.yaml', CONFIG_YAML);
  const server = await startServer(root);
  try {
    const before = fs.readFileSync(configFile, 'utf8');
    const snapshot = await rolesSnapshot(server);
    const previewUrl = api(server, '/api/roles/preview');
    const base = { baseConfigRevision: snapshot.configRevision };

    const unknownTop = await postJson(previewUrl, { ...base, extra: true });
    assert.equal(unknownTop.status, 400);

    const unknownRole = await postJson(previewUrl, {
      ...base,
      roles: { nope: { baseRevision: null, prompt: '# x\n' } },
    });
    assert.equal(unknownRole.status, 422);

    const badRound = await postJson(previewUrl, {
      ...base,
      rounds: { design_review: 0, dev_test: 3 },
    });
    assert.equal(badRound.status, 422);

    const oversized = await postJson(previewUrl, {
      ...base,
      roles: { designer: { baseRevision: null, prompt: 'x'.repeat(64 * 1024 + 1) } },
    });
    assert.equal(oversized.status, 422);

    const stale = await postJson(previewUrl, {
      baseConfigRevision: 'stale',
      roles: { designer: { baseRevision: null, prompt: '# x\n' } },
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'conflict');

    const badOrigin = await postJson(
      previewUrl,
      { ...base, roles: { designer: { baseRevision: null, prompt: '# x\n' } } },
      { Origin: 'http://evil.example' },
    );
    assert.equal(badOrigin.status, 403);

    const badType = await fetch(previewUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(badType.status, 415);

    const huge = await postJson(previewUrl, { ...base, pad: 'x'.repeat(1024 * 1024 + 1024) });
    assert.equal(huge.status, 413);

    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    assert.equal(fs.existsSync(roleFile(root)), false);

    const file = roleFile(root);
    write(root, '.orca-team-orchestration/roles/designer.md', '# one\n');
    const withOverride = await rolesSnapshot(server);
    const staleRevision = roleByName(withOverride, 'designer').overrideRevision;
    write(root, '.orca-team-orchestration/roles/designer.md', '# two\n');
    const roleConflict = await postJson(api(server, '/api/roles'), {
      baseConfigRevision: withOverride.configRevision,
      roles: { designer: { baseRevision: staleRevision, prompt: '# three\n' } },
    });
    assert.equal(roleConflict.status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), '# two\n');
  } finally {
    await stopServer(server);
    cleanup(root);
  }
});

test('未初始化与 YAML 解析失败返回 409', async () => {
  const missing = tempRepo('ui-uninitialized');
  const missingServer = await startServer(missing);
  try {
    const snapshot = await rolesSnapshot(missingServer);
    assert.equal(snapshot.initialized, false);
    assert.equal(snapshot.errorKind, 'missing');
    assert.deepEqual(snapshot.roles, []);

    const preview = await postJson(api(missingServer, '/api/roles/preview'), {
      baseConfigRevision: 'x',
    });
    assert.equal(preview.status, 409);
    assert.equal(
      ((await preview.json()) as { error: { code: string } }).error.code,
      'not_initialized',
    );
  } finally {
    await stopServer(missingServer);
    cleanup(missing);
  }

  const broken = tempRepo('ui-parse-error');
  write(broken, '.orca-team-orchestration/config.yaml', 'version: 1\nproject: {\n');
  const brokenServer = await startServer(broken);
  try {
    const snapshot = await rolesSnapshot(brokenServer);
    assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.valid, false);
    assert.equal(snapshot.errorKind, 'parse');
    assert.deepEqual(snapshot.roles, []);

    const preview = await postJson(api(brokenServer, '/api/roles/preview'), {
      baseConfigRevision: 'x',
    });
    assert.equal(preview.status, 409);
    assert.equal(
      ((await preview.json()) as { error: { code: string } }).error.code,
      'parse_error',
    );
  } finally {
    await stopServer(brokenServer);
    cleanup(broken);
  }
});

test('角色改绑与 agent 池管理通过 HTTP 往返保存', async () => {
  const root = tempRepo('ui-agents');
  write(root, '.orca-team-orchestration/config.yaml', CONFIG_YAML);
  const server = await startServer(root);
  try {
    const snapshot = await rolesSnapshot(server);
    assert.equal(snapshot.agents['claude-main']?.kind, 'claude');
    assert.equal(roleByName(snapshot, 'developer').agent, 'claude-main');

    const page = await (await fetch(server.url)).text();
    assert.match(page, /Agent 池/);

    const patch = {
      baseConfigRevision: snapshot.configRevision,
      agents: { 'zcode-fast': { kind: 'zcode', effort: 'low' } },
      roles: { developer: { agent: 'zcode-fast' } },
    };
    const preview = await postJson(api(server, '/api/roles/preview'), patch);
    assert.equal(preview.status, 200);
    const previewPlan = (await preview.json()) as PlanPayload;
    assert.equal(previewPlan.agentsChanged, true);
    assert.equal(previewPlan.assignments.after.developer, 'zcode-fast');
    assert.ok(!('zcode-fast' in previewPlan.agents.before));
    const yamlBeforeSave = fs.readFileSync(path.join(root, '.orca-team-orchestration', 'config.yaml'), 'utf8');
    assert.ok(!yamlBeforeSave.includes('zcode-fast'));

    const saved = await postJson(api(server, '/api/roles'), patch);
    assert.equal(saved.status, 200);
    const savedPayload = (await saved.json()) as SavePayload;
    assert.equal(roleByName(savedPayload.snapshot, 'developer').agent, 'zcode-fast');
    assert.equal(savedPayload.snapshot.agents['zcode-fast']?.kind, 'zcode');

    const fresh = await rolesSnapshot(server);
    assert.equal(fresh.agents['zcode-fast']?.effort, 'low');
    const savedYaml = fs.readFileSync(path.join(root, '.orca-team-orchestration', 'config.yaml'), 'utf8');
    assert.match(savedYaml, /zcode-fast/);
    assert.match(savedYaml, /agent: zcode-fast/);
    assert.match(fs.readFileSync(path.join(root, '.orca-team-orchestration', 'config.yaml.bak'), 'utf8'), /design_review: 3/);

    const badBind = await postJson(api(server, '/api/roles'), {
      baseConfigRevision: fresh.configRevision,
      roles: { developer: { agent: 'ghost' } },
    });
    assert.equal(badBind.status, 422);
    assert.equal(((await badBind.json()) as { error: { message: string } }).error.message.includes('不存在'), true);

    const deleteInUse = await postJson(api(server, '/api/roles/preview'), {
      baseConfigRevision: fresh.configRevision,
      agents: { 'zcode-fast': null },
    });
    assert.equal(deleteInUse.status, 422);
  } finally {
    await stopServer(server);
    cleanup(root);
  }
});
