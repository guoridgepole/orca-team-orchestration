import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CliError, EXIT } from './errors.js';
import { normalizePattern, readText, toPosix, writeText } from './paths.js';

export type OrchestratorKind = 'auto' | 'orca';
export type ShellKind = 'auto' | 'sh' | 'pwsh' | 'cmd';
export type GuardType = 'append-only' | 'immutable' | 'no-delete';
export type BrowserDriver = 'orca' | 'playwright' | 'mcp' | 'none';

export interface AgentConfig {
  kind: string;
  model?: string | null;
  effort?: 'low' | 'medium' | 'high' | null;
  args?: string[];
}

export interface ArtifactConfig {
  path: string;
  template?: string;
  required_sections?: string[];
  first_line?: string[];
}

export interface BrowserConfig {
  driver: BrowserDriver;
  url?: string;
}

export interface RoleConfig {
  agent: string;
  writes: string[];
  readonly_source?: boolean;
  artifact: ArtifactConfig;
  run_checks?: string[];
  rules?: string;
  browser?: BrowserConfig;
}

export interface FlowConfig {
  design: string;
  review: string | string[] | null;
  develop: string;
  test: string | string[] | null;
  accept: string | null;
}

export interface GuardConfig {
  id: string;
  type: GuardType;
  paths: string[];
  allow_new?: boolean;
  require_header?: string;
  message?: string;
}

export interface CheckConfig {
  command: string;
  timeout_minutes?: number;
  required?: boolean;
}

export interface MaxRounds {
  design_review: number;
  dev_test: number;
}

export interface RepoConfig {
  name: string;
  path: string;
}

export interface Config {
  version: 1;
  locale: 'zh-CN' | 'en';
  project: {
    name?: string;
    repos?: RepoConfig[];
    commands: {
      start?: string | null;
      test?: string | null;
      build?: string | null;
      base_url?: string | null;
    };
    paths: {
      features_dir: string;
      docs: string;
      source: string[];
      tests: string[];
      db: string | null;
      evidence: string;
    };
  };
  runtime: {
    orchestrator: OrchestratorKind;
    shell: ShellKind;
    timeout_minutes: number;
    max_rounds: { design_review: number; dev_test: number };
    checkpoint_commits: boolean;
    push: false;
    worktree?: string;
  };
  agents: Record<string, AgentConfig>;
  roles: Record<string, RoleConfig>;
  flow: FlowConfig;
  guards: GuardConfig[];
  checks: Record<string, CheckConfig>;
}

export interface EditableSettings {
  project: {
    name: string | null;
    repos: RepoConfig[];
    commands: {
      start: string | null;
      test: string | null;
      build: string | null;
      base_url: string | null;
    };
    paths: {
      features_dir: string;
      docs: string;
      source: string[];
      tests: string[];
      db: string | null;
      evidence: string;
    };
  };
  runtime: { max_rounds: { design_review: number; dev_test: number } };
}

export interface SettingsSnapshot {
  initialized: boolean;
  valid: boolean;
  errorKind: 'missing' | 'parse' | 'validation' | null;
  error: string | null;
  revision: string | null;
  yaml: string | null;
  settings: EditableSettings;
}

export interface ConfigSnapshot {
  initialized: boolean;
  valid: boolean;
  errorKind: 'missing' | 'parse' | 'validation' | null;
  error: string | null;
  revision: string | null;
  raw: string | null;
  config: Config | null;
}

const TOP_KEYS = ['version', 'locale', 'project', 'runtime', 'agents', 'roles', 'flow', 'guards', 'checks'];
const REPLACE_KEYS = new Set(['roles', 'flow', 'guards', 'checks']);

export function projectConfigPath(root: string): string {
  return path.join(root, '.orca-team-orchestration', 'config.yaml');
}

