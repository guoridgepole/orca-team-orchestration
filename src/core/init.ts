import fs from 'node:fs';
import path from 'node:path';
import type { Config, GuardConfig, RepoConfig } from './config.js';
import { builtinDefaults, configToYaml, projectConfigPath, validateConfig } from './config.js';
import { CliError, EXIT } from './errors.js';
import { gitCommit, gitHasHead, runGit } from './git.js';
import { installPreCommitHook } from './hooks.js';
import { readText, toPosix, writeText } from './paths.js';
import { discoverRepos, validateWorkspace } from './workspace.js';

export interface InitOptions {
  repoRoot: string;
  force?: boolean;
  baseline?: boolean;
  installHook?: boolean;
  cliEntry?: string;
}

export interface InitResult {
  configPath: string;
  created: string[];
  commit: string | null;
  hook: { status: string; backup: string | null };
}

export interface WorkspaceInitOptions {
  root: string;
  repos?: string[];
  force?: boolean;
  commit?: boolean;
  installHook?: boolean;
  cliEntry?: string;
}

export interface WorkspaceInitResult {
  configPath: string;
  created: string[];
  commit: string | null;
  gitInitialized: boolean;
  repos: RepoConfig[];
  hooks: Array<{ repo: string; status: string; backup: string | null; file: string | null }>;
  ignored: string[];
  warnings: string[];
}

interface Detection {
  commands: Config['project']['commands'];
  paths: Config['project']['paths'];
  guards: GuardConfig[];
}

function exists(root: string, relative: string): boolean {
  return fs.existsSync(path.join(root, relative));
}

function readJson(file: string): Record<string, unknown> | null {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function detectProject(root: string): Detection {
  const commands: Config['project']['commands'] = { start: null, test: null, build: null, base_url: null };
  const source: string[] = [];
  const tests: string[] = [];
  const guardList: GuardConfig[] = [];

  const pkg = exists(root, 'package.json') ? readJson(path.join(root, 'package.json')) : null;
  const scripts =
    pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : null;

  if (scripts) {
    if (typeof scripts.test === 'string') commands.test = 'npm test';
    if (typeof scripts.dev === 'string') commands.start = 'npm run dev';
    else if (typeof scripts.start === 'string') commands.start = 'npm start';
    if (typeof scripts.build === 'string') commands.build = 'npm run build';
  }

  if (exists(root, 'public/index.html')) {
    if (commands.start === null) {
      commands.start = 'cd public && python3 -m http.server 5180 --bind 127.0.0.1';
    }
    if (commands.base_url === null) commands.base_url = 'http://127.0.0.1:5180/';
  }

  for (const dir of ['src', 'app', 'public', 'lib']) {
    if (exists(root, dir)) source.push(`${dir}/`);
  }
  for (const dir of ['test', 'tests', '__tests__']) {
    if (exists(root, dir)) tests.push(`${dir}/`);
  }

  const dbPath = ['db/update.sql', 'sql/update.sql', 'database/update.sql'].find((file) => exists(root, file)) ?? null;
  if (dbPath) {
    guardList.push({
      id: 'sql-append-only',
      type: 'append-only',
      paths: [dbPath],
      require_header: '-- migration:',
      message: 'SQL 只能追加到文件末尾，且每段以 -- migration: 开头',
    });
    guardList.push({
      id: 'no-delete-schema',
      type: 'no-delete',
      paths: ['db/**'],
      message: '禁止删除数据库相关文件或语句',
    });
  }

  return {
    commands,
    paths: {
      features_dir: 'features',
      docs: 'docs',
      source,
      tests,
      db: dbPath,
      evidence: 'docs/v{{version}}/test/evidence',
    },
    guards: guardList,
  };
}

export function initProject(options: InitOptions): InitResult {
  const root = options.repoRoot;
  const configPath = projectConfigPath(root);
  if (fs.existsSync(configPath) && options.force !== true) {
    throw new CliError(EXIT.config, `.orca-team-orchestration/config.yaml 已存在；需要覆盖请加 --force`);
  }

  const detection = detectProject(root);
  const config = builtinDefaults(path.basename(root));
  config.project.commands = detection.commands;
  config.project.paths = detection.paths;
  config.guards = detection.guards;

  const created: string[] = [];
  const dirs = [
    config.project.paths.features_dir,
    config.project.paths.docs,
    '.orca-team-orchestration/runs',
    '.orca-team-orchestration/approvals',
  ];
  for (const dir of dirs) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) {
      fs.mkdirSync(absolute, { recursive: true });
      created.push(dir);
    }
  }

  writeText(configPath, configToYaml(config));
  created.push('.orca-team-orchestration/config.yaml');

  const ignoreFile = path.join(root, '.gitignore');
  const ignore = readText(ignoreFile) ?? '';
  if (!ignore.split('\n').includes('.orca-team-orchestration/runs/')) {
    const next = ignore === '' || ignore.endsWith('\n') ? `${ignore}.orca-team-orchestration/runs/\n` : `${ignore}\n.orca-team-orchestration/runs/\n`;
    writeText(ignoreFile, next);
    if (!ignore) created.push('.gitignore');
  }

  let commit: string | null = null;
  if (options.baseline === true) {
    commit = gitCommit(root, 'chore: orca-team-orchestration init', ['.orca-team-orchestration/config.yaml', '.gitignore']);
  }

  let hook: InitResult['hook'] = { status: 'skipped', backup: null };
  if (options.installHook !== false && options.cliEntry) {
    const result = installPreCommitHook(root, options.cliEntry);
    hook = { status: result.status, backup: result.backup };
    if (result.file) {
      const relative = path.relative(root, result.file).split(path.sep).join('/');
      if (result.status !== 'unchanged') created.push(relative);
    }
  }

  return { configPath, created, commit, hook };
}

