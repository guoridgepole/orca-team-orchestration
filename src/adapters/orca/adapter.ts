import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { AGENT_KINDS } from '../../core/config.js';
import { CliError, EXIT } from '../../core/errors.js';
import { resolveOrcaBinary } from '../../core/orca.js';
import type {
  DispatchHandle,
  DispatchPlan,
  DispatchQuestion,
  DispatchResult,
  GateRequest,
  Orchestrator,
  WaitOptions,
} from '../../core/orchestrator.js';

type JsonObject = Record<string, unknown>;

interface OrcaMessage {
  id?: string;
  type?: string;
  subject?: string;
  body?: string;
  payload?: unknown;
  from_handle?: string;
}

interface MessageBatch {
  messages: OrcaMessage[];
  ackId?: string;
}

const ORCA_AGENTS = new Set<string>(AGENT_KINDS);

export interface OrcaAdapterOptions {
  repoRoot: string;
  worktree: string;
  timeoutMs: number;
  binary?: string;
}

export function resolveWorktree(selector: string | undefined, repoRoot: string): string {
  const value = selector?.trim() || 'path:.';
  if (!value.startsWith('path:')) return value;
  const target = value.slice('path:'.length) || '.';
  return `path:${path.isAbsolute(target) ? target : path.resolve(repoRoot, target)}`;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function deepFind(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  if (key in object) return object[key];
  for (const item of Object.values(object)) {
    const found = deepFind(item, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = deepFind(value, key);
    if (typeof found === 'string' && found !== '') return found;
  }
  return undefined;
}

function findObject(value: unknown, key: string): JsonObject | undefined {
  const found = deepFind(value, key);
  return asObject(found) ?? undefined;
}

function parsePayload(raw: unknown): JsonObject {
  if (typeof raw === 'string') {
    try {
      return asObject(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }
  return asObject(raw) ?? {};
}

function extractRunId(json: unknown): string {
  const result = asObject(asObject(json)?.result) ?? asObject(json);
  const run = findObject(result, 'run');
  if (typeof run?.id === 'string' && run.id !== '') return run.id;
  const id = findString(result, ['runId', 'run_id']);
  if (id) return id;
  throw new CliError(EXIT.orchestrator, '无法从 Orca run-create 输出中解析 run id');
}

function extractTaskId(json: unknown): string | undefined {
  const result = asObject(asObject(json)?.result) ?? asObject(json);
  const task = findObject(result, 'task');
  if (typeof task?.id === 'string' && task.id !== '') return task.id;
  return findString(result, ['taskId', 'task_id']);
}

function extractDispatchHandle(json: unknown, runId: string): DispatchHandle {
  const result = asObject(asObject(json)?.result) ?? asObject(json);
  const dispatch = findObject(result, 'dispatch');
  const worker = findObject(result, 'worker');
  const taskId = extractTaskId(json);
  const dispatchId =
    (typeof dispatch?.id === 'string' && dispatch.id !== '' ? dispatch.id : undefined) ??
    findString(result, ['dispatchId', 'dispatch_id']) ??
    (typeof worker?.dispatchId === 'string' ? worker.dispatchId : undefined);
  const terminalHandle =
    findString(result, ['agentTerminalHandle', 'terminalHandle', 'terminal_handle']) ??
    (typeof worker?.agentTerminalHandle === 'string' ? worker.agentTerminalHandle : undefined);
  if (!taskId && !dispatchId) {
    throw new CliError(
      EXIT.orchestrator,
      '无法从 Orca worker-start 输出中解析 task/dispatch id；请确认 Orca 版本与 JSON 输出',
    );
  }
  return { runId, ...(taskId ? { taskId } : {}), ...(dispatchId ? { dispatchId } : {}), ...(terminalHandle ? { terminalHandle } : {}) };
}

function extractMessages(json: unknown): OrcaMessage[] {
  const result = asObject(json)?.result;
  if (Array.isArray(result)) return result.filter((item) => asObject(item) !== null) as OrcaMessage[];
  const found = deepFind(result ?? json, 'messages');
  if (Array.isArray(found)) {
    return found.filter((item) => asObject(item) !== null) as OrcaMessage[];
  }
  const single = deepFind(result ?? json, 'message');
  return asObject(single) ? [single as OrcaMessage] : [];
}

function extractAckId(json: unknown): string | undefined {
  const result = asObject(json)?.result ?? json;
  return findString(result, ['delivery_id', 'deliveryId', 'batch_id', 'batchId', 'delivery']);
}

function extractGateId(json: unknown): string | undefined {
  const result = asObject(asObject(json)?.result) ?? asObject(json);
  const gate = findObject(result, 'gate');
  return (typeof gate?.id === 'string' ? gate.id : undefined) ?? findString(result, ['gateId', 'gate_id']);
}

function messageMatches(handle: DispatchHandle, message: OrcaMessage, payload: JsonObject): boolean {
  const payloadDispatch = typeof payload.dispatchId === 'string' ? payload.dispatchId : undefined;
  if (handle.dispatchId && payloadDispatch) return handle.dispatchId === payloadDispatch;
  const payloadTask = typeof payload.taskId === 'string' ? payload.taskId : undefined;
  if (handle.taskId && payloadTask) return handle.taskId === payloadTask;
  if (handle.terminalHandle && message.from_handle) return handle.terminalHandle === message.from_handle;
  return false;
}

export class OrcaAdapter implements Orchestrator {
  readonly name = 'orca' as const;
  private readonly binary: string;
  private readonly repoRoot: string;
  private readonly worktree: string;
  private readonly timeoutMs: number;
  private queue: MessageBatch[] = [];

  constructor(options: OrcaAdapterOptions) {
    const binary = resolveOrcaBinary(options.binary);
    if (!binary) {
      throw new CliError(EXIT.orchestrator, '未检测到 Orca CLI（orca-ide / orca）；请先安装 Orca 并确保命令在 PATH 中，或设置 ORCA_TEAM_ORCHESTRATION_ORCA');
    }
    this.binary = binary;
    this.repoRoot = options.repoRoot;
    this.worktree = resolveWorktree(options.worktree, options.repoRoot);
    this.timeoutMs = options.timeoutMs;
  }

  private run(args: string[], timeoutMs = 120_000): JsonObject {
    const result = spawnSync(this.binary, args, {
      cwd: this.repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      throw new CliError(
        EXIT.orchestrator,
        timedOut ? `Orca 命令超时：orca ${args.slice(0, 2).join(' ')}` : `无法执行 Orca：${result.error.message}`,
      );
    }
    const stdout = (result.stdout ?? '').trim();
    let parsed: JsonObject = {};
    if (stdout !== '') {
      try {
        parsed = (JSON.parse(stdout) as JsonObject) ?? {};
      } catch {
        throw new CliError(
          EXIT.orchestrator,
          `Orca 返回了非 JSON 输出（退出码 ${result.status ?? 'null'}）：${stdout.slice(0, 500)}`,
        );
      }
    }
    if (parsed.ok === false || (result.status ?? 1) !== 0) {
      const error = asObject(parsed.error);
      const detail =
        (typeof error?.message === 'string' && error.message) ||
        (result.stderr ?? '').trim() ||
        stdout ||
        `退出码 ${result.status ?? 'null'}`;
      throw new CliError(EXIT.orchestrator, `Orca 命令失败：${detail}`);
    }
    return parsed;
  }

  async probe(): Promise<void> {
    this.run(['orchestration', 'run-list', '--json']);
  }

  async createRun(objective: string): Promise<string> {
    const json = this.run(['orchestration', 'run-create', '--objective', objective, '--json']);
    return extractRunId(json);
  }

  async useRun(runId: string): Promise<void> {
    this.run(['orchestration', 'run-use', '--id', runId, '--json']);
  }

  async dispatch(plan: DispatchPlan): Promise<DispatchHandle> {
    const agent = plan.agent;
    if (!ORCA_AGENTS.has(agent.kind)) {
      throw new CliError(EXIT.agent, `Orca 不支持 agent kind：${agent.kind}`);
    }
    const title = `${plan.stage.toUpperCase()} ${plan.story} r${plan.round}`;
    const args = [
      'orchestration',
      'worker-start',
      '--spec',
      plan.prompt,
      '--worktree',
      this.worktree,
      '--agent',
      agent.kind,
      '--task-title',
      title,
      '--run',
      plan.runId,
      '--timeout-ms',
      String(plan.timeoutMs),
    ];
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    if (agent.args?.length) args.push(...agent.args);
    args.push('--json');
    const json = this.run(args, plan.timeoutMs + 60_000);
    return extractDispatchHandle(json, plan.runId);
  }

  async wait(handle: DispatchHandle, options: WaitOptions): Promise<DispatchResult> {
    if (!handle.taskId && !handle.dispatchId) {
      throw new CliError(EXIT.orchestrator, '派发句柄缺少 task/dispatch id，无法等待结果');
    }
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      const batch = this.queue.shift() ?? (await this.fetchBatch(handle, deadline));
      if (!batch) return { outcome: 'timeout', summary: '等待 worker_done 超时' };
      if (batch.messages.length === 0) {
        if (Date.now() >= deadline) return { outcome: 'timeout', summary: '等待 worker_done 超时' };
        continue;
      }

      const processed = await this.processBatch(handle, batch.messages, options);
      if (processed.blocked) {
        return processed.result ?? { outcome: 'blocked', summary: 'worker 提出问题，等待协调者回复' };
      }
      if (batch.ackId) {
        const next = await this.ack(handle, batch.ackId);
        if (next) this.queue.push(next);
      }
      if (processed.result) {
        if (processed.result.outcome === 'succeeded' || processed.result.outcome === 'failed') {
          await this.release(handle);
        }
        return processed.result;
      }
      if (Date.now() >= deadline) return { outcome: 'timeout', summary: '等待 worker_done 超时' };
    }
  }

  private async fetchBatch(handle: DispatchHandle, deadline: number): Promise<MessageBatch | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const json = this.run(
      [
        'orchestration',
        'check',
        '--wait',
        '--types',
        'worker_done,escalation,question',
        '--timeout-ms',
        String(remaining),
        '--run',
        handle.runId,
        '--json',
      ],
      remaining + 30_000,
    );
    const messages = extractMessages(json);
    return { messages, ackId: extractAckId(json) ?? messages[0]?.id };
  }

  private async ack(handle: DispatchHandle, ackId: string): Promise<MessageBatch | null> {
    try {
      const json = this.run([
        'orchestration',
        'check',
        '--ack',
        ackId,
        '--run',
        handle.runId,
        '--json',
      ]);
      const messages = extractMessages(json);
      return messages.length > 0
        ? { messages, ackId: extractAckId(json) ?? messages[0]?.id }
        : null;
    } catch {
      return null;
    }
  }

  private async processBatch(
    handle: DispatchHandle,
    messages: OrcaMessage[],
    options: WaitOptions,
  ): Promise<{ result?: DispatchResult; blocked: boolean }> {
    let result: DispatchResult | undefined;
    for (const message of messages) {
      const type = message.type ?? '';
      if (type === 'heartbeat' || type === 'status') continue;
      const payload = parsePayload(message.payload);
      if (type === 'worker_done') {
        if (!messageMatches(handle, message, payload)) continue;
        const outcome = payload.outcome === 'failed' ? 'failed' : 'succeeded';
        result = {
          outcome,
          summary: message.subject || message.body || '',
          ...(message.id ? { messageId: message.id } : {}),
          ...(typeof payload.reportPath === 'string' ? { reportPath: payload.reportPath } : {}),
          ...(Array.isArray(payload.filesModified)
            ? { filesModified: payload.filesModified.filter((item): item is string => typeof item === 'string') }
            : {}),
        };
        continue;
      }
      if (type === 'question' || type === 'escalation') {
        const question: DispatchQuestion = {
          messageId: message.id ?? '',
          type,
          subject: message.subject ?? '',
          body: message.body ?? '',
        };
        const answer = options.onQuestion ? await options.onQuestion(question) : null;
        if (answer === null) {
          return {
            result: {
              outcome: 'blocked',
              summary: question.subject || question.body || `${type} 需要协调者处理`,
              ...(question.messageId ? { messageId: question.messageId } : {}),
              question: [question.subject, question.body].filter(Boolean).join('\n'),
            },
            blocked: true,
          };
        }
        if (question.messageId) await this.reply(question.messageId, answer);
      }
    }
    return { ...(result ? { result } : {}), blocked: false };
  }

  async reply(messageId: string, body: string): Promise<void> {
    this.run(['orchestration', 'reply', '--id', messageId, '--body', body, '--json']);
  }

  async createGate(request: GateRequest, runId: string): Promise<string | null> {
    const title = `GATE ${request.stage} r${request.round}`;
    const task = this.run([
      'orchestration',
      'task-create',
      '--spec',
      request.question,
      '--task-title',
      title,
      '--run',
      runId,
      '--json',
    ]);
    const taskId = extractTaskId(task);
    if (!taskId) return null;
    const gate = this.run([
      'orchestration',
      'gate-create',
      '--task',
      taskId,
      '--question',
      request.question,
      '--options',
      JSON.stringify(request.options),
      '--json',
    ]);
    return extractGateId(gate) ?? null;
  }

  async release(handle: DispatchHandle): Promise<void> {
    if (!handle.dispatchId) return;
    try {
      this.run(['orchestration', 'worker-release', '--dispatch', handle.dispatchId, '--json']);
    } catch {
      // Release is post-settlement cleanup; a failure must not turn a passed stage into a failure.
    }
  }
}
