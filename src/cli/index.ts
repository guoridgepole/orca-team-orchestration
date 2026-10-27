#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { parseArgs, flagBool, flagList, flagString, type ParsedArgs } from './args.js';
import {
  checkpointManagedPaths,
  configToYaml,
  loadConfig,
  projectConfigPath,
  stageRoles,
  updateProjectCommands,
  type Config,
} from '../core/config.js';
import { artifactIssues, scopeIssues, scopeIssuesForWorkspace } from '../core/checks.js';
import { runRoleCommandChecks } from '../core/commands.js';
import { createApproval, listApprovals, settleViolations } from '../core/approvals.js';
import { hookStatus } from '../core/hooks.js';
import { CliError, EXIT, PromptError } from '../core/errors.js';
import { renderRolePrompt } from '../core/prompts.js';
import { findRepoRoot, readText, writeText } from '../core/paths.js';
import { checkpointCommit, checkpointCommits, gitCommit, gitHasHead, headCommit, headCommits, runGit } from '../core/git.js';
import { formatViolations, runGuards, type Violation } from '../core/guards.js';
import { initProject, initWorkspace } from '../core/init.js';
import { agentBinary, findExecutable, ORCA_INSTALL_HINT, requireAgentAvailable, requireOrca, resolveOrcaBinary } from '../core/orca.js';
import { runStory } from '../core/runner.js';
import { OrcaAdapter } from '../adapters/orca/adapter.js';
import { startUiServer } from '../ui/server.js';
import {
  findWorkspaceRoot,
  validateWorkspace,
  type WorkspaceLayout,
} from '../core/workspace.js';
import {
  buildRunState,
  listStates,
  nextStage,
  readState,
  snapshotSpec,
  specHashMatches,
  statePath,
  storyStatus,
  writeState,
  type RunState,
} from '../core/state.js';
import {
  findStoryFiles,
  loadStory,
  newStorySkeleton,
  parseStoryContent,
  requireVersion,
  storyPath,
  versionFromStory,
  StoryLintError,
  type StoryIssue,
} from '../core/story.js';

const HELP = `orca-team-orchestration v0.0.0

用法：orca-team-orchestration <命令> [参数]

  init [--force] [--baseline] [--orca-add]   接入当前 git 仓库（需先安装 Orca）
  init --workspace [--repos a,b] [--no-commit]
                                            把父目录接入为多仓 workspace（嵌套仓库）
  config [--print] [--start CMD] [--test CMD] [--base-url URL]
                                            补全启动/测试命令与基址
  new <story> [--title 标题] [--no-commit]   创建 features/<story>.md 骨架
  list [--all] [--json]                      列出 story 与状态
  lint [<story>] [--json]                    校验需求文件格式
  start [<story>] [--dry-run] [--orchestrator auto|orca]
                                            切快照、建 run 并自动推进阶段
  resume <story> [--refresh-spec]            从运行状态继续执行
  accept <story>                             记录需求方验收
  status [<story>] [--json]                  查看运行状态与下一步
  check <design|review|develop|test> <story> [--round N]
                                            阶段校验：产物 + 写范围 + 守则 + 命令检查
  render <role> <story> [--round N] [--stage S] [--previous PATH] [--json]
                                            打印渲染后的角色提示词（调试用）
  explain <story> [--json]                   解释下一步该做什么、为什么
  guard run [--id ID] [--staged] [--staged-repo <name|all>] [--json]
                                            单独运行守则（含审批豁免）
  guard allow <id> --reason 原因 [--by 姓名]  为当次基线的守则违规留痕放行
  guard approvals [--json]                   列出最近的守则审批记录
  ui [--port N]                              启动当前项目的角色提示词配置页面
  doctor [--json]                            环境自检

全局参数：--repo <路径>（默认当前 git 仓库根目录；在关联仓库内执行时自动解析到 workspace 根）

退出码：0 成功 / 1 校验失败 / 2 用法 / 3 配置或需求文件非法 /
        4 编排器不可用 / 5 agent 不可用 / 6 守则违规 / 7 轮次超限

说明：init 强制要求安装 Orca；auto 模式检测不到 Orca 时会提示安装，不再降级。`;

function out(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function repoRootFrom(args: ParsedArgs): string {
  const override = flagString(args, 'repo') ?? process.env.ORCA_TEAM_ORCHESTRATION_REPO;
  if (override) return path.resolve(override);
  const gitRoot = findRepoRoot();
  if (fs.existsSync(projectConfigPath(gitRoot))) return gitRoot;
  return findWorkspaceRoot(gitRoot) ?? gitRoot;
}

// 单仓配置返回 undefined，保持旧行为；多仓配置先做文件系统校验。
function workspaceLayoutFor(root: string, config: Config): WorkspaceLayout | undefined {
  if ((config.project.repos ?? []).length === 0) return undefined;
  return validateWorkspace(root, config);
}

function printCommits(commits: { repo: string; sha: string }[], layout: WorkspaceLayout | undefined): void {
  for (const commit of commits) {
    out(layout ? `检查点提交 ${commit.repo}@${commit.sha}` : `检查点提交 ${commit.sha}`);
  }
}

function ignoreCovers(root: string, target: string): boolean {
  const raw = readText(path.join(root, '.gitignore')) ?? '';
  const normalized = target.replace(/^\/+|\/+$/g, '');
  return raw.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === normalized || trimmed === `${normalized}/` || trimmed === `/${normalized}/`;
  });
}