const IGNORE_START = '# >>> orca-team-orchestration managed >>>';
const IGNORE_END = '# <<< orca-team-orchestration managed <<<';

function gitTopLevel(dir: string): string | null {
  const result = runGit(dir, ['rev-parse', '--show-toplevel']);
  return result.ok && result.stdout.trim() !== '' ? path.resolve(result.stdout.trim()) : null;
}

function sameDir(left: string, right: string): boolean {
  const real = (value: string): string => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const a = real(left);
  const b = real(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function managedIgnore(repos: RepoConfig[]): string {
  return [
    IGNORE_START,
    ...repos.map((repo) => `/${repo.path}/`),
    '.orca-team-orchestration/runs/',
    IGNORE_END,
  ].join('\n');
}

export function upsertManagedIgnore(existing: string, repos: RepoConfig[]): string {
  const block = managedIgnore(repos);
  const lines = existing.split('\n');
  const start = lines.indexOf(IGNORE_START);
  const end = lines.indexOf(IGNORE_END);
  if (start >= 0 && end > start) {
    const next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end + 1)].join('\n');
    return next.endsWith('\n') ? next : `${next}\n`;
  }
  const base = existing.replace(/\s+$/, '');
  return base === '' ? `${block}\n` : `${base}\n\n${block}\n`;
}

interface RepoDetection {
  source: string[];
  tests: string[];
  db: string | null;
  guards: GuardConfig[];
  start: string | null;
  test: string | null;
  build: string | null;
  baseUrl: string | null;
}

