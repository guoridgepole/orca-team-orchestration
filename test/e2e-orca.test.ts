import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { resolveOrcaBinary } from '../src/core/orca.js';

// 端到端骨架：默认跳过。设置 ORCA_E2E=1 时只做只读探测（不派发真实 worker）。
// Linux 上 CLI 名为 orca-ide，macOS/Windows 上名为 orca，二进制解析见 src/core/orca.ts。
// 完整链路（worker-start/check/ack/reply）联调在具备真实 Orca 运行时的环境中启用本文件后逐步展开。
const enabled = process.env.ORCA_E2E === '1';

describe('orca end-to-end (ORCA_E2E=1)', { skip: !enabled }, () => {
  it('resolves the Orca CLI binary', () => {
    const binary = resolveOrcaBinary();
    assert.ok(binary, '未找到 Orca CLI（orca-ide / orca）');
  });

  it('answers a read-only orchestration run-list probe', () => {
    const binary = resolveOrcaBinary();
    assert.ok(binary);
    const result = spawnSync(binary, ['orchestration', 'run-list', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  });
});
