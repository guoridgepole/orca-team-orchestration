import path from 'node:path';
import {
  artifactFirstLine,
  artifactIssuesForRole,
  roleArtifactPath,
  scopeIssuesForWorkspace,
  workspaceDirtyPaths,
} from './checks.js';
import { settleViolations } from './approvals.js';
import { runRoleCommandChecks } from './commands.js';
import type { Config } from './config.js';
import { stageRoles } from './config.js';
import { EXIT } from './errors.js';
import { checkpointCommits } from './git.js';
import { formatViolations, runGuards } from './guards.js';
import type { Orchestrator } from './orchestrator.js';
import { readText } from './paths.js';
import { renderRolePrompt } from './prompts.js';
import { nextStage, writeState, type RunState } from './state.js';
import { workspaceLayout } from './workspace.js';

export interface RunnerOptions {
  root: string;
  config: Config;
  state: RunState;
  orchestrator: Orchestrator;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  log?: (line: string) => void;
}

export interface RunResult {
  exitCode: number;
  state: RunState;
}

type StageOutcome = { kind: 'passed' } | { kind: 'retry' } | { kind: 'exit'; exitCode: number };

function loopStages(stage: string): [string, string] {
  return stage === 'design' || stage === 'review' ? ['design', 'review'] : ['develop', 'test'];
}

function maxRounds(config: Config, stage: string): number {
  return stage === 'design' || stage === 'review'
    ? config.runtime.max_rounds.design_review
    : config.runtime.max_rounds.dev_test;
}

function routeStage(stage: string): string {
  if (stage === 'review') return 'design';
  if (stage === 'test') return 'develop';
  return stage;
}

function ensureRound(config: Config, state: RunState, stage: string): number {
  const loop = loopStages(stage);
  const round = Math.max(1, ...loop.map((item) => state.stages[item]?.round ?? 0));
  for (const item of loop) {
    if (stageRoles(config, item).length === 0) continue;
    const existing = state.stages[item];
    if (!existing) {
      state.stages[item] = { round, status: 'running' };
    } else if (existing.round < round) {
      existing.round = round;
      if (existing.status !== 'passed') existing.status = 'running';
    }
  }
  return state.stages[stage]?.round ?? round;
}

function historyReport(state: RunState, stage: string, round?: number): string | undefined {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const entry = state.history[index]!;
    if (entry.stage !== stage) continue;
    if (round !== undefined && entry.round !== round) continue;
    if (entry.report) return entry.report;
  }
  return undefined;
}

function previousArtifactFor(config: Config, state: RunState, stage: string, round: number): string | undefined {
  if (stage === 'design') {
    return round > 1 ? historyReport(state, 'review', round - 1) ?? historyReport(state, 'review') : undefined;
  }
  if (stage === 'review') {
    return roleArtifactPath(config, config.flow.design, state.story, round) ?? undefined;
  }
  if (stage === 'develop') {
    return round > 1 ? historyReport(state, 'test', round - 1) ?? historyReport(state, 'test') : undefined;
  }
  if (stage === 'test') {
    return roleArtifactPath(config, config.flow.develop, state.story, round) ?? undefined;
  }
  return undefined;
}

function normalizeReport(root: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
  return path.relative(root, absolute).split(path.sep).join('/');
}

export async function runStory(options: RunnerOptions): Promise<RunResult> {
  const { root, config, state, orchestrator } = options;
  const log = options.log ?? (() => {});
  if (state.acceptedAt) return { exitCode: EXIT.ok, state };
  if (state.gate) {
    log(`已存在 gate：${state.gate.stage} r${state.gate.round} ${state.gate.question}`);
    return { exitCode: EXIT.gate, state };
  }

  await orchestrator.probe();
  if (!state.orca?.runId) {
    state.orca = { runId: await orchestrator.createRun(`${state.story} ${state.title}`) };
    writeState(root, state);
    log(`Orca run：${state.orca.runId}`);
  } else {
    await orchestrator.useRun(state.orca.runId);
  }

  while (true) {
    if (state.acceptedAt) return { exitCode: EXIT.ok, state };
    if (state.gate) return { exitCode: EXIT.gate, state };
    const stage = nextStage(config, state);
    if (stage === 'done') return { exitCode: EXIT.ok, state };
    if (stage === 'accept') {
      log('所有阶段已通过，等待需求方验收：orca-team-orchestration accept ' + state.story);
      return { exitCode: EXIT.ok, state };
    }
    ensureRound(config, state, stage);
    writeState(root, state);
    const result = await runStage(options, stage);
    if (result.kind === 'exit') return { exitCode: result.exitCode, state };
  }
}