function detectRepo(root: string, repo: RepoConfig): RepoDetection {
  const dir = path.join(root, repo.path);
  const prefix = `${repo.path}/`;
  const source: string[] = [];
  const tests: string[] = [];
  const guards: GuardConfig[] = [];
  let start: string | null = null;
  let test: string | null = null;
  let build: string | null = null;
  let baseUrl: string | null = null;

  const pkg = exists(dir, 'package.json') ? readJson(path.join(dir, 'package.json')) : null;
  const scripts =
    pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : null;
  if (scripts) {
    if (typeof scripts.test === 'string') test = `npm --prefix ${repo.path} test`;
    if (typeof scripts.dev === 'string') start = `npm --prefix ${repo.path} run dev`;
    else if (typeof scripts.start === 'string') start = `npm --prefix ${repo.path} start`;
    if (typeof scripts.build === 'string') build = `npm --prefix ${repo.path} run build`;
  }

  if (exists(dir, 'public/index.html')) {
    if (start === null) start = `cd ${repo.path}/public && python3 -m http.server 5180 --bind 127.0.0.1`;
    baseUrl = 'http://127.0.0.1:5180/';
  }

  for (const candidate of ['src', 'app', 'public', 'lib']) {
    if (exists(dir, candidate)) source.push(`${prefix}${candidate}/`);
  }
  if (source.length === 0) source.push(prefix);
  for (const candidate of ['test', 'tests', '__tests__']) {
    if (exists(dir, candidate)) tests.push(`${prefix}${candidate}/`);
  }

  const dbPath = ['db/update.sql', 'sql/update.sql', 'database/update.sql'].find((file) => exists(dir, file)) ?? null;
  if (dbPath) {
    guards.push({
      id: `sql-append-only-${repo.name}`,
      type: 'append-only',
      paths: [`${prefix}${dbPath}`],
      require_header: '-- migration:',
      message: 'SQL 只能追加到文件末尾，且每段以 -- migration: 开头',
    });
    guards.push({
      id: `no-delete-schema-${repo.name}`,
      type: 'no-delete',
      paths: [`${prefix}${dbPath.split('/')[0]}/**`],
      message: '禁止删除数据库相关文件或语句',
    });
  }

  return { source, tests, db: dbPath === null ? null : `${prefix}${dbPath}`, guards, start, test, build, baseUrl };
}

function uniqueValues(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value !== ''))];
}

function repoEntries(root: string, requested?: string[]): RepoConfig[] {
  const paths =
    requested !== undefined && requested.length > 0
      ? requested.map((item) => toPosix(item.trim()).replace(/\/+$/, '')).filter((item) => item !== '')
      : discoverRepos(root);
  if (paths.length === 0) {
    throw new CliError(EXIT.config, '未找到关联仓库；把子仓库放在 workspace 下，或用 --repos 指定');
  }
  const seen = new Set<string>();
  const repos: RepoConfig[] = [];
  for (const repoPath of paths) {
    const name = path.posix.basename(repoPath);
    if (seen.has(name.toLowerCase())) {
      throw new CliError(EXIT.config, `关联仓库名称重复：${name}`);
    }
    seen.add(name.toLowerCase());
    repos.push({ name, path: repoPath });
  }
  return repos;
}