export function globalConfigPath(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'orca-team-orchestration', 'config.yaml');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'orca-team-orchestration', 'config.yaml');
  }
  return path.join(os.homedir(), '.config', 'orca-team-orchestration', 'config.yaml');
}

export function builtinDefaults(projectName: string): Config {
  return {
    version: 1,
    locale: 'zh-CN',
    project: {
      name: projectName,
      commands: { start: null, test: null, build: null, base_url: null },
      paths: {
        features_dir: 'features',
        docs: 'docs',
        source: [],
        tests: [],
        db: null,
        evidence: 'docs/test/evidence',
      },
    },
    runtime: {
      orchestrator: 'orca',
      shell: 'auto',
      timeout_minutes: 30,
      max_rounds: { design_review: 3, dev_test: 3 },
      checkpoint_commits: true,
      push: false,
      worktree: 'path:.',
    },
    agents: {
      'claude-main': { kind: 'claude', model: null, effort: 'medium' },
      'codex-review': { kind: 'codex', model: null },
    },
    roles: {
      designer: {
        agent: 'claude-main',
        writes: ['docs/design/'],
        artifact: {
          path: 'docs/design/{{story}}-r{{round}}.md',
          template: 'designer',
          required_sections: ['目标', '验收映射', '数据库变更', '失败路径', '回滚'],
        },
      },
      reviewer: {
        agent: 'codex-review',
        writes: ['docs/review/'],
        readonly_source: true,
        artifact: {
          path: 'docs/review/{{story}}-r{{round}}.md',
          template: 'reviewer',
          required_sections: ['问题清单', '通过条件'],
          first_line: ['PASS', 'REJECT'],
        },
      },
      developer: {
        agent: 'claude-main',
        writes: ['docs/dev/'],
        artifact: {
          path: 'docs/dev/{{story}}-r{{round}}.md',
          template: 'developer',
          required_sections: ['变更', '自测', 'SQL'],
        },
      },
      tester: {
        agent: 'codex-review',
        writes: ['docs/test/'],
        artifact: {
          path: 'docs/test/{{story}}-r{{round}}.md',
          template: 'tester',
          required_sections: ['用例结果', '证据'],
          first_line: ['PASS', 'FAIL'],
        },
        browser: { driver: 'orca', url: '{{project.commands.base_url}}' },
      },
    },
    flow: {
      design: 'designer',
      review: ['reviewer'],
      develop: 'developer',
      test: ['tester'],
      accept: 'coordinator',
    },
    guards: [],
    checks: {
      'project-test': { command: '{{project.commands.test}}', timeout_minutes: 15, required: true },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (REPLACE_KEYS.has(key)) {
      out[key] = value;
    } else if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = mergeConfig(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function configError(message: string): never {
  throw new CliError(EXIT.config, `配置非法：${message}`);
}

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (!isPlainObject(value)) configError(`${at} 必须是对象`);
  return value;
}

function noUnknown(obj: Record<string, unknown>, allowed: string[], at: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) configError(`${at}.${key} 是未知字段`);
  }
}

function asString(value: unknown, at: string, options: { empty?: boolean } = {}): string {
  if (typeof value !== 'string') configError(`${at} 必须是字符串`);
  if (options.empty !== true && value.trim() === '') configError(`${at} 不能为空`);
  return value;
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, at);
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) configError(`${at} 必须是数组`);
  return value;
}

function asStringArray(value: unknown, at: string): string[] {
  return asArray(value, at).map((item, index) => asString(item, `${at}[${index}]`));
}

function asBoolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') configError(`${at} 必须是布尔值`);
  return value;
}

function asNumber(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) configError(`${at} 必须是数字`);
  return value;
}

function asPositiveInt(value: unknown, at: string): number {
  const num = asNumber(value, at);
  if (!Number.isInteger(num) || num < 1 || num > 100) configError(`${at} 必须是 1–100 的整数`);
  return num;
}

