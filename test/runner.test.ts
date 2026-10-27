import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { roleArtifactPath } from '../src/core/checks.js';
import type { Config } from '../src/core/config.js';
import { builtinDefaults } from '../src/core/config.js';
import { EXIT } from '../src/core/errors.js';
import type {
  DispatchHandle,
  DispatchPlan,
  DispatchResult,
  GateRequest,
  Orchestrator,
  PendingInspection,
  WaitOptions,
} from '../src/core/orchestrator.js';
import { runStory } from '../src/core/runner.js';
import { buildRunState, snapshotSpec, writeState, type RunState } from '../src/core/state.js';
import { loadStory } from '../src/core/story.js';
import { runGit } from '../src/core/git.js';
import {
  cleanup,
  commitAll,
  tempRepo,
  tempWorkspace,
  VALID_STORY,
  workspaceConfig,
  write,
} from './helpers.js';

interface WaitDescriptor {
  stage: string;
  role: string;
  round: number;
  story: string;
  resuming: boolean;
}

type Worker = (d: WaitDescriptor) => DispatchResult;

const TASK = 'task';

function taskId(stage: string, role: string, round: number): string {
  return `${TASK}_${stage}_${role}_r${round}`;
}

function parseHandle(handle: DispatchHandle): { stage: string; role: string; round: number } {
  const match = /^task_(.+?)_(.+?)_r(\d+)$/.exec(handle.taskId ?? '');
  if (!match) throw new Error(`bad handle: ${handle.taskId}`);
  return { stage: match[1]!, role: match[2]!, round: Number(match[3]) };
}

class StubOrchestrator implements Orchestrator {
  readonly name = 'orca' as const;
  dispatches: DispatchPlan[] = [];
  gates: GateRequest[] = [];
  released: DispatchHandle[] = [];
  createRunCalls = 0;
  useRunCalls = 0;
  pendingStatus: PendingInspection = { state: 'running' };
  constructor(private readonly worker: Worker) {}

  async probe(): Promise<void> {}
  async createRun(): Promise<string> {
    this.createRunCalls += 1;
    return 'run_stub';
  }
  async useRun(): Promise<void> {
    this.useRunCalls += 1;
  }
  async inspect(): Promise<PendingInspection> {
    return this.pendingStatus;
  }
  async dispatch(plan: DispatchPlan): Promise<DispatchHandle> {
    this.dispatches.push(plan);
    return {
      runId: plan.runId,
      taskId: taskId(plan.stage, plan.role, plan.round),
      dispatchId: `ctx_${plan.stage}_${plan.role}_r${plan.round}`,
    };
  }
  async wait(handle: DispatchHandle, _options: WaitOptions): Promise<DispatchResult> {
    const parsed = parseHandle(handle);
    const resuming = !this.dispatches.some(
      (p) => p.stage === parsed.stage && p.role === parsed.role && p.round === parsed.round,
    );
    const result = this.worker({ ...parsed, story: 'story-0.1.0-001', resuming });
    if (result.outcome === 'succeeded' || result.outcome === 'failed') this.released.push(handle);
    return result;
  }
  async reply(): Promise<void> {}
  async createGate(request: GateRequest): Promise<string | null> {
    this.gates.push(request);
    return 'gate_stub';
  }
  async release(handle: DispatchHandle): Promise<void> {
    if (!this.released.includes(handle)) this.released.push(handle);
  }
}

function designArtifact(d: WaitDescriptor): string {
  return `# 设计 r${d.round}\n\n## 目标\n\n抽签。\n\n## 验收映射\n\n- story-0.1.0-001-1\n\n## 数据库变更\n\n无。\n\n## 失败路径\n\n无菜可选。\n\n## 回滚\n\n删除页面。\n`;
}

function reviewArtifact(verdict: string, d: WaitDescriptor): string {
  return `${verdict}\n\n# 评审 r${d.round}\n\n## 问题清单\n\n- 缺少失败路径章节\n\n## 通过条件\n\n- 全部满足\n`;
}

function devArtifact(d: WaitDescriptor): string {
  return `# 开发 r${d.round}\n\n## 变更\n\n- 页面\n\n## 自测\n\n- 手动\n\n## SQL\n\n无\n`;
}

