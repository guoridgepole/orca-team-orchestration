import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.js';

export const ORCA_BINARY = 'orca-ide';

export const ORCA_INSTALL_HINT = `未检测到 Orca。

orca-team-orchestration 必须依赖 Orca。请先安装 Orca 桌面应用，并确保 ${ORCA_BINARY} 命令已加入 PATH。

安装后请运行以下命令验证：
  ${ORCA_BINARY} --version

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

export function requireOrca(): string {
  const executable = findExecutable(ORCA_BINARY);
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
