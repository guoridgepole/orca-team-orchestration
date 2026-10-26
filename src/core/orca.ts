import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError, EXIT } from './errors.js';

export const ORCA_BINARY = 'orca-ide';

export const ORCA_INSTALL_HINT = `未检测到 Orca CLI。

orca-team-orchestration 必须依赖 Orca。请先安装 Orca 桌面应用。
- Linux：确认 orca-ide 命令已加入 PATH；
- macOS：Orca 的 CLI 名为 orca（位于 /Applications/Orca.app/Contents/Resources/bin/orca），
  通常安装 Orca 后该目录已在 PATH 中；
- Windows：确认 orca 命令可执行，或把安装目录加入 PATH。

也可以用环境变量 ORCA_TEAM_ORCHESTRATION_ORCA 直接指定 CLI 路径。

验证命令：
  orca-ide --version   # Linux
  orca --version       # macOS / Windows

验证通过后，请重新执行：
  orca-team-orchestration init`;

export function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH ?? '';
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the remaining PATH entries.
      }
    }
  }
  return null;
}

function looksLikeOrcaIdeVersion(binary: string): boolean {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  // Orca IDE 的 --version 输出为纯 semver（如 1.4.240）；
  // GNOME Orca 屏幕阅读器输出为 “Orca 46.0” 风格，借此排除误判。
  return result.status === 0 && /^\s*v?\d+\.\d+/.test(result.stdout ?? '');
}

function orcaKnownLocations(): string[] {
  if (process.platform === 'darwin') {
    const home = process.env.HOME ?? '';
    return [
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      ...(home ? [path.join(home, 'Applications/Orca.app/Contents/Resources/bin/orca')] : []),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.PROGRAMFILES ?? '';
    return [
      ...(localAppData ? [path.join(localAppData, 'Programs', 'Orca', 'resources', 'bin', 'orca.exe')] : []),
      ...(programFiles ? [path.join(programFiles, 'Orca', 'resources', 'bin', 'orca.exe')] : []),
    ];
  }
  return [];
}

// Linux 上 Orca 的 CLI 名为 orca-ide（避开 GNOME Orca 屏幕阅读器）；macOS/Windows 上名为 orca。
export function findOrcaExecutable(): string | null {
  const ide = findExecutable(ORCA_BINARY);
  if (ide) return ide;
  const plain = findExecutable('orca');
  if (plain && looksLikeOrcaIdeVersion(plain)) return plain;
  for (const location of orcaKnownLocations()) {
    try {
      fs.accessSync(location, fs.constants.X_OK);
      return location;
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

export function resolveOrcaBinary(explicit?: string): string | null {
  const fromExplicit = explicit?.trim() ?? '';
  if (fromExplicit) return fromExplicit;
  const env = process.env.ORCA_TEAM_ORCHESTRATION_ORCA;
  if (env !== undefined) {
    // 空串 = 显式禁用自动探测（用于测试隔离），非空 = 直接信任指定的路径。
    if (env.trim() === '') return null;
    return env.trim();
  }
  return findOrcaExecutable();
}

export function requireOrca(): string {
  const executable = resolveOrcaBinary();
  if (!executable) throw new CliError(EXIT.orchestrator, ORCA_INSTALL_HINT);
  return executable;
}

// agent kind → 本机 CLI 命令名。派发前按此表预检，避免配了未安装的 agent 才在 Orca 侧报错。
// qoder 的命令名与 Orca 启动配置一致（orca 对 qoder 使用 qodercli）。
const AGENT_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  zcode: 'zcode',
  opencode: 'opencode',
  qoder: 'qodercli',
  codebuddy: 'codebuddy',
};

export function agentBinary(kind: string): string | null {
  return AGENT_BINARIES[kind] ?? null;
}

export function requireAgentAvailable(kind: string): string {
  const binary = agentBinary(kind);
  if (!binary) {
    throw new CliError(
      EXIT.agent,
      `不支持的 agent kind：${kind}（可用：${Object.keys(AGENT_BINARIES).join(' / ')}）`,
    );
  }
  const found = findExecutable(binary);
  if (!found) {
    throw new CliError(
      EXIT.agent,
      `未检测到 agent 命令 ${binary}（kind: ${kind}）。请先安装并确保 ${binary} 在 PATH 中，或在 .orca-team-orchestration/config.yaml 的 agents 池中把角色改绑到已安装的 agent。`,
    );
  }
  return found;
}