function testArtifact(verdict: string, d: WaitDescriptor): string {
  return `${verdict}\n\n# 测试 r${d.round}\n\n## 用例结果\n\n- 通过\n\n## 证据\n\n- 截图\n`;
}

function writeArtifact(root: string, config: Config, d: WaitDescriptor, verdict = 'PASS'): string {
  const rel = roleArtifactPath(config, d.role, d.story, d.round);
  assert.ok(rel, `no artifact path for ${d.role}`);
  let content: string;
  if (d.stage === 'design') content = designArtifact(d);
  else if (d.stage === 'review') content = reviewArtifact(verdict, d);
  else if (d.stage === 'develop') content = devArtifact(d);
  else content = testArtifact(verdict, d);
  write(root, rel, content);
  return rel;
}

function setupRepo(config: Config): { root: string; state: RunState } {
  const root = tempRepo('runner');
  write(root, 'package.json', JSON.stringify({ scripts: { dev: 'node app.js', test: 'node --test' } }));
  write(root, 'app.js', 'console.log("hi");\n');
  write(root, `features/story-0.1.0-001.md`, VALID_STORY);
  commitAll(root, 'baseline');
  const parsed = loadStory(root, config.project.paths.features_dir, 'story-0.1.0-001');
  const spec = snapshotSpec(root, 'story-0.1.0-001', VALID_STORY);
  const state = buildRunState(config, parsed, spec, 'orca');
  writeState(root, state);
  return { root, state };
}

function run(
  root: string,
  config: Config,
  state: RunState,
  worker: Worker,
  pendingStatus?: PendingInspection,
) {
  const orchestrator = new StubOrchestrator(worker);
  if (pendingStatus) orchestrator.pendingStatus = pendingStatus;
  const logs: string[] = [];
  return runStory({
    root,
    config,
    state,
    orchestrator,
    log: (line) => logs.push(line),
  }).then((result) => ({ result, orchestrator, logs }));
}

function gitLog(root: string): string {
  const r = spawnSync('git', ['-C', root, 'log', '--format=%s'], { encoding: 'utf8' });
  return r.stdout ?? '';
}