function validateGlob(pattern: string, at: string, repoRoot?: string): void {
  const normalized = normalizePattern(pattern);
  const tooBroad = ['**', '**/*', '*', '.', './', '/', ''];
  if (tooBroad.includes(normalized)) configError(`${at} 范围过宽：${pattern}`);
  if (normalized.startsWith('/') || normalized.includes('..')) {
    configError(`${at} 必须是仓库内的相对路径：${pattern}`);
  }
  if (repoRoot) {
    const target = path.resolve(repoRoot, normalized.replace(/\*\*.*$/, ''));
    const rel = path.relative(repoRoot, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) configError(`${at} 指向仓库外：${pattern}`);
  }
}

function validateArtifact(raw: unknown, at: string, repoRoot?: string): ArtifactConfig {
  const obj = asObject(raw, at);
  noUnknown(obj, ['path', 'template', 'required_sections', 'first_line'], at);
  const artifactPath = asString(obj.path, `${at}.path`);
  if (!artifactPath.includes('{{story}}')) configError(`${at}.path 必须包含 {{story}}`);
  if (artifactPath.startsWith('/') || artifactPath.includes('..')) {
    configError(`${at}.path 必须是仓库内的相对路径`);
  }
  if (repoRoot) validateGlob(artifactPath.replace('{{round}}', '1'), `${at}.path`, repoRoot);
  const result: ArtifactConfig = { path: artifactPath };
  if (obj.template !== undefined) result.template = asString(obj.template, `${at}.template`);
  if (obj.required_sections !== undefined) {
    result.required_sections = asStringArray(obj.required_sections, `${at}.required_sections`);
  }
  if (obj.first_line !== undefined) {
    const lines = asStringArray(obj.first_line, `${at}.first_line`);
    if (lines.length === 0) configError(`${at}.first_line 不能为空数组`);
    result.first_line = lines;
  }
  return result;
}

export const AGENT_KINDS = ['claude', 'codex', 'zcode', 'opencode', 'qoder', 'codebuddy'];
export const EFFORTS = ['low', 'medium', 'high'];
const BROWSER_DRIVERS = ['orca', 'playwright', 'mcp', 'none'];
const GUARD_TYPES = ['append-only', 'immutable', 'no-delete'];
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROLE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function validateRoleName(name: string, at = 'role'): void {
  if (!ROLE_NAME.test(name) || name.includes('..') || /[. ]$/.test(name) || WINDOWS_RESERVED.test(name)) {
    configError(`${at} 名称不能用作安全文件名：${name}`);
  }
}

const REPO_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const RESERVED_REPO_NAMES = new Set(['workspace', 'all', 'root']);

function validateRepoName(name: string, at: string): void {
  validateRoleName(name, at);
  if (RESERVED_REPO_NAMES.has(name.toLowerCase())) {
    configError(`${at} 使用了保留名称：${name}`);
  }
}