export function initWorkspace(options: WorkspaceInitOptions): WorkspaceInitResult {
  const root = path.resolve(options.root);
  const configPath = projectConfigPath(root);
  if (fs.existsSync(configPath) && options.force !== true) {
    throw new CliError(EXIT.config, `.orca-team-orchestration/config.yaml 已存在；需要覆盖请加 --force`);
  }

  const repos = repoEntries(root, options.repos);
  const warnings: string[] = [];
  let gitInitialized = false;

  const top = gitTopLevel(root);
  if (top !== null && !sameDir(top, root)) {
    throw new CliError(
      EXIT.config,
      `workspace 根位于另一个 git 仓库内（${top}）；请把 workspace 放在独立目录，或移除上级 .git`,
    );
  }
  if (top === null) {
    const init = runGit(root, ['init', '-q']);
    if (!init.ok) throw new CliError(EXIT.config, `git init 失败：${init.stderr.trim()}`);
    gitInitialized = true;
  }

  const detections = repos.map((repo) => detectRepo(root, repo));
  const start = uniqueValues(detections.map((item) => item.start));
  const testCommands = uniqueValues(detections.map((item) => item.test));
  const buildCommands = uniqueValues(detections.map((item) => item.build));
  const baseUrls = uniqueValues(detections.map((item) => item.baseUrl));
  const dbPaths = uniqueValues(detections.map((item) => item.db));

  const config = builtinDefaults(path.basename(root));
  config.project.repos = repos;
  config.project.commands = {
    start: start.length === 1 ? start[0]! : null,
    test: testCommands.length > 0 ? testCommands.join(' && ') : null,
    build: buildCommands.length > 0 ? buildCommands.join(' && ') : null,
    base_url: baseUrls.length === 1 ? baseUrls[0]! : null,
  };
  config.project.paths = {
    features_dir: 'features',
    docs: 'docs',
    source: detections.flatMap((item) => item.source),
    tests: detections.flatMap((item) => item.tests),
    db: dbPaths.length === 1 ? dbPaths[0]! : null,
    evidence: 'docs/v{{version}}/test/evidence',
  };
  config.runtime.worktree = 'path:.';
  config.guards = detections.flatMap((item) => item.guards);

  validateConfig(config as unknown as Record<string, unknown>, { repoRoot: root });
  validateWorkspace(root, config);

  const created: string[] = [];
  const dirs = [
    config.project.paths.features_dir,
    config.project.paths.docs,
    '.orca-team-orchestration/runs',
    '.orca-team-orchestration/approvals',
  ];
  for (const dir of dirs) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) {
      fs.mkdirSync(absolute, { recursive: true });
      created.push(dir);
    }
  }

  writeText(configPath, configToYaml(config));
  created.push('.orca-team-orchestration/config.yaml');

  const ignoreFile = path.join(root, '.gitignore');
  const ignoreBefore = readText(ignoreFile) ?? '';
  const ignoreAfter = upsertManagedIgnore(ignoreBefore, repos);
  if (ignoreAfter !== ignoreBefore) {
    writeText(ignoreFile, ignoreAfter);
    created.push('.gitignore');
  }

  let commit: string | null = null;
  if (!gitHasHead(root) && options.commit !== false) {
    const add = runGit(root, ['add', '--', '.gitignore', '.orca-team-orchestration/config.yaml']);
    const committed = add.ok
      ? runGit(root, [
          'commit',
          '-q',
          '-m',
          'chore: orca-team-orchestration workspace init',
          '--',
          '.gitignore',
          '.orca-team-orchestration/config.yaml',
        ])
      : add;
    if (committed.ok) {
      const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
      commit = head.ok ? head.stdout.trim() : null;
    } else {
      warnings.push(
        `初始提交失败（可能缺少 git identity）：${(committed.stderr || committed.stdout).trim()}；可稍后手动提交脚手架`,
      );
    }
  }

  const hooks: WorkspaceInitResult['hooks'] = [];
  if (options.installHook !== false && options.cliEntry) {
    const rootHook = installPreCommitHook(root, options.cliEntry);
    hooks.push({ repo: 'workspace', status: rootHook.status, backup: rootHook.backup, file: rootHook.file });
    for (const repo of repos) {
      const childHook = installPreCommitHook(path.join(root, repo.path), options.cliEntry, {
        workspaceRoot: root,
        stagedRepo: repo.name,
      });
      hooks.push({ repo: repo.name, status: childHook.status, backup: childHook.backup, file: childHook.file });
    }
  }

  if (config.project.commands.start === null) {
    warnings.push(
      `未自动确定启动命令（候选：${start.join(' / ') || '无'}）；用 config --start 指定`,
    );
  }
  if (config.project.commands.base_url === null && baseUrls.length > 1) {
    warnings.push(`检测到多个页面基址（${baseUrls.join(', ')}）；用 config --base-url 指定一个`);
  }

  return {
    configPath,
    created,
    commit,
    gitInitialized,
    repos,
    hooks,
    ignored: repos.map((repo) => `/${repo.path}/`),
    warnings,
  };
}