describe('runner 阶段闭环', () => {
  it('design → review → develop → test 全部通过后停在 accept', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    try {
      const { result, orchestrator, logs } = await run(root, config, state, (d) => {
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.ok);
      assert.equal(result.state.stages.design?.status, 'passed');
      assert.equal(result.state.stages.review?.status, 'passed');
      assert.equal(result.state.stages.develop?.status, 'passed');
      assert.equal(result.state.stages.test?.status, 'passed');
      assert.match(logs.join('\n'), /等待需求方验收/);
      assert.equal(orchestrator.createRunCalls, 1);
      assert.match(gitLog(root), /stage: design story-0.1.0-001 r1/);
      assert.match(gitLog(root), /stage: test story-0.1.0-001 r1/);
    } finally {
      cleanup(root);
    }
  });

  it('review REJECT 回到 design 下一轮并携带上一轮报告', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    try {
      const { result, orchestrator } = await run(root, config, state, (d) => {
        const verdict = d.stage === 'review' && d.round === 1 ? 'REJECT' : 'PASS';
        const rel = writeArtifact(root, config, d, verdict);
        return { outcome: 'succeeded', summary: verdict, reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.ok);
      assert.equal(result.state.stages.design?.round, 2);
      assert.equal(result.state.stages.review?.round, 2);
      assert.ok(result.state.history.some((h) => h.stage === 'review' && h.round === 1 && h.outcome === 'reject'));
      const designR2 = orchestrator.dispatches.find((p) => p.stage === 'design' && p.round === 2);
      assert.ok(designR2, 'design r2 应被派发');
      assert.match(designR2.prompt, /缺少失败路径章节/);
      const reviewR1 = orchestrator.dispatches.find((p) => p.stage === 'review' && p.round === 1);
      assert.ok(reviewR1);
    } finally {
      cleanup(root);
    }
  });

  it('test FAIL 回到 develop 下一轮', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    try {
      const { result } = await run(root, config, state, (d) => {
        const verdict = d.stage === 'test' && d.round === 1 ? 'FAIL' : 'PASS';
        const rel = writeArtifact(root, config, d, verdict);
        return { outcome: 'succeeded', summary: verdict, reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.ok);
      assert.equal(result.state.stages.develop?.round, 2);
      assert.equal(result.state.stages.test?.round, 2);
      assert.ok(result.state.history.some((h) => h.stage === 'test' && h.round === 1 && h.outcome === 'fail'));
    } finally {
      cleanup(root);
    }
  });

  it('达到轮次上限时创建 gate 并返回 7', async () => {
    const config = builtinDefaults('demo');
    config.runtime.max_rounds.design_review = 1;
    const { root, state } = setupRepo(config);
    try {
      const { result, orchestrator, logs } = await run(root, config, state, (d) => {
        const verdict = d.stage === 'review' ? 'REJECT' : 'PASS';
        const rel = writeArtifact(root, config, d, verdict);
        return { outcome: 'succeeded', summary: verdict, reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.gate);
      assert.equal(result.state.gate?.stage, 'review');
      assert.equal(result.state.stages.review?.status, 'gate');
      assert.equal(orchestrator.gates.length, 1);
      assert.match(orchestrator.gates[0]!.question, /上限 1/);
      assert.match(logs.join('\n'), /GATE：review r1/);
    } finally {
      cleanup(root);
    }
  });

  it('worker 返回 blocked 问题时进入 gate', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    try {
      const { result } = await run(root, config, state, (d) => {
        if (d.stage === 'review') {
          return { outcome: 'blocked', summary: '需要决定范围', question: '范围应包含后台吗？' };
        }
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.gate);
      assert.equal(result.state.gate?.stage, 'review');
      assert.match(result.state.gate!.question, /范围应包含后台吗/);
    } finally {
      cleanup(root);
    }
  });

  it('命令检查未通过会阻止阶段通过并触发 gate', async () => {
    const config = builtinDefaults('demo');
    config.runtime.max_rounds.design_review = 1;
    config.roles.designer!.run_checks = ['fail'];
    config.checks.fail = { command: 'exit 3', required: true };
    const { root, state } = setupRepo(config);
    try {
      const { result, logs } = await run(root, config, state, (d) => {
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.gate);
      assert.equal(result.state.gate?.stage, 'design');
      assert.match(logs.join('\n'), /COMMAND FAIL/);
      const logFile = path.join(root, '.orca-team-orchestration', 'runs', 'story-0.1.0-001', 'checks', 'design-r1-designer-fail.log');
      assert.ok(fs.existsSync(logFile), '命令日志应写入 runs/checks');
    } finally {
      cleanup(root);
    }
  });

  it('空命令检查被跳过并告警，不阻止阶段通过', async () => {
    const config = builtinDefaults('demo');
    config.roles.designer!.run_checks = ['project-test'];
    const { root, state } = setupRepo(config);
    try {
      const { result, logs } = await run(root, config, state, (d) => {
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.ok);
      assert.match(logs.join('\n'), /warning: .*project-test.*已跳过/);
    } finally {
      cleanup(root);
    }
  });

  it('worker outcome=failed 视为阶段失败', async () => {
    const config = builtinDefaults('demo');
    config.runtime.max_rounds.design_review = 1;
    const { root, state } = setupRepo(config);
    try {
      const { result, logs } = await run(root, config, state, (d) => {
        const rel = writeArtifact(root, config, d);
        return { outcome: d.stage === 'design' ? 'failed' : 'succeeded', summary: 'worker 崩溃', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.gate);
      assert.match(logs.join('\n'), /WORKER FAIL/);
      assert.notEqual(result.state.stages.design?.status, 'passed');
    } finally {
      cleanup(root);
    }
  });

  it('等待超时会保留 pending 并返回 4', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    try {
      const { result } = await run(root, config, state, () => ({ outcome: 'timeout', summary: '超时' }));
      assert.equal(result.exitCode, EXIT.orchestrator);
      assert.ok(result.state.pending, '超时应保留未完成派发');
      assert.equal(result.state.pending?.stage, 'design');
    } finally {
      cleanup(root);
    }
  });

  it('resume 继续等待未完成的派发而不重新 dispatch', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    state.orca = { runId: 'run_stub' };
    state.stages.design = { round: 1, status: 'running' };
    state.pending = {
      runId: 'run_stub',
      taskId: taskId('design', 'designer', 1),
      dispatchId: 'ctx_design_designer_r1',
      stage: 'design',
      role: 'designer',
      round: 1,
      baseline: [],
    };
    writeState(root, state);
    try {
      const { result, orchestrator } = await run(root, config, state, (d) => {
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.ok);
      assert.equal(orchestrator.useRunCalls, 1);
      assert.equal(orchestrator.createRunCalls, 0);
      assert.ok(!orchestrator.dispatches.some((p) => p.stage === 'design'), 'design 不应重新派发');
      assert.ok(orchestrator.dispatches.some((p) => p.stage === 'review'));
    } finally {
      cleanup(root);
    }
  });

  it('resume 时未完成的派发已退出则重开同一任务', async () => {
    const config = builtinDefaults('demo');
    const { root, state } = setupRepo(config);
    state.orca = { runId: 'run_stub' };
    state.stages.design = { round: 1, status: 'running' };
    state.pending = {
      runId: 'run_stub',
      taskId: taskId('design', 'designer', 1),
      dispatchId: 'ctx_design_designer_r1',
      stage: 'design',
      role: 'designer',
      round: 1,
      baseline: [],
    };
    writeState(root, state);
    try {
      const { result, orchestrator, logs } = await run(
        root,
        config,
        state,
        (d) => {
          const rel = writeArtifact(root, config, d);
          return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
        },
        { state: 'lost', reason: 'failed/failed/process_exited（task ready）', resume: { taskId: taskId('design', 'designer', 1) } },
      );
      assert.equal(result.exitCode, EXIT.ok);
      const design = orchestrator.dispatches.find((p) => p.stage === 'design');
      assert.ok(design, 'design 应重新派发');
      assert.deepEqual(design.resume, { taskId: taskId('design', 'designer', 1) });
      assert.match(logs.join('\n'), /未完成的派发已结束.*重新派发/);
    } finally {
      cleanup(root);
    }
  });
});

function setupWorkspace(): { root: string; api: string; config: Config; state: RunState } {
  const ws = tempWorkspace();
  const config = workspaceConfig({
    project: { paths: { source: ['api/src/**'], tests: ['api/test/**'] } },
  });
  write(ws.root, `features/story-0.1.0-001.md`, VALID_STORY);
  runGit(ws.root, ['add', 'features/story-0.1.0-001.md']);
  runGit(ws.root, ['commit', '-q', '-m', 'baseline']);
  const parsed = loadStory(ws.root, config.project.paths.features_dir, 'story-0.1.0-001');
  const spec = snapshotSpec(ws.root, 'story-0.1.0-001', VALID_STORY, config.project.paths.features_dir);
  const state = buildRunState(config, parsed, spec, 'orca');
  writeState(ws.root, state);
  return { root: ws.root, api: ws.api, config, state };
}

describe('runner 多仓', () => {
  it('worker 同时改根仓文档与子仓源码时逐仓生成检查点', async () => {
    const { root, api, config, state } = setupWorkspace();
    try {
      const { result, logs } = await run(root, config, state, (d) => {
        if (d.stage === 'develop') write(api, 'src/app.ts', 'export const pick = () => 1;\n');
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.ok);
      const output = logs.join('\n');
      assert.match(output, /检查点提交 workspace@/);
      assert.match(output, /检查点提交 api@/);
      assert.match(gitLog(root), /stage: develop story-0.1.0-001 r1/);
      assert.match(gitLog(api), /stage: develop story-0.1.0-001 r1/);
    } finally {
      cleanup(root);
    }
  });

  it('改动未授权的子仓路径会触发 scope 失败', async () => {
    const { root, api, config, state } = setupWorkspace();
    config.runtime.max_rounds.dev_test = 1;
    try {
      const { result, logs } = await run(root, config, state, (d) => {
        if (d.stage === 'develop') write(api, 'secret.txt', 'leak\n');
        const rel = writeArtifact(root, config, d);
        return { outcome: 'succeeded', summary: 'ok', reportPath: rel };
      });
      assert.equal(result.exitCode, EXIT.gate);
      assert.equal(result.state.gate?.stage, 'develop');
      assert.match(logs.join('\n'), /SCOPE FAIL.*api\/secret\.txt/);
      assert.doesNotMatch(gitLog(api), /stage: develop story-0.1.0-001 r1/);
    } finally {
      cleanup(root);
    }
  });
});