function validateRepoPath(value: unknown, at: string): string {
  const raw = asString(value, at);
  if (raw.includes('\\') || raw.includes('\0')) {
    configError(`${at} 必须是 workspace 内相对路径：${raw}`);
  }
  const normalized = toPosix(raw);
  if (normalized.startsWith('/')) {
    configError(`${at} 必须是 workspace 内相对路径：${raw}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    configError(`${at} 必须是 workspace 内相对路径：${raw}`);
  }
  for (const segment of segments) {
    if (!REPO_SEGMENT.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) {
      configError(`${at} 含非法路径段：${segment}`);
    }
  }
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  const a = process.platform === 'win32' ? left.toLowerCase() : left;
  const b = process.platform === 'win32' ? right.toLowerCase() : right;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function validateConfig(
  raw: unknown,
  options: { repoRoot?: string; requireCommands?: boolean } = {},
): Config {
  const root = asObject(raw, 'config');
  noUnknown(root, TOP_KEYS, 'config');
  if (root.version !== 1) configError('version 必须是 1');
  if (root.locale !== undefined && root.locale !== 'zh-CN' && root.locale !== 'en') {
    configError('locale 只能是 zh-CN 或 en');
  }

  const project = asObject(root.project, 'project');
  noUnknown(project, ['name', 'commands', 'paths', 'repos'], 'project');
  const repos: RepoConfig[] = [];
  if (project.repos !== undefined) {
    const list = asArray(project.repos, 'project.repos');
    if (list.length === 0) configError('project.repos 不能为空数组');
    const names = new Set<string>();
    for (const [index, value] of list.entries()) {
      const at = `project.repos[${index}]`;
      const repo = asObject(value, at);
      noUnknown(repo, ['name', 'path'], at);
      const name = asString(repo.name, `${at}.name`);
      validateRepoName(name, `${at}.name`);
      if (names.has(name.toLowerCase())) configError(`${at}.name 重复：${name}`);
      names.add(name.toLowerCase());
      const repoPath = validateRepoPath(repo.path, `${at}.path`);
      if (repos.some((other) => pathsOverlap(repoPath, other.path))) {
        configError(`${at}.path 与其他仓库重叠：${repoPath}`);
      }
      repos.push({ name, path: repoPath });
    }
  }
  const commands = asObject(project.commands, 'project.commands');
  noUnknown(commands, ['start', 'test', 'build', 'base_url'], 'project.commands');
  for (const key of ['start', 'test', 'build', 'base_url'] as const) {
    if (commands[key] !== undefined && commands[key] !== null) {
      asString(commands[key], `project.commands.${key}`);
    }
  }
  if (options.requireCommands) {
    if (!commands.start) configError('project.commands.start 不能为空（用 orca-team-orchestration config 补全）');
    if (!commands.test) configError('project.commands.test 不能为空（用 orca-team-orchestration config 补全）');
  }

  const paths = asObject(project.paths, 'project.paths');
  noUnknown(paths, ['features_dir', 'docs', 'source', 'tests', 'db', 'evidence'], 'project.paths');
  const featuresDir = asString(paths.features_dir, 'project.paths.features_dir');
  const docsDir = asString(paths.docs, 'project.paths.docs');
  const sourceDirs = asStringArray(paths.source, 'project.paths.source');
  asStringArray(paths.tests, 'project.paths.tests');
  const dbPath = paths.db === undefined || paths.db === null ? null : asString(paths.db, 'project.paths.db');
  if (dbPath !== null && (dbPath.startsWith('/') || dbPath.includes('..'))) {
    configError('project.paths.db 必须是仓库内的相对路径');
  }
  const evidenceDir = asString(paths.evidence, 'project.paths.evidence');
  for (const [label, dir] of [
    ['features_dir', featuresDir],
    ['docs', docsDir],
    ['evidence', evidenceDir],
  ] as const) {
    if (dir.startsWith('/') || dir.includes('..')) configError(`project.paths.${label} 必须是仓库内的相对路径`);
  }
  for (const [index, dir] of [...sourceDirs].entries()) {
    validateGlob(dir, `project.paths.source[${index}]`, options.repoRoot);
  }

  const runtime = asObject(root.runtime, 'runtime');
  noUnknown(
    runtime,
    ['orchestrator', 'shell', 'timeout_minutes', 'max_rounds', 'checkpoint_commits', 'push', 'worktree'],
    'runtime',
  );
  if (!['auto', 'orca'].includes(String(runtime.orchestrator))) {
    configError('runtime.orchestrator 只能是 auto / orca；本工具必须依赖 Orca');
  }
  if (!['auto', 'sh', 'pwsh', 'cmd'].includes(String(runtime.shell))) {
    configError('runtime.shell 只能是 auto / sh / pwsh / cmd');
  }
  asPositiveInt(runtime.timeout_minutes, 'runtime.timeout_minutes');
  asBoolean(runtime.checkpoint_commits, 'runtime.checkpoint_commits');
  if (runtime.push !== false) configError('runtime.push 固定为 false，本工具绝不推送');
  if (runtime.worktree !== undefined) {
    const worktree = asString(runtime.worktree, 'runtime.worktree').trim();
    if (repos.length > 0 && worktree !== 'path:.' && worktree !== 'path:./') {
      configError('project.repos 下 runtime.worktree 只能是 path:.');
    }
  }
  const maxRounds = asObject(runtime.max_rounds, 'runtime.max_rounds');
  noUnknown(maxRounds, ['design_review', 'dev_test'], 'runtime.max_rounds');
  asPositiveInt(maxRounds.design_review, 'runtime.max_rounds.design_review');
  asPositiveInt(maxRounds.dev_test, 'runtime.max_rounds.dev_test');

  const agents = asObject(root.agents, 'agents');
  if (Object.keys(agents).length === 0) configError('agents 不能为空');
  for (const [name, value] of Object.entries(agents)) {
    const at = `agents.${name}`;
    const agent = asObject(value, at);
    noUnknown(agent, ['kind', 'model', 'effort', 'args'], at);
    const kind = asString(agent.kind, `${at}.kind`);
    if (!AGENT_KINDS.includes(kind)) configError(`${at}.kind 不支持：${kind}`);
    if (agent.model !== undefined && agent.model !== null) asString(agent.model, `${at}.model`);
    if (agent.effort !== undefined && agent.effort !== null && !EFFORTS.includes(String(agent.effort))) {
      configError(`${at}.effort 只能是 low / medium / high`);
    }
    if (agent.args !== undefined) asStringArray(agent.args, `${at}.args`);
  }

  const roles = asObject(root.roles, 'roles');
  if (Object.keys(roles).length === 0) configError('roles 不能为空');
  const roleNamesLower = new Set<string>();
  for (const [name, value] of Object.entries(roles)) {
    const at = `roles.${name}`;
    validateRoleName(name, at);
    const lower = name.toLowerCase();
    if (roleNamesLower.has(lower)) configError(`${at} 与其他角色仅大小写不同，无法生成唯一文件名`);
    roleNamesLower.add(lower);
    const role = asObject(value, at);
    noUnknown(
      role,
      ['agent', 'writes', 'readonly_source', 'artifact', 'run_checks', 'rules', 'browser'],
      at,
    );
    const agentName = asString(role.agent, `${at}.agent`);
    if (!(agentName in agents)) configError(`${at}.agent 引用了不存在的 agent：${agentName}`);
    const writes = asStringArray(role.writes, `${at}.writes`);
    if (writes.length === 0) configError(`${at}.writes 不能为空`);
    for (const [index, pattern] of writes.entries()) {
      validateGlob(pattern, `${at}.writes[${index}]`, options.repoRoot);
    }
    if (role.readonly_source !== undefined) asBoolean(role.readonly_source, `${at}.readonly_source`);
    validateArtifact(role.artifact, `${at}.artifact`, options.repoRoot);
    if (role.run_checks !== undefined) asStringArray(role.run_checks, `${at}.run_checks`);
    if (role.rules !== undefined) asString(role.rules, `${at}.rules`, { empty: true });
    if (role.browser !== undefined) {
      const browser = asObject(role.browser, `${at}.browser`);
      noUnknown(browser, ['driver', 'url'], `${at}.browser`);
      const driver = asString(browser.driver, `${at}.browser.driver`);
      if (!BROWSER_DRIVERS.includes(driver)) configError(`${at}.browser.driver 不支持：${driver}`);
      if (browser.url !== undefined) asString(browser.url, `${at}.browser.url`);
    }
  }

  const flow = asObject(root.flow, 'flow');
  noUnknown(flow, ['design', 'review', 'develop', 'test', 'accept'], 'flow');
  const roleRef = (value: unknown, at: string): string => {
    const name = asString(value, at);
    if (!(name in roles)) configError(`${at} 引用了不存在的角色：${name}`);
    return name;
  };
  roleRef(flow.design, 'flow.design');
  roleRef(flow.develop, 'flow.develop');
  const multiRole = (value: unknown, at: string): void => {
    if (value === null) return;
    if (typeof value === 'string') {
      roleRef(value, at);
      return;
    }
    const list = asStringArray(value, at);
    if (list.length === 0) configError(`${at} 不能是空数组`);
    for (const [index, name] of list.entries()) roleRef(name, `${at}[${index}]`);
  };
  multiRole(flow.review, 'flow.review');
  multiRole(flow.test, 'flow.test');
  if (flow.accept !== null) {
    const accept = asString(flow.accept, 'flow.accept');
    if (accept !== 'coordinator' && !(accept in roles)) {
      configError('flow.accept 只能是 coordinator 或已定义的角色');
    }
  }

  const guards = asArray(root.guards, 'guards');
  const guardIds = new Set<string>();
  for (const [index, value] of guards.entries()) {
    const at = `guards[${index}]`;
    const guard = asObject(value, at);
    noUnknown(guard, ['id', 'type', 'paths', 'allow_new', 'require_header', 'message'], at);
    const id = asString(guard.id, `${at}.id`);
    if (guardIds.has(id)) configError(`${at}.id 重复：${id}`);
    guardIds.add(id);
    const type = asString(guard.type, `${at}.type`);
    if (!GUARD_TYPES.includes(type)) configError(`${at}.type 不支持：${type}`);
    const guardPaths = asStringArray(guard.paths, `${at}.paths`);
    if (guardPaths.length === 0) configError(`${at}.paths 不能为空`);
    for (const [pathIndex, pattern] of guardPaths.entries()) {
      validateGlob(pattern, `${at}.paths[${pathIndex}]`, options.repoRoot);
    }
    if (guard.allow_new !== undefined) asBoolean(guard.allow_new, `${at}.allow_new`);
    if (guard.require_header !== undefined) asString(guard.require_header, `${at}.require_header`);
    if (guard.message !== undefined) asString(guard.message, `${at}.message`);
  }

  const checks = asObject(root.checks, 'checks');
  for (const [name, value] of Object.entries(checks)) {
    const at = `checks.${name}`;
    const check = asObject(value, at);
    noUnknown(check, ['command', 'timeout_minutes', 'required'], at);
    asString(check.command, `${at}.command`);
    if (check.timeout_minutes !== undefined) asPositiveInt(check.timeout_minutes, `${at}.timeout_minutes`);
    if (check.required !== undefined) asBoolean(check.required, `${at}.required`);
  }

  return root as unknown as Config;
}

function effectiveConfig(
  repoRoot: string,
  projectRaw: Record<string, unknown>,
  options: { requireCommands?: boolean } = {},
): Config {
  let merged = builtinDefaults(path.basename(repoRoot)) as unknown as Record<string, unknown>;
  const globalRaw = readText(globalConfigPath());
  if (globalRaw !== null) {
    const globalConfig = parseYamlSafe(globalRaw, globalConfigPath());
    if (isPlainObject(globalConfig.project)) {
      const globalProject = { ...globalConfig.project };
      delete globalProject.repos;
      globalConfig.project = globalProject;
    }
    merged = mergeConfig(merged, globalConfig);
  }
  merged = mergeConfig(merged, projectRaw);
  return validateConfig(merged, { repoRoot, requireCommands: options.requireCommands });
}

export function loadConfig(
  repoRoot: string,
  options: { requireCommands?: boolean } = {},
): Config {
  const raw = readText(projectConfigPath(repoRoot));
  if (raw === null) {
    throw new CliError(EXIT.config, '未找到 .orca-team-orchestration/config.yaml；先运行 orca-team-orchestration init');
  }
  const projectRaw = parseYamlSafe(raw, projectConfigPath(repoRoot));
  return effectiveConfig(repoRoot, projectRaw, options);
}

export function configFromRaw(
  repoRoot: string,
  raw: string,
  options: { requireCommands?: boolean } = {},
): Config {
  const projectRaw = parseYamlSafe(raw, projectConfigPath(repoRoot));
  return effectiveConfig(repoRoot, projectRaw, options);
}

export function readConfigSnapshot(repoRoot: string): ConfigSnapshot {
  const file = projectConfigPath(repoRoot);
  const raw = readText(file);
  if (raw === null) {
    return {
      initialized: false,
      valid: false,
      errorKind: 'missing',
      error: '未找到 .orca-team-orchestration/config.yaml；先运行 orca-team-orchestration init',
      revision: null,
      raw: null,
      config: null,
    };
  }

  const revision = sha256(raw);
  let projectRaw: Record<string, unknown>;
  try {
    projectRaw = parseYamlSafe(raw, file);
  } catch (error) {
    return {
      initialized: true,
      valid: false,
      errorKind: 'parse',
      error: (error as Error).message,
      revision,
      raw,
      config: null,
    };
  }

  try {
    return {
      initialized: true,
      valid: true,
      errorKind: null,
      error: null,
      revision,
      raw,
      config: effectiveConfig(repoRoot, projectRaw),
    };
  } catch (error) {
    return {
      initialized: true,
      valid: false,
      errorKind: 'validation',
      error: (error as Error).message,
      revision,
      raw,
      config: null,
    };
  }
}

function parseYamlSafe(raw: string, file: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(raw);
    if (!isPlainObject(parsed)) configError(`${file} 顶层必须是对象`);
    return parsed;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(EXIT.config, `YAML 解析失败（${file}）：${(err as Error).message}`);
  }
}

export function configToYaml(config: Config): string {
  return stringifyYaml(config, { lineWidth: 0 });
}

export function writeProjectConfig(root: string, config: Config): void {
  writeText(projectConfigPath(root), configToYaml(config));
}

export function updateProjectCommands(
  root: string,
  patch: { start?: string; test?: string; base_url?: string },
): void {
  const file = projectConfigPath(root);
  const raw = readText(file);
  const existing = raw === null ? {} : parseYamlSafe(raw, file);
  const project = isPlainObject(existing.project) ? { ...existing.project } : {};
  const commands = isPlainObject(project.commands) ? { ...project.commands } : {};
  if (patch.start !== undefined) commands.start = patch.start;
  if (patch.test !== undefined) commands.test = patch.test;
  if (patch.base_url !== undefined) commands.base_url = patch.base_url;
  project.commands = commands;
  existing.project = project;
  writeText(file, stringifyYaml(existing, { lineWidth: 0 }));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function editableSettings(config: Config): EditableSettings {
  return {
    project: {
      name: config.project.name ?? null,
      repos: (config.project.repos ?? []).map((repo) => ({ ...repo })),
      commands: {
        start: config.project.commands.start ?? null,
        test: config.project.commands.test ?? null,
        build: config.project.commands.build ?? null,
        base_url: config.project.commands.base_url ?? null,
      },
      paths: {
        features_dir: config.project.paths.features_dir,
        docs: config.project.paths.docs,
        source: [...config.project.paths.source],
        tests: [...config.project.paths.tests],
        db: config.project.paths.db,
        evidence: config.project.paths.evidence,
      },
    },
    runtime: {
      max_rounds: {
        design_review: config.runtime.max_rounds.design_review,
        dev_test: config.runtime.max_rounds.dev_test,
      },
    },
  };
}

function settingsFromProjectRaw(root: string, raw: Record<string, unknown>): EditableSettings {
  const defaults = editableSettings(builtinDefaults(path.basename(root)));
  const project = isPlainObject(raw.project) ? raw.project : {};
  const commands = isPlainObject(project.commands) ? project.commands : {};
  const paths = isPlainObject(project.paths) ? project.paths : {};
  const runtime = isPlainObject(raw.runtime) ? raw.runtime : {};
  const maxRounds = isPlainObject(runtime.max_rounds) ? runtime.max_rounds : {};
  const pickText = (value: unknown, fallback: string | null): string | null =>
    typeof value === 'string' ? value : fallback;
  const pickDir = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() !== '' ? value : fallback;
  const pickList = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [...fallback];
  const pickRound = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : fallback;
  const repos = Array.isArray(project.repos)
    ? project.repos.flatMap((item): RepoConfig[] => {
        if (!isPlainObject(item) || typeof item.name !== 'string' || typeof item.path !== 'string') return [];
        return [{ name: item.name, path: item.path }];
      })
    : defaults.project.repos;

  return {
    project: {
      name: project.name === undefined ? defaults.project.name : pickText(project.name, null),
      repos,
      commands: {
        start: pickText(commands.start, defaults.project.commands.start),
        test: pickText(commands.test, defaults.project.commands.test),
        build: pickText(commands.build, defaults.project.commands.build),
        base_url: pickText(commands.base_url, defaults.project.commands.base_url),
      },
      paths: {
        features_dir: pickDir(paths.features_dir, defaults.project.paths.features_dir),
        docs: pickDir(paths.docs, defaults.project.paths.docs),
        source: pickList(paths.source, defaults.project.paths.source),
        tests: pickList(paths.tests, defaults.project.paths.tests),
        db: paths.db === undefined ? defaults.project.paths.db : pickText(paths.db, null),
        evidence: pickDir(paths.evidence, defaults.project.paths.evidence),
      },
    },
    runtime: {
      max_rounds: {
        design_review: pickRound(maxRounds.design_review, defaults.runtime.max_rounds.design_review),
        dev_test: pickRound(maxRounds.dev_test, defaults.runtime.max_rounds.dev_test),
      },
    },
  };
}

export function readProjectSettings(root: string): SettingsSnapshot {
  const file = projectConfigPath(root);
  const raw = readText(file);
  if (raw === null) {
    return {
      initialized: false,
      valid: false,
      errorKind: 'missing',
      error: '未找到 .orca-team-orchestration/config.yaml；先运行 orca-team-orchestration init',
      revision: null,
      yaml: null,
      settings: editableSettings(builtinDefaults(path.basename(root))),
    };
  }

  const revision = sha256(raw);
  let projectRaw: Record<string, unknown>;
  try {
    projectRaw = parseYamlSafe(raw, file);
  } catch (error) {
    return {
      initialized: true,
      valid: false,
      errorKind: 'parse',
      error: (error as Error).message,
      revision,
      yaml: raw,
      settings: editableSettings(builtinDefaults(path.basename(root))),
    };
  }

  try {
    const config = effectiveConfig(root, projectRaw);
    return {
      initialized: true,
      valid: true,
      errorKind: null,
      error: null,
      revision,
      yaml: raw,
      settings: editableSettings(config),
    };
  } catch (error) {
    return {
      initialized: true,
      valid: false,
      errorKind: 'validation',
      error: (error as Error).message,
      revision,
      yaml: raw,
      settings: settingsFromProjectRaw(root, projectRaw),
    };
  }
}

export function isStoryId(value: string): boolean {
  return STORY_ID.test(value);
}

export function roleList(flowValue: string | string[] | null): string[] {
  if (flowValue === null) return [];
  return Array.isArray(flowValue) ? flowValue : [flowValue];
}

export function stageRoles(config: Config, stage: string): string[] {
  if (stage === 'design') return roleList(config.flow.design);
  if (stage === 'develop') return roleList(config.flow.develop);
  if (stage === 'review') return roleList(config.flow.review);
  if (stage === 'test') return roleList(config.flow.test);
  return [];
}

export function toPosixPath(value: string): string {
  return toPosix(value);
}