function absoluteEquals(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function requirePositional(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positionals[index];
  if (!value) throw new CliError(EXIT.usage, `用法：${usage}`);
  return value;
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function parseRound(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const round = Number(raw);
  if (!Number.isInteger(round) || round < 1) throw new CliError(EXIT.usage, `轮次必须是正整数：${raw}`);
  return round;
}

function latestRound(root: string, config: Config, stage: string, story: string): number {
  let max = 0;
  const version = versionFromStory(story) ?? '{{version}}';
  for (const roleName of stageRoles(config, stage)) {
    const role = config.roles[roleName];
    if (!role) continue;
    const relPattern = role.artifact.path
      .replaceAll('{{story}}', story)
      .replaceAll('{{round}}', '*')
      .replaceAll('{{version}}', version);
    const dir = path.join(root, path.dirname(relPattern));
    const filePattern = path.basename(relPattern);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!minimatch(entry, filePattern)) continue;
      const match = /-r(\d+)\.md$/.exec(entry);
      if (match?.[1]) max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

function resolveOrchestrator(config: Config, requested: string | undefined): 'orca' {
  const value = requested ?? config.runtime.orchestrator;
  if (value !== 'auto' && value !== 'orca') {
    throw new CliError(EXIT.usage, `--orchestrator 只能是 auto / orca；本工具必须依赖 Orca`);
  }
  requireOrca();
  return 'orca';
}

function createOrchestrator(root: string, config: Config): OrcaAdapter {
  requireOrca();
  return new OrcaAdapter({
    repoRoot: root,
    worktree: config.runtime.worktree ?? 'path:.',
    timeoutMs: config.runtime.timeout_minutes * 60_000,
  });
}

// 派发前预检：flow 中各角色绑定的 agent 命令必须存在于本机 PATH，
// 否则直接以退出码 5 失败，避免配了未安装的 agent 才在 Orca 侧报错。
function requireFlowAgentsAvailable(config: Config): void {
  const kinds = new Set<string>();
  for (const stage of ['design', 'review', 'develop', 'test']) {
    for (const roleName of stageRoles(config, stage)) {
      const agentName = config.roles[roleName]?.agent;
      if (agentName) kinds.add(config.agents[agentName]?.kind ?? agentName);
    }
  }
  for (const kind of kinds) requireAgentAvailable(kind);
}

function reportRuntimeDiscoveryHint(config: Config): void {
  const missing = [
    !config.project.commands.start ? 'start' : null,
    !config.project.commands.test ? 'test' : null,
    !config.project.commands.base_url ? 'base_url' : null,
  ].filter((item): item is string => item !== null);
  if (missing.length === 0) return;
  out(`\n运行信息未配置：${missing.join(', ')}`);
  out('  不配置也可运行：各角色会在运行前自行识别；需要固定时用 orca-team-orchestration config 补全');
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  if (flagBool(args, 'workspace')) return cmdInitWorkspace(args);
  const root = repoRootFrom(args);
  const orca = requireOrca();
  const result = initProject({
    repoRoot: root,
    force: flagBool(args, 'force'),
    baseline: flagBool(args, 'baseline'),
    installHook: !flagBool(args, 'no-hook'),
    cliEntry: fileURLToPath(import.meta.url),
  });
  out(`已接入：${root}`);
  out(`  Orca    ${orca}`);
  for (const item of result.created) out(`  创建 ${item}`);
  if (result.commit) out(`  提交 ${result.commit}`);
  if (result.hook.status === 'installed' || result.hook.status === 'updated') {
    out(`  hook    pre-commit ${result.hook.status}${result.hook.backup ? `（原 hook 已备份为 ${path.basename(result.hook.backup)}）` : ''}`);
  } else if (result.hook.status === 'unchanged') {
    out('  hook    pre-commit 已安装');
  } else {
    out('  hook    跳过（非 git 仓库或 --no-hook）');
  }

  const config = loadConfig(root);
  reportRuntimeDiscoveryHint(config);
  if (flagBool(args, 'orca-add')) {
    const added = spawnSync(orca, ['repo', 'add', '--path', root, '--json'], { encoding: 'utf8' });
    out(`\nOrca 注册：${added.status === 0 ? 'OK' : 'FAILED'}`);
    if (added.status !== 0) out((added.stderr || added.stdout).trim());
  }
  out('\n下一步：在 features/ 下写需求，然后 orca-team-orchestration list');
  out('配置角色提示词：orca-team-orchestration ui');
  return EXIT.ok;
}

async function cmdInitWorkspace(args: ParsedArgs): Promise<number> {
  const root = path.resolve(flagString(args, 'repo') ?? process.env.ORCA_TEAM_ORCHESTRATION_REPO ?? process.cwd());
  const orca = requireOrca();
  const requested = flagList(args, 'repos');
  const result = initWorkspace({
    root,
    ...(requested.length > 0 ? { repos: requested } : {}),
    force: flagBool(args, 'force'),
    commit: !flagBool(args, 'no-commit'),
    installHook: !flagBool(args, 'no-hook'),
    cliEntry: fileURLToPath(import.meta.url),
  });

  out(`已接入 workspace：${result.configPath.replace(/\/\.orca-team-orchestration\/config\.yaml$/, '')}`);
  out(`  Orca    ${orca}`);
  if (result.gitInitialized) out('  git     git init 已完成');
  out(`  关联仓库 ${result.repos.map((repo) => `${repo.name}（${repo.path}/）`).join('、')}`);
  for (const item of result.created) out(`  创建 ${item}`);
  if (result.ignored.length > 0) out(`  .gitignore ${result.ignored.join(' ')} .orca-team-orchestration/runs/`);
  if (result.commit) out(`  提交 ${result.commit}`);
  for (const hook of result.hooks) {
    if (hook.status === 'installed' || hook.status === 'updated') {
      out(`  hook    ${hook.repo} pre-commit ${hook.status}${hook.backup ? `（原 hook 已备份为 ${path.basename(hook.backup)}）` : ''}`);
    } else if (hook.status === 'unchanged') {
      out(`  hook    ${hook.repo} pre-commit 已安装`);
    } else {
      out(`  hook    ${hook.repo} 跳过`);
    }
  }
  for (const warning of result.warnings) out(`  warning ${warning}`);

  const config = loadConfig(root);
  reportRuntimeDiscoveryHint(config);
  if (flagBool(args, 'orca-add')) {
    const added = spawnSync(orca, ['repo', 'add', '--path', root, '--json'], { encoding: 'utf8' });
    out(`\nOrca 注册（workspace 根）：${added.status === 0 ? 'OK' : 'FAILED'}`);
    if (added.status !== 0) out((added.stderr || added.stdout).trim());
  }
  out('\n下一步：在 features/ 下写需求，然后 orca-team-orchestration list');
  out('配置角色提示词：orca-team-orchestration ui');
  return EXIT.ok;
}

async function cmdConfig(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  if (flagBool(args, 'global')) {
    throw new CliError(EXIT.usage, '--global 将在后续版本提供；目前只写项目配置');
  }
  const start = flagString(args, 'start');
  const test = flagString(args, 'test');
  const baseUrl = flagString(args, 'base-url');

  if (start !== undefined || test !== undefined || baseUrl !== undefined) {
    updateProjectCommands(root, {
      ...(start !== undefined ? { start } : {}),
      ...(test !== undefined ? { test } : {}),
      ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
    });
  } else if (flagBool(args, 'print')) {
    out(configToYaml(loadConfig(root)));
    return EXIT.ok;
  } else if (process.stdin.isTTY) {
    const current = loadConfig(root);
    const values: { start?: string; test?: string; base_url?: string } = {};
    const answers: Array<[keyof typeof values, string, string | null | undefined]> = [
      ['start', '启动命令', current.project.commands.start],
      ['test', '测试命令', current.project.commands.test],
      ['base_url', '访问基址', current.project.commands.base_url],
    ];
    for (const [key, label, existing] of answers) {
      const answer = await ask(`${label}${existing ? ` [${existing}]` : ''}: `);
      if (answer) values[key] = answer;
    }
    updateProjectCommands(root, values);
  } else {
    throw new CliError(EXIT.usage, '非交互环境请用 --start / --test / --base-url');
  }

  const config = loadConfig(root);
  out('已更新 .orca-team-orchestration/config.yaml');
  out(`  启动：${config.project.commands.start ?? '(未设置)'}`);
  out(`  测试：${config.project.commands.test ?? '(未设置)'}`);
  out(`  基址：${config.project.commands.base_url ?? '(未设置)'}`);
  return EXIT.ok;
}

async function cmdNew(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const story = requirePositional(args, 0, 'orca-team-orchestration new <story> [--title 标题]');
  requireVersion(story);
  const config = loadConfig(root);
  const file = storyPath(root, config.project.paths.features_dir, story);
  if (fs.existsSync(file)) {
    throw new CliError(EXIT.validation, `需求文件已存在：${path.relative(root, file)}`);
  }
  const title = flagString(args, 'title')?.trim() || story;
  writeText(file, newStorySkeleton(story, title));
  out(`已创建 ${path.relative(root, file)}`);

  if (config.runtime.checkpoint_commits && !flagBool(args, 'no-commit')) {
    const commit = gitCommit(root, `story: ${story}`, [path.relative(root, file)]);
    if (commit) out(`  提交 ${commit}`);
  }
  out('下一步：填写功能清单与验收标准，然后 orca-team-orchestration lint ' + story);
  return EXIT.ok;
}

interface StoryRow {
  id: string;
  title: string;
  features: number;
  acceptance: number;
  status: string;
  issues: number;
  specChanged: boolean;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  const states = new Map(listStates(root).map((state) => [state.story, state]));
  const showAll = flagBool(args, 'all');
  const rows: StoryRow[] = [];

  for (const file of findStoryFiles(root, config.project.paths.features_dir)) {
    const id = path.basename(file, '.md');
    const content = readText(file) ?? '';
    const { story, issues } = parseStoryContent(content, id, file);
    const state = states.get(id) ?? null;
    const status = issues.length > 0 ? '非法' : storyStatus(state, config);
    if (!showAll && status === '已验收') continue;
    rows.push({
      id,
      title: story.title || '(无标题)',
      features: story.features.length,
      acceptance: story.acceptance.length,
      status,
      issues: issues.length,
      specChanged: state ? !specHashMatches(root, state) : false,
    });
  }

  if (flagBool(args, 'json')) {
    out(JSON.stringify(rows, null, 2));
    return EXIT.ok;
  }
  if (rows.length === 0) {
    out('features/ 下还没有 story；用 orca-team-orchestration new <story> --title "..." 创建');
    return EXIT.ok;
  }
  out('ID\t状态\t功能\t验收\t标题');
  for (const row of rows) {
    const changed = row.specChanged ? '（快照已变更）' : '';
    out(`${row.id}\t${row.status}\t${row.features}\t${row.acceptance}\t${row.title}${changed}`);
  }
  out(`\n共 ${rows.length} 条${showAll ? '' : '（已验收的已隐藏，加 --all 查看）'}`);
  return EXIT.ok;
}

async function cmdLint(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  const story = args.positionals[0];
  const files = story
    ? [storyPath(root, config.project.paths.features_dir, story)]
    : findStoryFiles(root, config.project.paths.features_dir);

  const results: Array<{ file: string; issues: StoryIssue[] }> = [];
  for (const file of files) {
    const id = path.basename(file, '.md');
    const content = readText(file);
    if (content === null) {
      results.push({ file: path.relative(root, file), issues: [{ line: 1, message: '文件不存在' }] });
      continue;
    }
    const { issues } = parseStoryContent(content, id, file);
    if (issues.length > 0) results.push({ file: path.relative(root, file), issues });
  }

  if (flagBool(args, 'json')) {
    out(JSON.stringify(results, null, 2));
  } else if (results.length === 0) {
    out(`LINT: PASS（${files.length} 个文件）`);
  } else {
    for (const result of results) {
      out(`${result.file}`);
      for (const issue of result.issues) out(`  第 ${issue.line} 行：${issue.message}`);
    }
  }
  return results.length === 0 ? EXIT.ok : EXIT.config;
}

async function pickStory(root: string, config: Config): Promise<string> {
  const items: Array<{ id: string; title: string; status: string }> = [];
  const states = new Map(listStates(root).map((state) => [state.story, state]));
  for (const file of findStoryFiles(root, config.project.paths.features_dir)) {
    const id = path.basename(file, '.md');
    const content = readText(file) ?? '';
    const { story, issues } = parseStoryContent(content, id, file);
    if (issues.length > 0) continue;
    items.push({ id, title: story.title, status: storyStatus(states.get(id) ?? null, config) });
  }
  if (items.length === 0) throw new CliError(EXIT.config, '没有可执行的 story；先写 features/<story>.md');
  out('可执行的 story：');
  items.forEach((item, index) => out(`  ${index + 1}) ${item.id}  ${item.title}  [${item.status}]`));
  const answer = await ask('选择编号: ');
  const index = Number(answer) - 1;
  const selected = items[index];
  if (!selected) throw new CliError(EXIT.usage, `无效选择：${answer}`);
  return selected.id;
}

async function cmdStart(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  workspaceLayoutFor(root, config);
  let story = args.positionals[0];
  if (!story) {
    if (!process.stdin.isTTY) throw new CliError(EXIT.usage, '非交互环境请显式指定 story');
    story = await pickStory(root, config);
  }
  const parsed = loadStory(root, config.project.paths.features_dir, story);

  const missingDeps: string[] = [];
  for (const dependency of parsed.meta.dependsOn) {
    const depState = readState(root, dependency);
    if (!depState?.acceptedAt) missingDeps.push(dependency);
  }
  if (missingDeps.length > 0 && !flagBool(args, 'ignore-deps')) {
    throw new CliError(
      EXIT.validation,
      `依赖尚未验收：${missingDeps.join(', ')}；确认要开始请加 --ignore-deps`,
    );
  }

  const dryRun = flagBool(args, 'dry-run');
  if (!dryRun && readState(root, parsed.id)) {
    throw new CliError(
      EXIT.config,
      `story ${parsed.id} 已有运行记录；继续执行请用 orca-team-orchestration resume ${parsed.id}`,
    );
  }

  const orchestratorName = resolveOrchestrator(config, flagString(args, 'orchestrator'));
  requireFlowAgentsAvailable(config);
  const sourceFile = storyPath(root, config.project.paths.features_dir, parsed.id);
  const content = readText(sourceFile) ?? '';
  const spec = snapshotSpec(root, parsed.id, content, config.project.paths.features_dir);
  const state = buildRunState(config, parsed, spec, orchestratorName);

  out(`已创建 run ${state.runId}`);
  out(`  story   ${state.story}  ${state.title}`);
  out(`  功能    ${state.features.join(', ') || '(无)'}`);
  out(`  验收    ${state.acceptance.length} 条`);
  out(`  快照    ${state.spec.snapshot}（sha256 ${state.spec.sha256.slice(0, 12)}…）`);
  out(`  编排    ${orchestratorName}`);

  if (dryRun) {
    out(`\nDRY-RUN：下一步是 ${nextStage(config, state)}`);
    return EXIT.ok;
  }

  writeState(root, state);
  const orchestrator = createOrchestrator(root, config);
  const result = await runStory({
    root,
    config,
    state,
    orchestrator,
    interactive: process.stdin.isTTY,
    ask,
    log: out,
  });
  return result.exitCode;
}

async function cmdResume(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  workspaceLayoutFor(root, config);
  const story = requirePositional(args, 0, 'orca-team-orchestration resume <story> [--refresh-spec]');
  const state = readState(root, story);
  if (!state) {
    throw new CliError(EXIT.config, `story ${story} 尚未开始；先运行 orca-team-orchestration start ${story}`);
  }

  const sourceFile = storyPath(root, config.project.paths.features_dir, story);
  const content = readText(sourceFile);
  if (content === null) {
    throw new CliError(EXIT.config, `需求文件不存在：${path.relative(root, sourceFile)}`);
  }

  if (!specHashMatches(root, state)) {
    if (!flagBool(args, 'refresh-spec')) {
      throw new CliError(
        EXIT.config,
        `需求文件自快照后已变更；确认后加 --refresh-spec 重新建立快照（验收范围变化会回到 DESIGN）`,
      );
    }
    if (state.pending) {
      throw new CliError(
        EXIT.config,
        '存在未完成的派发，不能刷新需求快照；请先再次 resume 等待该派发结束',
      );
    }
    const parsed = loadStory(root, config.project.paths.features_dir, story);
    const previousPath = path.join(root, state.spec.snapshot);
    const previous = parseStoryContent(readText(previousPath) ?? '', story, previousPath).story;
    const acceptanceChanged =
      JSON.stringify(previous.acceptance.map((item) => [item.id, item.description])) !==
      JSON.stringify(parsed.acceptance.map((item) => [item.id, item.description]));
    const featuresChanged =
      JSON.stringify(previous.features.map((item) => [item.id, item.description])) !==
      JSON.stringify(parsed.features.map((item) => [item.id, item.description]));
    const spec = snapshotSpec(root, story, content, config.project.paths.features_dir);
    state.spec = spec;
    state.features = parsed.features.map((item) => item.id);
    state.acceptance = parsed.acceptance.map((item) => item.id);
    if (acceptanceChanged || featuresChanged) {
      state.stages = {};
      state.history = [];
      delete state.gate;
      delete state.acceptedAt;
      out('验收范围已变更，已回到 DESIGN 阶段重新审核');
    } else {
      out('需求快照已刷新');
    }
    writeState(root, state);
  }

  const orchestrator = createOrchestrator(root, config);
  requireFlowAgentsAvailable(config);
  const result = await runStory({
    root,
    config,
    state,
    orchestrator,
    interactive: process.stdin.isTTY,
    ask,
    log: out,
  });
  return result.exitCode;
}

async function cmdAccept(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  const layout = workspaceLayoutFor(root, config);
  const story = requirePositional(args, 0, 'orca-team-orchestration accept <story>');
  const state = readState(root, story);
  if (!state) {
    throw new CliError(EXIT.config, `story ${story} 尚未开始`);
  }
  if (state.acceptedAt) {
    out(`${story} 已于 ${state.acceptedAt} 验收`);
    return EXIT.ok;
  }
  if (state.gate) {
    throw new CliError(EXIT.validation, `存在未处理的 gate：${state.gate.stage} r${state.gate.round}`);
  }
  const stage = nextStage(config, state);
  if (stage !== 'accept') {
    throw new CliError(
      EXIT.validation,
      `尚未完成所有阶段（下一步：${stage}）；完成后再记录验收`,
    );
  }

  const parsed = loadStory(root, config.project.paths.features_dir, story);
  const version = requireVersion(story);
  const now = new Date().toISOString();
  const relative = path
    .join(config.project.paths.docs, `v${version}`, 'test', `${story}-accept.md`)
    .split(path.sep)
    .join('/');
  const lines = [
    `# ACCEPT ${story} ${state.title}`,
    '',
    `- 验收时间：${now}`,
    `- 验收角色：${config.flow.accept ?? 'coordinator'}`,
    '',
    '## 功能',
    '',
    ...parsed.features.map((feature) => `- [x] ${feature.id} ${feature.description}`),
    '',
    '## 验收标准',
    '',
    ...parsed.acceptance.map((item) => `- [x] ${item.id} ${item.description}`),
    '',
  ];
  writeText(path.join(root, relative), lines.join('\n'));
  state.acceptedAt = now;
  state.stages.accept = { round: 1, status: 'passed', artifact: relative };
  writeState(root, state);
  if (config.runtime.checkpoint_commits) {
    if (layout) {
      const commits = checkpointCommits(layout, `accept: ${story}`, {
        managedPaths: checkpointManagedPaths(config, story),
      });
      printCommits(commits, layout);
    } else {
      const commit = checkpointCommit(root, `accept: ${story}`);
      if (commit) out(`检查点提交 ${commit}`);
    }
  }
  out(`已记录验收：${story}（${relative}）`);
  return EXIT.ok;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  const story = args.positionals[0];

  if (story) {
    const state = readState(root, story);
    if (!state) {
      out(`story ${story} 尚未开始`);
      return EXIT.ok;
    }
    const payload = {
      ...state,
      status: storyStatus(state, config),
      next: nextStage(config, state),
      specChanged: !specHashMatches(root, state),
    };
    if (flagBool(args, 'json')) {
      out(JSON.stringify(payload, null, 2));
      return EXIT.ok;
    }
    out(`${state.story}  ${state.title}`);
    out(`  状态      ${payload.status}`);
    out(`  下一步    ${payload.next}`);
    out(`  编排器    ${state.orchestrator}`);
    out(`  run       ${state.runId}`);
    out(`  快照      ${state.spec.snapshot}${payload.specChanged ? '（需求文件已变更）' : ''}`);
    if (state.orca?.runId) out(`  Orca run  ${state.orca.runId}`);
    if (state.pending) {
      out(`  等待      ${state.pending.stage}/${state.pending.role} r${state.pending.round}`);
    }
    if (state.gate) {
      out(`  gate      ${state.gate.stage} r${state.gate.round}：${state.gate.question}`);
    }
    for (const [stage, value] of Object.entries(state.stages)) {
      out(`  ${stage.padEnd(8)} r${value.round}  ${value.status}${value.artifact ? `  ${value.artifact}` : ''}`);
    }
    return EXIT.ok;
  }

  const states = new Map(listStates(root).map((state) => [state.story, state]));
  const stories = findStoryFiles(root, config.project.paths.features_dir).map((file) => {
    const id = path.basename(file, '.md');
    const state = states.get(id) ?? null;
    return { id, status: storyStatus(state, config), next: state ? nextStage(config, state) : 'design' };
  });
  if (flagBool(args, 'json')) {
    out(JSON.stringify({ project: config.project.name, stories }, null, 2));
    return EXIT.ok;
  }
  out(`${config.project.name ?? path.basename(root)}  ${root}`);
  out(`  编排器    ${config.runtime.orchestrator}`);
  out(`  轮次上限  设计⇄审核 ${config.runtime.max_rounds.design_review} / 开发⇄测试 ${config.runtime.max_rounds.dev_test}`);
  out(`  角色      ${Object.keys(config.roles).join(', ')}`);
  out(`  守则      ${config.guards.map((guard) => guard.id).join(', ') || '(无)'}`);
  out('');
  if (stories.length === 0) {
    out('还没有 story');
  } else {
    for (const item of stories) out(`  ${item.id}\t${item.status}\t下一步 ${item.next}`);
  }
  return EXIT.ok;
}

async function cmdRender(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const role = requirePositional(
    args,
    0,
    'orca-team-orchestration render <role> <story> [--round N] [--stage S] [--previous PATH] [--json]',
  );
  const story = requirePositional(
    args,
    1,
    'orca-team-orchestration render <role> <story> [--round N] [--stage S] [--previous PATH] [--json]',
  );
  const config = loadConfig(root);
  const roundRaw = flagString(args, 'round');
  const options = {
    story,
    ...(roundRaw !== undefined ? { round: parseRound(roundRaw, 1) } : {}),
    ...(flagString(args, 'stage') !== undefined ? { stage: flagString(args, 'stage')! } : {}),
    ...(flagString(args, 'previous') !== undefined
      ? { previousArtifact: flagString(args, 'previous')! }
      : {}),
  };
  const rendered = renderRolePrompt(root, config, role, options);

  if (flagBool(args, 'json')) {
    out(JSON.stringify(rendered, null, 2));
    return EXIT.ok;
  }
  for (const warning of rendered.warnings) process.stderr.write(`warning: ${warning}\n`);
  out(rendered.prompt);
  return EXIT.ok;
}

function formatBaselines(approval: { baseline: string; baselines?: Record<string, string> }, length: number): string {
  if (!approval.baselines || Object.keys(approval.baselines).length === 0) {
    return approval.baseline.slice(0, length) || '(无 HEAD)';
  }
  return Object.entries(approval.baselines)
    .map(([name, sha]) => `${name}@${sha.slice(0, length) || '(无 HEAD)'}`)
    .join(' ');
}

async function cmdGuard(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const sub = args.positionals[0];

  if (sub === 'allow') {
    const guardId = requirePositional(args, 1, 'orca-team-orchestration guard allow <id> --reason "..."');
    const reason = flagString(args, 'reason');
    if (!reason) throw new CliError(EXIT.usage, 'guard allow 必须提供 --reason');
    const config = loadConfig(root);
    const layout = workspaceLayoutFor(root, config);
    if (!config.guards.some((guard) => guard.id === guardId)) {
      throw new CliError(EXIT.usage, `未知守则：${guardId}`);
    }
    const requester = flagString(args, 'by') ?? process.env.USER ?? process.env.USERNAME ?? 'unknown';
    const approval = createApproval(root, guardId, reason, requester, layout);
    out(`已放行：${guardId}（基线 ${formatBaselines(approval, 12)}，下次提交后失效）`);
    out(`  审批 ${approval.file}`);
    return EXIT.ok;
  }

  if (sub === 'approvals') {
    const approvals = listApprovals(root);
    if (flagBool(args, 'json')) {
      out(JSON.stringify(approvals, null, 2));
      return EXIT.ok;
    }
    if (approvals.length === 0) {
      out('暂无审批记录');
      return EXIT.ok;
    }
    for (const approval of approvals) {
      out(`${approval.createdAt}  ${approval.guardId}  基线 ${formatBaselines(approval, 8)}  ${approval.requester}：${approval.reason}`);
    }
    return EXIT.ok;
  }

  if (sub !== 'run') {
    throw new CliError(EXIT.usage, '用法：orca-team-orchestration guard run|allow|approvals [...]');
  }
  const config = loadConfig(root);
  const layout = workspaceLayoutFor(root, config);
  const staged = flagBool(args, 'staged');
  const stagedRepo = flagString(args, 'staged-repo');
  if (stagedRepo !== undefined) {
    if (!staged) throw new CliError(EXIT.usage, '--staged-repo 需要与 --staged 一起使用');
    if (!layout) throw new CliError(EXIT.usage, '当前项目未配置关联仓库，不能使用 --staged-repo');
  }
  const ids = flagList(args, 'id');
  const violations = runGuards(root, config.guards, {
    staged,
    ids: ids.length > 0 ? ids : undefined,
    ...(layout ? { layout } : {}),
    ...(stagedRepo === undefined ? {} : { stagedRepo }),
  });
  const { blocking, approved } = settleViolations(root, violations, layout);
  if (flagBool(args, 'json')) {
    out(JSON.stringify({ violations: blocking, approved }, null, 2));
  } else if (blocking.length === 0) {
    out('GUARD: PASS');
    for (const violation of approved) out(`APPROVED [${violation.guardId}] ${violation.file}`);
  } else {
    out(`GUARD: FAIL（${blocking.length} 项）`);
    out(formatViolations(blocking));
    for (const violation of approved) out(`APPROVED [${violation.guardId}] ${violation.file}`);
    out('如需带审计放行：orca-team-orchestration guard allow <id> --reason "..."');
  }
  return blocking.length === 0 ? EXIT.ok : EXIT.guard;
}

async function cmdCheck(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const stage = requirePositional(args, 0, 'orca-team-orchestration check <design|review|develop|test> <story>');
  const story = requirePositional(args, 1, 'orca-team-orchestration check <design|review|develop|test> <story>');
  if (!['design', 'review', 'develop', 'test'].includes(stage)) {
    throw new CliError(EXIT.usage, `未知阶段：${stage}`);
  }
  const config = loadConfig(root);
  const layout = workspaceLayoutFor(root, config);
  const state = readState(root, story);
  const fallbackRound = latestRound(root, config, stage, story) || 1;
  const rounds = parseRound(flagString(args, 'round'), state?.stages[stage]?.round ?? fallbackRound);

  const artifact = artifactIssues(root, config, stage, story, rounds);
  const scope = layout
    ? scopeIssuesForWorkspace(layout, config, stage, story)
    : scopeIssues(root, config, stage, story);
  const settled = settleViolations(
    root,
    runGuards(root, config.guards, layout ? { layout } : {}),
    layout,
  );
  const guards: Violation[] = settled.blocking;
  const commandResults = stageRoles(config, stage).map((roleName) =>
    runRoleCommandChecks(root, config, roleName, stage, story, rounds),
  );
  const commandIssues = commandResults.flatMap((item) => item.issues);
  const commands = commandResults.flatMap((item) => item.results);

  if (flagBool(args, 'json')) {
    out(
      JSON.stringify(
        { stage, story, round: rounds, artifact, scope, guards, approved: settled.approved, commands, commandIssues },
        null,
        2,
      ),
    );
  } else {
    for (const issue of artifact) out(`ARTIFACT FAIL  ${issue.message}`);
    for (const issue of scope) out(`SCOPE FAIL     ${issue.message}`);
    if (guards.length > 0) out(`GUARD FAIL\n${formatViolations(guards)}`);
    for (const violation of settled.approved) out(`GUARD APPROVED [${violation.guardId}] ${violation.file}`);
    for (const issue of commandIssues) out(`COMMAND FAIL   ${issue.message}`);
    for (const command of commands.filter((item) => item.ok)) {
      out(`COMMAND PASS   ${command.name}（${command.role}）`);
    }
    if (artifact.length === 0 && scope.length === 0 && guards.length === 0 && commandIssues.length === 0) {
      out(`STAGE-CHECK: PASS（${stage} ${story} r${rounds}）`);
    } else {
      out(
        `STAGE-CHECK: FAIL（产物 ${artifact.length} / 范围 ${scope.length} / 守则 ${guards.length} / 命令 ${commandIssues.length}）`,
      );
    }
  }

  if (guards.length > 0) return EXIT.guard;
  return artifact.length > 0 || scope.length > 0 || commandIssues.length > 0 ? EXIT.validation : EXIT.ok;
}

async function cmdExplain(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const config = loadConfig(root);
  const story = requirePositional(args, 0, 'orca-team-orchestration explain <story>');
  const state = readState(root, story);
  const reasons: string[] = [];
  const actions: string[] = [];
  let next = 'start';

  if (!state) {
    reasons.push('尚未建立运行记录');
    actions.push(`orca-team-orchestration lint ${story}`, `orca-team-orchestration start ${story} --dry-run`);
  } else {
    next = state.acceptedAt ? 'done' : state.gate ? 'gate' : nextStage(config, state);
    if (!specHashMatches(root, state)) {
      reasons.push('需求文件在建立快照后被修改，阶段结论可能对应旧需求');
      actions.push(`orca-team-orchestration resume ${story} --refresh-spec`);
    }
    if (state.acceptedAt) {
      reasons.push(`已于 ${state.acceptedAt} 验收`);
    } else if (state.gate) {
      reasons.push(`gate：${state.gate.stage} r${state.gate.round} — ${state.gate.question.split('\n')[0]}`);
      actions.push(`处理 gate 后执行 orca-team-orchestration resume ${story}`);
    } else if (next === 'done') {
      reasons.push('所有阶段已通过');
    } else if (next === 'accept') {
      reasons.push('design/review/develop/test 全部通过，等待需求方验收');
      actions.push(`orca-team-orchestration accept ${story}`);
    } else {
      const round = state.stages[next]?.round ?? 1;
      const limit =
        next === 'design' || next === 'review'
          ? config.runtime.max_rounds.design_review
          : config.runtime.max_rounds.dev_test;
      const roles = stageRoles(config, next);
      reasons.push(`下一步是 ${next} 阶段（第 ${round}/${limit} 轮），角色：${roles.join(', ') || '(无)'}`);
      if (state.pending) {
        reasons.push(`存在未完成派发：${state.pending.stage}/${state.pending.role} r${state.pending.round}，resume 会继续等待；若派发已退出则自动重新派发`);
      }
      const issues = state.pending ? [] : artifactIssues(root, config, next, story, round);
      for (const issue of issues) reasons.push(`待补齐：${issue.message}`);
      actions.push(`orca-team-orchestration resume ${story}`);
    }
  }

  const payload = {
    story,
    status: storyStatus(state, config),
    next,
    round: state && next !== 'done' && next !== 'accept' && next !== 'gate' ? (state.stages[next]?.round ?? 1) : null,
    pending: state?.pending ?? null,
    gate: state?.gate ?? null,
    reasons,
    actions,
  };
  if (flagBool(args, 'json')) {
    out(JSON.stringify(payload, null, 2));
    return EXIT.ok;
  }
  out(`${story}  [${payload.status}]  下一步：${payload.next}`);
  for (const reason of reasons) out(`  为什么  ${reason}`);
  for (const action of actions) out(`  怎么做  ${action}`);
  return EXIT.ok;
}

interface DoctorItem {
  name: string;
  status: 'OK' | 'WARN' | 'FAIL';
  detail: string;
}

async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const items: DoctorItem[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  items.push({
    name: 'Node',
    status: nodeMajor >= 20 ? 'OK' : 'FAIL',
    detail: `${process.versions.node}（需要 >= 20）`,
  });
  items.push({ name: 'git', status: gitHasHead(root) || runGit(root, ['ls-files']).ok ? 'OK' : 'FAIL', detail: root });

  let config: Config | null = null;
  let layout: WorkspaceLayout | undefined;
  try {
    config = loadConfig(root);
    items.push({ name: '配置', status: 'OK', detail: '.orca-team-orchestration/config.yaml' });
  } catch (err) {
    items.push({ name: '配置', status: 'FAIL', detail: (err as Error).message });
  }

  if (config) {
    const repos = config.project.repos ?? [];
    if (repos.length > 0) {
      try {
        layout = validateWorkspace(root, config);
        items.push({
          name: 'workspace',
          status: 'OK',
          detail: `${root}（根仓 + ${layout.repos.length} 个关联仓库）`,
        });
      } catch (err) {
        items.push({ name: 'workspace', status: 'FAIL', detail: (err as Error).message });
      }
      for (const repo of repos) {
        const repoRoot = path.resolve(root, repo.path);
        const problems: string[] = [];
        const warnings: string[] = [];
        if (!fs.existsSync(repoRoot)) {
          problems.push('目录不存在');
        } else {
          const top = runGit(repoRoot, ['rev-parse', '--show-toplevel']);
          if (!top.ok || !absoluteEquals(top.stdout.trim(), repoRoot)) problems.push('不是 git 顶层');
          if (!gitHasHead(repoRoot)) warnings.push('没有 HEAD');
          const repoHook = hookStatus(repoRoot);
          if (repoHook === 'foreign') warnings.push('pre-commit 非本工具');
          else if (repoHook === 'missing') warnings.push('未安装 pre-commit');
        }
        if (!ignoreCovers(root, repo.path)) warnings.push('根 .gitignore 未忽略');
        items.push({
          name: `repo ${repo.name}`,
          status: problems.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'OK',
          detail:
            problems.length + warnings.length === 0
              ? `${repo.path}/`
              : [...problems, ...warnings].join('；'),
        });
      }
      items.push({
        name: 'workspace ignore',
        status: ignoreCovers(root, '.orca-team-orchestration/runs') ? 'OK' : 'WARN',
        detail: ignoreCovers(root, '.orca-team-orchestration/runs')
          ? '关联仓库与 runs 均已忽略'
          : '根 .gitignore 缺少 .orca-team-orchestration/runs/',
      });
      items.push({
        name: 'worktree',
        status: 'OK',
        detail: config.runtime.worktree ?? 'path:.（未显式设置）',
      });
    }

    const missing = ['start', 'test', 'base_url'].filter(
      (key) => !config?.project.commands[key as 'start' | 'test' | 'base_url'],
    );
    items.push({
      name: '命令',
      status: 'OK',
      detail:
        missing.length === 0
          ? 'start / test / base_url 已设置'
          : `未设置：${missing.join(', ')}（运行时由角色自行识别）`,
    });

    const kinds = new Set(Object.values(config.agents).map((agent) => agent.kind));
    const found: string[] = [];
    const missingAgents: string[] = [];
    for (const kind of kinds) {
      const binary = agentBinary(kind);
      if (binary && findExecutable(binary)) found.push(`${kind}(${binary})`);
      else missingAgents.push(`${kind}(${binary ?? '?'})`);
    }
    items.push({
      name: 'agent',
      status: missingAgents.length === 0 ? 'OK' : 'WARN',
      detail: missingAgents.length === 0 ? found.join(', ') : `未找到：${missingAgents.join(', ')}`,
    });

    const noModel = Object.entries(config.agents)
      .filter(([, agent]) => !agent.model)
      .map(([name]) => name);
    items.push({
      name: '模型',
      status: 'OK',
      detail: noModel.length === 0 ? '全部已指定' : `${noModel.join(', ')} 未指定，使用 agent 默认模型`,
    });

    let invalid = 0;
    for (const file of findStoryFiles(root, config.project.paths.features_dir)) {
      const id = path.basename(file, '.md');
      const { issues } = parseStoryContent(readText(file) ?? '', id, file);
      if (issues.length > 0) invalid += 1;
    }
    items.push({
      name: '需求文件',
      status: invalid === 0 ? 'OK' : 'FAIL',
      detail: invalid === 0 ? '格式正确' : `${invalid} 个文件有格式问题`,
    });
  }

  const orca = resolveOrcaBinary();
  items.push({
    name: 'Orca',
    status: orca ? 'OK' : 'FAIL',
    detail: orca ?? ORCA_INSTALL_HINT.replaceAll('\n', ' '),
  });
  const hook = hookStatus(root);
  items.push({
    name: 'pre-commit hook',
    status: hook === 'ours' ? 'OK' : hook === 'foreign' ? 'WARN' : 'WARN',
    detail:
      hook === 'ours'
        ? '已安装（guard run --staged）'
        : hook === 'foreign'
          ? '存在非本工具的 pre-commit，重新 init 会备份并接管'
          : '未安装，可用 orca-team-orchestration init 安装',
  });
  const approvals = listApprovals(root);
  let validApprovals = 0;
  if (layout) {
    const heads = headCommits(layout);
    validApprovals = approvals.filter((approval) => {
      if (!approval.baselines || Object.keys(approval.baselines).length === 0) {
        return heads.workspace !== undefined && heads.workspace !== '' && approval.baseline === heads.workspace;
      }
      return Object.entries(approval.baselines).every(
        ([name, sha]) => sha !== '' && heads[name] === sha,
      );
    }).length;
  } else {
    validApprovals = approvals.filter((approval) => approval.baseline === headCommit(root)).length;
  }
  items.push({
    name: '守则审批',
    status: 'OK',
    detail:
      approvals.length === 0
        ? '无审批记录'
        : `${approvals.length} 条（对当前基线：${validApprovals} 条有效）`,
  });
  items.push({
    name: '运行目录',
    status: fs.existsSync(path.join(root, '.orca-team-orchestration', 'runs')) ? 'OK' : 'WARN',
    detail: '.orca-team-orchestration/runs',
  });

  if (flagBool(args, 'json')) {
    out(JSON.stringify(items, null, 2));
  } else {
    for (const item of items) out(`${item.status.padEnd(4)} ${item.name.padEnd(10)} ${item.detail}`);
  }
  return items.some((item) => item.status === 'FAIL') ? EXIT.validation : EXIT.ok;
}

async function cmdUi(args: ParsedArgs): Promise<number> {
  const root = repoRootFrom(args);
  const portRaw = flagString(args, 'port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new CliError(EXIT.usage, `端口非法：${portRaw}`);
  }

  const { server, url, projectRoot } = await startUiServer({
    projectRoot: root,
    ...(port === undefined ? {} : { port }),
  });
  out(`Orca Team Orchestration 页面已启动：${url}`);
  out(`项目目录：${projectRoot}`);
  out('按 Ctrl+C 停止服务。');
  out(`ORCA_TEAM_ORCHESTRATION_READY ${url}`);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return EXIT.ok;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  const rest: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
  };

  try {
    switch (command) {
      case undefined:
      case 'help':
        out(HELP);
        return EXIT.ok;
      case 'init':
        return await cmdInit(rest);
      case 'config':
        return await cmdConfig(rest);
      case 'new':
        return await cmdNew(rest);
      case 'list':
        return await cmdList(rest);
      case 'lint':
        return await cmdLint(rest);
      case 'start':
        return await cmdStart(rest);
      case 'resume':
        return await cmdResume(rest);
      case 'accept':
        return await cmdAccept(rest);
      case 'status':
        return await cmdStatus(rest);
      case 'check':
        return await cmdCheck(rest);
      case 'render':
        return await cmdRender(rest);
      case 'explain':
        return await cmdExplain(rest);
      case 'guard':
        return await cmdGuard(rest);
      case 'doctor':
        return await cmdDoctor(rest);
      case 'ui':
        return await cmdUi(rest);
      default:
        out(HELP);
        throw new CliError(EXIT.usage, `未知命令：${command}`);
    }
  } catch (err) {
    if (err instanceof StoryLintError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof PromptError) {
      process.stderr.write(`${err.message}\n`);
      return err.kind === 'bad_request' || err.kind === 'invalid' ? EXIT.usage : EXIT.config;
    }
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return EXIT.validation;
  }
}

const invoked = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : '';
if (invoked && import.meta.url === invoked) {
  main().then((code) => {
    process.exitCode = code;
  });
}