async function runStage(options: RunnerOptions, stage: string): Promise<StageOutcome> {
  const { root, config, state, orchestrator } = options;
  const log = options.log ?? (() => {});
  const roles = stageRoles(config, stage);
  const round = state.stages[stage]?.round ?? 1;
  const artifacts: string[] = [];
  const layout = workspaceLayout(root, config);

  for (const roleName of roles) {
    const role = config.roles[roleName];
    if (!role) continue;
    const agent = config.agents[role.agent];
    if (!agent) {
      throw new Error(`角色 ${roleName} 引用了不存在的 agent：${role.agent}`);
    }

    let pending = state.pending;
    if (
      pending &&
      (pending.stage !== stage || pending.role !== roleName || pending.round !== round)
    ) {
      log(`warning: 忽略不匹配的未完成派发 ${pending.stage}/${pending.role} r${pending.round}`);
      state.pending = undefined;
      pending = undefined;
    }

    if (!pending) {
      const previousArtifact = previousArtifactFor(config, state, stage, round);
      const rendered = renderRolePrompt(root, config, roleName, {
        story: state.story,
        round,
        stage,
        ...(previousArtifact ? { previousArtifact } : {}),
      });
      for (const warning of rendered.warnings) log(`warning: ${warning}`);
      const timeoutMs = config.runtime.timeout_minutes * 60_000;
      const baseline = [...workspaceDirtyPaths(layout)];
      log(`派发 ${stage} ${roleName} r${round}（${agent.kind}${agent.model ? `/${agent.model}` : ''}）`);
      const handle = await orchestrator.dispatch({
        runId: state.orca!.runId,
        story: state.story,
        stage,
        role: roleName,
        round,
        agent,
        prompt: rendered.prompt,
        worktree: config.runtime.worktree ?? 'path:.',
        timeoutMs,
      });
      state.pending = {
        ...handle,
        stage,
        role: roleName,
        round,
        baseline,
      };
      writeState(root, state);
      pending = state.pending;
      log(`  已启动：${handle.taskId ?? '(task)'} / ${handle.dispatchId ?? '(dispatch)'}`);
    } else {
      log(`继续等待未完成的派发：${stage} ${roleName} r${round}`);
    }

    const scopeIgnore = new Set(pending.baseline ?? []);

    const result = await orchestrator.wait(pending, {
      timeoutMs: config.runtime.timeout_minutes * 60_000,
      onQuestion: async (question) => {
        const text = [question.subject, question.body].filter(Boolean).join('\n');
        if (!options.interactive || !options.ask) return null;
        const answer = await options.ask(`\n[${question.type}] ${text}\n回复（留空转 gate）: `);
        return answer.trim() === '' ? null : answer;
      },
    });

    if (result.outcome === 'timeout') {
      log(`超时：${stage} ${roleName} r${round}；状态已保留，可用 resume 继续等待`);
      return { kind: 'exit', exitCode: EXIT.orchestrator };
    }
    if (result.outcome === 'blocked') {
      const gate = await openGate(
        options,
        stage,
        round,
        [result.summary, result.question].filter(Boolean).join('\n'),
      );
      return { kind: 'exit', exitCode: gate };
    }

    state.pending = undefined;
    const report = normalizeReport(root, result.reportPath);
    log(`完成 ${stage} ${roleName} r${round}：${result.outcome}${result.summary ? ` — ${result.summary}` : ''}`);

    const artifactIssues = artifactIssuesForRole(root, config, roleName, state.story, round);
    const scope = scopeIssuesForWorkspace(layout, config, stage, scopeIgnore);
    const guards = settleViolations(root, runGuards(root, config.guards, { layout }), layout).blocking;
    const commands = runRoleCommandChecks(root, config, roleName, stage, state.story, round);
    const issues = [...artifactIssues, ...scope, ...commands.issues];

    const relative = roleArtifactPath(config, roleName, state.story, round);
    const verdict = relative ? artifactFirstLine(readText(path.join(root, relative)) ?? '') : null;
    const rejected = (stage === 'review' && verdict === 'REJECT') || (stage === 'test' && verdict === 'FAIL');
    const reportPath = report ?? relative ?? undefined;

    if (issues.length === 0 && guards.length === 0 && !rejected && result.outcome !== 'failed') {
      if (relative) {
        artifacts.push(relative);
        state.stages[stage] = { round, status: 'running', artifact: relative };
      }
      state.history.push({
        stage,
        round,
        outcome: result.outcome,
        ...(reportPath ? { report: reportPath } : {}),
      });
      writeState(root, state);
      continue;
    }

    const outcome = rejected ? (stage === 'review' ? 'reject' : 'fail') : `invalid:${result.outcome}`;
    state.history.push({
      stage,
      round,
      outcome,
      ...(reportPath ? { report: reportPath } : {}),
    });
    for (const issue of artifactIssues) log(`ARTIFACT FAIL  ${issue.message}`);
    for (const issue of scope) log(`SCOPE FAIL     ${issue.message}`);
    if (guards.length > 0) log(`GUARD FAIL\n${formatViolations(guards)}`);
    for (const issue of commands.issues) log(`COMMAND FAIL   ${issue.message}`);
    if (rejected) log(`VERDICT ${verdict}`);
    if (result.outcome === 'failed') log(`WORKER FAIL    ${result.summary}`);

    const limit = maxRounds(config, stage);
    if (round >= limit) {
      const question = [
        `${stage} 第 ${round} 轮未通过（上限 ${limit}）。`,
        rejected ? `产物结论：${verdict}` : '',
        ...issues.map((issue) => `- ${issue.message}`),
        ...(guards.length > 0 ? [`- 守则：\n${formatViolations(guards)}`] : []),
        '请选择下一步。',
      ]
        .filter(Boolean)
        .join('\n');
      const gate = await openGate(options, stage, round, question);
      return { kind: 'exit', exitCode: gate };
    }

    const nextRound = round + 1;
    const route = routeStage(stage);
    const loop = loopStages(stage);
    for (const item of loop) {
      if (stageRoles(config, item).length === 0) continue;
      state.stages[item] = { round: nextRound, status: 'running' };
    }
    state.stages[route] = { round: nextRound, status: 'running' };
    writeState(root, state);
    log(`${stage} r${round} 未通过，进入 ${route} r${nextRound}`);
    return { kind: 'retry' };
  }

  state.stages[stage] = {
    round,
    status: 'passed',
    ...(artifacts[0] ? { artifact: artifacts[0] } : {}),
  };
  writeState(root, state);
  if (config.runtime.checkpoint_commits) {
    const commits = checkpointCommits(layout, `stage: ${stage} ${state.story} r${round}`, {
      managedPaths: [config.project.paths.features_dir, config.project.paths.docs, config.project.paths.evidence],
    });
    for (const commit of commits) log(`检查点提交 ${commit.repo}@${commit.sha}`);
  }
  log(`阶段通过：${stage} r${round}`);
  return { kind: 'passed' };
}

async function openGate(options: RunnerOptions, stage: string, round: number, question: string): Promise<number> {
  const { root, config, state, orchestrator } = options;
  const log = options.log ?? (() => {});
  state.stages[stage] = { round, status: 'gate' };
  state.gate = {
    stage,
    round,
    reason: question,
    question,
    createdAt: new Date().toISOString(),
  };
  if (state.orca?.runId) {
    try {
      const gateId = await orchestrator.createGate(
        {
          stage,
          round,
          question,
          options: ['接受现状', '再给一轮', '修改需求', '终止'],
        },
        state.orca.runId,
      );
      if (gateId) state.gate.gateId = gateId;
    } catch (error) {
      log(`warning: 无法创建 Orca gate：${(error as Error).message}`);
    }
  }
  writeState(root, state);
  log(`GATE：${stage} r${round}`);
  log(question);
  log(`处理后执行 resume；状态文件：.orca-team-orchestration/runs/${state.story}.json`);
  return EXIT.gate;
}

