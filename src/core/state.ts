import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { readText, writeText } from './paths.js';
import type { Story } from './story.js';

export type StageStatus = 'running' | 'passed' | 'rejected' | 'failed' | 'gate';

export interface RunStageState {
  round: number;
  status: StageStatus;
  artifact?: string;
}

export interface RunHistoryEntry {
  stage: string;
  round: number;
  outcome: string;
  report?: string;
}

export interface PendingDispatch {
  runId: string;
  taskId?: string;
  dispatchId?: string;
  terminalHandle?: string;
  stage: string;
  role: string;
  round: number;
  baseline?: string[];
}

export interface RunGate {
  stage: string;
  round: number;
  reason: string;
  question: string;
  gateId?: string;
  createdAt: string;
}

export interface RunState {
  version: 1;
  story: string;
  title: string;
  runId: string;
  orchestrator: string;
  startedAt: string;
  spec: {
    source: string;
    snapshot: string;
    sha256: string;
  };
  features: string[];
  acceptance: string[];
  stages: Record<string, RunStageState>;
  history: RunHistoryEntry[];
  acceptedAt?: string;
  orca?: { runId: string };
  pending?: PendingDispatch;
  gate?: RunGate;
}

export function runsDir(root: string): string {
  return path.join(root, '.orca-team-orchestration', 'runs');
}

export function statePath(root: string, story: string): string {
  return path.join(runsDir(root), `${story}.json`);
}

export function specSnapshotPath(root: string, story: string): string {
  return path.join(runsDir(root), story, 'spec.md');
}

export function readState(root: string, story: string): RunState | null {
  const raw = readText(statePath(root, story));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export function writeState(root: string, state: RunState): void {
  writeText(statePath(root, state.story), `${JSON.stringify(state, null, 2)}\n`);
}

export function listStates(root: string): RunState[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir(root), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const states: RunState[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const story = entry.name.slice(0, -'.json'.length);
    const state = readState(root, story);
    if (state) states.push(state);
  }
  return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function snapshotSpec(
  root: string,
  story: string,
  sourceContent: string,
  featuresDir = 'features',
): RunState['spec'] {
  const normalized = sourceContent.replace(/\r\n/g, '\n');
  const snapshotAbs = specSnapshotPath(root, story);
  writeText(snapshotAbs, normalized);
  return {
    source: path.posix.join(featuresDir.split(path.sep).join('/').replace(/\/+$/, ''), `${story}.md`),
    snapshot: path.relative(root, snapshotAbs).split(path.sep).join('/'),
    sha256: hashContent(normalized),
  };
}

export function specHashMatches(root: string, state: RunState): boolean {
  const source = readText(path.join(root, state.spec.source));
  if (source === null) return false;
  return hashContent(source) === state.spec.sha256;
}

export function storyStatus(
  state: RunState | null,
  config?: Config,
): '未开始' | '进行中' | '待验收' | '已验收' {
  if (!state) return '未开始';
  if (state.acceptedAt) return '已验收';
  if (stagePassed(state, 'test')) return config?.flow.accept === null ? '已验收' : '待验收';
  if (config?.flow.test === null && stagePassed(state, 'develop')) {
    return config?.flow.accept === null ? '已验收' : '待验收';
  }
  return '进行中';
}

function stagePassed(state: RunState, stage: string): boolean {
  return state.stages[stage]?.status === 'passed';
}

export function nextStage(config: Config, state: RunState): string {
  if (state.acceptedAt) return 'done';
  if (!stagePassed(state, 'design')) return 'design';
  if (config.flow.review !== null && !stagePassed(state, 'review')) return 'review';
  if (!stagePassed(state, 'develop')) return 'develop';
  if (config.flow.test !== null && !stagePassed(state, 'test')) return 'test';
  if (config.flow.accept === null) return 'done';
  return 'accept';
}

export function buildRunState(
  config: Config,
  story: Story,
  spec: RunState['spec'],
  orchestrator: string,
): RunState {
  return {
    version: 1,
    story: story.id,
    title: story.title,
    runId: crypto.randomUUID(),
    orchestrator,
    startedAt: new Date().toISOString(),
    spec,
    features: story.features.map((feature) => feature.id),
    acceptance: story.acceptance.map((item) => item.id),
    stages: {},
    history: [],
  };
}

export function stageRound(state: RunState, stage: string): number {
  return state.stages[stage]?.round ?? 0;
}
