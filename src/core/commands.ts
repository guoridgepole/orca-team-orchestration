import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Config } from './config.js';
import type { CheckIssue } from './checks.js';
import { findExecutable } from './orca.js';
import { writeText } from './paths.js';

export interface CommandCheckResult {
  name: string;
  role: string;
  command: string;
  ok: boolean;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  log: string;
}

export interface CommandCheckOutcome {
  issues: CheckIssue[];
  results: CommandCheckResult[];
  warnings: string[];
}

function variables(root: string, config: Config, story: string, stage: string, round: number): Record<string, string> {
  return {
    repo: root,
    workspace: root,
    repos: JSON.stringify(config.project.repos ?? []),
    story,
    stage,
    round: String(round),
    'project.name': config.project.name ?? path.basename(root),
    'project.commands.start': config.project.commands.start ?? '',
    'project.commands.test': config.project.commands.test ?? '',
    'project.commands.build': config.project.commands.build ?? '',
    'project.commands.base_url': config.project.commands.base_url ?? '',
    'paths.features_dir': config.project.paths.features_dir,
    'paths.docs': config.project.paths.docs,
    'paths.source': config.project.paths.source.join(','),
    'paths.tests': config.project.paths.tests.join(','),
    'paths.db': config.project.paths.db ?? '',
    'paths.evidence': config.project.paths.evidence,
  };
}

export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function shellInvocation(config: Config, command: string): { file: string; args: string[] } | null {
  const requested = config.runtime.shell;
  if (requested === 'pwsh') return { file: 'pwsh', args: ['-NoProfile', '-Command', command] };
  if (requested === 'cmd') return { file: 'cmd', args: ['/d', '/s', '/c', command] };
  if (requested === 'sh') return { file: 'sh', args: ['-c', command] };
  if (process.platform === 'win32') {
    return findExecutable('pwsh')
      ? { file: 'pwsh', args: ['-NoProfile', '-Command', command] }
      : { file: 'cmd', args: ['/d', '/s', '/c', command] };
  }
  return { file: 'sh', args: ['-c', command] };
}

export function runRoleCommandChecks(
  root: string,
  config: Config,
  roleName: string,
  stage: string,
  story: string,
  round: number,
): CommandCheckOutcome {
  const issues: CheckIssue[] = [];
  const results: CommandCheckResult[] = [];
  const warnings: string[] = [];
  const role = config.roles[roleName];
  if (!role?.run_checks?.length) return { issues, results, warnings };
  const values = variables(root, config, story, stage, round);

  for (const name of role.run_checks) {
    const check = config.checks[name];
    if (!check) {
      issues.push({ kind: 'command', message: `${roleName} 引用了未定义的检查：${name}` });
      continue;
    }
    const command = interpolate(check.command, values).trim();
    if (command === '') {
      warnings.push(`${roleName} 的检查 ${name} 渲染后为空（对应命令未配置），已跳过`);
      continue;
    }
    const shell = shellInvocation(config, command);
    if (!shell) {
      issues.push({ kind: 'command', message: `${roleName} 的检查 ${name} 无法选择 shell` });
      continue;
    }
    const timeoutMs = Math.max(1, check.timeout_minutes ?? 15) * 60_000;
    const started = new Date().toISOString();
    const result = spawnSync(shell.file, shell.args, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        OTO_STORY: story,
        OTO_STAGE: stage,
        OTO_ROUND: String(round),
        OTO_ROLE: roleName,
        OTO_REPO: root,
        OTO_WORKSPACE: root,
        OTO_REPOS: JSON.stringify(config.project.repos ?? []),
      },
    });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    const ok = !result.error && (result.status ?? 1) === 0;
    const required = check.required !== false;
    const logPath = path.join(
      '.orca-team-orchestration',
      'runs',
      story,
      'checks',
      `${stage}-r${round}-${roleName}-${name}.log`,
    );
    const output = [
      `# ${name} (${roleName} ${stage} r${round})`,
      `started: ${started}`,
      `command: ${command}`,
      `shell: ${shell.file} ${shell.args.slice(0, -1).join(' ')}`,
      '',
      '[stdout]',
      result.stdout ?? '',
      '[stderr]',
      result.stderr ?? '',
      '[result]',
      timedOut ? 'timed out' : `exit ${result.status ?? 'null'}${result.error ? ` (${result.error.message})` : ''}`,
      '',
    ].join('\n');
    writeText(path.join(root, logPath), output);

    results.push({
      name,
      role: roleName,
      command,
      ok,
      required,
      exitCode: result.status ?? null,
      timedOut,
      log: logPath.split(path.sep).join('/'),
    });

    if (!ok && required) {
      const detail = timedOut
        ? `超时（${Math.round(timeoutMs / 60_000)} 分钟）`
        : `退出码 ${result.status ?? 'null'}`;
      const snippet = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(0, 300);
      issues.push({
        kind: 'command',
        message: `${roleName} 的检查 ${name} 未通过：${detail}${snippet ? `\n${snippet}` : ''}\n日志：${logPath.split(path.sep).join('/')}`,
      });
    }
  }

  return { issues, results, warnings };
}
