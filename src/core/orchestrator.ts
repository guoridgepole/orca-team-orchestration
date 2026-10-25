import type { AgentConfig } from './config.js';

export type Outcome = 'succeeded' | 'failed' | 'blocked' | 'timeout';

export interface DispatchPlan {
  runId: string;
  story: string;
  stage: string;
  role: string;
  round: number;
  agent: AgentConfig;
  prompt: string;
  worktree: string;
  timeoutMs: number;
}

export interface DispatchHandle {
  runId: string;
  taskId?: string;
  dispatchId?: string;
  terminalHandle?: string;
}

export interface DispatchQuestion {
  messageId: string;
  type: string;
  subject: string;
  body: string;
}

export interface DispatchResult {
  outcome: Outcome;
  summary: string;
  messageId?: string;
  reportPath?: string;
  filesModified?: string[];
  question?: string;
}

export interface WaitOptions {
  timeoutMs: number;
  onQuestion?: (question: DispatchQuestion) => Promise<string | null>;
}

export interface GateRequest {
  stage: string;
  round: number;
  question: string;
  options: string[];
}

export interface Orchestrator {
  readonly name: 'orca';
  probe(): Promise<void>;
  createRun(objective: string): Promise<string>;
  useRun(runId: string): Promise<void>;
  dispatch(plan: DispatchPlan): Promise<DispatchHandle>;
  wait(handle: DispatchHandle, options: WaitOptions): Promise<DispatchResult>;
  reply(messageId: string, body: string): Promise<void>;
  createGate(request: GateRequest, runId: string): Promise<string | null>;
  release(handle: DispatchHandle): Promise<void>;
}
