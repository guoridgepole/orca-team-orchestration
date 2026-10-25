import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { OrcaAdapter, resolveWorktree } from '../src/adapters/orca/adapter.js';
import type { DispatchPlan } from '../src/core/orchestrator.js';
import { cleanup, tempRepo } from './helpers.js';

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = process.cwd();
fs.appendFileSync(path.join(cwd, '.orca-fake-log'), JSON.stringify(args) + '\\n');
const cmd = args[1];
function scenario() {
  try { return fs.readFileSync(path.join(cwd, '.orca-fake-scenario'), 'utf8').trim(); } catch { return 'done'; }
}
function bump() {
  const f = path.join(cwd, '.orca-fake-counter');
  let n = 0;
  try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
  fs.writeFileSync(f, String(n + 1));
  return n;
}
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
const doneMsg = {
  id: 'msg_1', type: 'worker_done', subject: '完成', body: '',
  payload: JSON.stringify({ dispatchId: 'ctx_fake', outcome: scenario() === 'fail' ? 'failed' : 'succeeded', reportPath: 'docs/dev/x.md', filesModified: ['src/a.ts'] }),
  from_handle: 'term_fake',
};
const questionMsg = { id: 'msg_q', type: 'question', subject: '范围确认', body: '需要包含后台吗？', from_handle: 'term_fake' };
if (cmd === 'run-list') return out({ ok: true, result: { runs: [] } });
if (cmd === 'run-create') return out({ ok: true, result: { run: { id: 'run_fake' } } });
if (cmd === 'run-use') return out({ ok: true });
if (cmd === 'worker-start') return out({ ok: true, result: { task: { id: 'task_fake' }, dispatch: { id: 'ctx_fake' }, worker: { agentTerminalHandle: 'term_fake' } } });
if (cmd === 'check') {
  if (args.includes('--ack')) return out({ ok: true, result: { messages: [] } });
  const s = scenario();
  if (s === 'question') {
    const n = bump();
    if (n === 0) return out({ ok: true, result: { messages: [questionMsg], delivery_id: 'del_q' } });
    return out({ ok: true, result: { messages: [doneMsg], delivery_id: 'del_1' } });
  }
  return out({ ok: true, result: { messages: [doneMsg], delivery_id: 'del_1' } });
}
if (cmd === 'reply') return out({ ok: true });
if (cmd === 'task-create') return out({ ok: true, result: { task: { id: 'task_gate' } } });
if (cmd === 'gate-create') return out({ ok: true, result: { gate: { id: 'gate_fake' } } });
if (cmd === 'worker-release') return out({ ok: true });
return out({ ok: true });
`;

const skip = process.platform === 'win32' ? 'skipping POSIX fake orca on Windows' : false;

let root: string;
let fakePath: string;

beforeEach(() => {
  if (skip) return;
  root = tempRepo('adapter');
  fakePath = path.join(root, 'orca-fake');
  fs.writeFileSync(fakePath, FAKE, { mode: 0o755 });
});

afterEach(() => {
  if (skip || !root) return;
  cleanup(root);
});

function adapter(): OrcaAdapter {
  return new OrcaAdapter({ repoRoot: root, worktree: 'path:.', timeoutMs: 5_000, binary: fakePath });
}

function loggedArgs(): string[][] {
  const raw = fs.readFileSync(path.join(root, '.orca-fake-log'), 'utf8').trim();
  return raw ? raw.split('\n').map((line) => JSON.parse(line) as string[]) : [];
}

function plan(overrides: Partial<DispatchPlan> = {}): DispatchPlan {
  return {
    runId: 'run_fake',
    story: 'story-001',
    stage: 'develop',
    role: 'developer',
    round: 1,
    agent: { kind: 'codex', model: 'gpt-x', effort: 'high', args: ['--flag'] },
    prompt: 'DO THE WORK',
    worktree: 'path:.',
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe('resolveWorktree', () => {
  it('path: 相对路径解析为仓库内绝对路径', () => {
    assert.equal(resolveWorktree('path:.', '/repo'), 'path:/repo');
    assert.equal(resolveWorktree('path:sub', '/repo'), 'path:/repo/sub');
    assert.equal(resolveWorktree('branch:feature', '/repo'), 'branch:feature');
    assert.equal(resolveWorktree(undefined, '/repo'), 'path:/repo');
  });
});

describe('Orca adapter', { skip }, () => {
  it('probe 与 createRun/useRun 解析 run id', async () => {
    const a = adapter();
    await a.probe();
    assert.equal(await a.createRun('story-001 午餐抽签'), 'run_fake');
    await a.useRun('run_fake');
    const args = loggedArgs();
    assert.deepEqual(args[0], ['orchestration', 'run-list', '--json']);
    assert.deepEqual(args[1], ['orchestration', 'run-create', '--objective', 'story-001 午餐抽签', '--json']);
    assert.ok(args[2]?.includes('run-use'));
  });

  it('dispatch 构造 worker-start 参数并解析句柄', async () => {
    const a = adapter();
    const handle = await a.dispatch(plan());
    assert.equal(handle.taskId, 'task_fake');
    assert.equal(handle.dispatchId, 'ctx_fake');
    assert.equal(handle.terminalHandle, 'term_fake');
    const start = loggedArgs()[0];
    assert.ok(start.includes('--worktree'), JSON.stringify(start));
    assert.ok(start.includes(`path:${root}`), JSON.stringify(start));
    assert.ok(start.includes('--agent') && start.includes('codex'));
    assert.ok(start.includes('DEVELOP story-001 r1'));
    assert.ok(start.includes('--model') && start.includes('gpt-x'));
    assert.ok(start.includes('--effort') && start.includes('high'));
    assert.ok(start.includes('--flag'));
    assert.equal(start[start.length - 1], '--json');
  });

  it('dispatch 拒绝不受支持的 agent kind', async () => {
    const a = adapter();
    await assert.rejects(() => a.dispatch(plan({ agent: { kind: 'muse' } })), /Orca 不支持 agent kind/);
  });

  it('wait 返回 succeeded 并 ack + release', async () => {
    const a = adapter();
    const handle = { runId: 'run_fake', taskId: 'task_fake', dispatchId: 'ctx_fake', terminalHandle: 'term_fake' };
    const result = await a.wait(handle, { timeoutMs: 5_000 });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.reportPath, 'docs/dev/x.md');
    assert.deepEqual(result.filesModified, ['src/a.ts']);
    const args = loggedArgs();
    assert.ok(args.some((line) => line.includes('--ack') && line.includes('del_1')), '应 ack');
    assert.ok(args.some((line) => line[1] === 'worker-release' && line.includes('ctx_fake')), '应 release');
  });

  it('wait 在 question 无回复时返回 blocked 且不 release', async () => {
    fs.writeFileSync(path.join(root, '.orca-fake-scenario'), 'question');
    const a = adapter();
    const handle = { runId: 'run_fake', taskId: 'task_fake', dispatchId: 'ctx_fake' };
    const result = await a.wait(handle, { timeoutMs: 5_000, onQuestion: async () => null });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.question ?? '', /需要包含后台吗/);
    const args = loggedArgs();
    assert.ok(!args.some((line) => line[1] === 'worker-release'), 'blocked 不应 release');
  });

  it('wait 回答 question 后继续等到 done', async () => {
    fs.writeFileSync(path.join(root, '.orca-fake-scenario'), 'question');
    const a = adapter();
    const handle = { runId: 'run_fake', taskId: 'task_fake', dispatchId: 'ctx_fake' };
    let asked = '';
    const result = await a.wait(handle, {
      timeoutMs: 5_000,
      onQuestion: async (q) => {
        asked = q.subject;
        return '仅前端';
      },
    });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(asked, '范围确认');
    const reply = loggedArgs().find((line) => line[1] === 'reply');
    assert.ok(reply && reply.includes('--body') && reply.includes('仅前端'), JSON.stringify(reply));
  });

  it('worker outcome=failed 被映射为 failed', async () => {
    fs.writeFileSync(path.join(root, '.orca-fake-scenario'), 'fail');
    const a = adapter();
    const handle = { runId: 'run_fake', taskId: 'task_fake', dispatchId: 'ctx_fake' };
    const result = await a.wait(handle, { timeoutMs: 5_000 });
    assert.equal(result.outcome, 'failed');
  });

  it('createGate 先建 task 再建 gate', async () => {
    const a = adapter();
    const gateId = await a.createGate(
      { stage: 'review', round: 1, question: '要放行吗？', options: ['放行', '退回'] },
      'run_fake',
    );
    assert.equal(gateId, 'gate_fake');
    const args = loggedArgs();
    assert.ok(args.some((line) => line[1] === 'task-create'));
    const gate = args.find((line) => line[1] === 'gate-create');
    assert.ok(gate && gate.includes('--task') && gate.includes('task_gate'));
    assert.ok(gate && gate.includes(JSON.stringify(['放行', '退回'])));
  });
});
