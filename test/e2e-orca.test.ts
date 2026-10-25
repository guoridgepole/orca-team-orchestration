import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { findExecutable, ORCA_BINARY } from '../src/core/orca.js';

// 端到端骨架：默认跳过。Linux + ORCA_E2E=1 时只做只读探测（不派发真实 worker）。
// 完整链路（worker-start/check/ack/reply）联调在具备真实 Orca 运行时的环境中启用本文件后逐步展开。
const enabled = process.env.ORCA_E2E === '1' && process.platform === 'linux';

describe('orca end-to-end (ORCA_E2E=1)', { skip: !enabled }, () => {
  it('resolves the orca-ide binary', () => {
    const binary = findExecutable(ORCA_BINARY);
    assert.ok(binary, `PATH 中没有 ${ORCA_BINARY}`);
  });

  it('answers a read-only orchestration run-list probe', () => {
    const result = spawnSync(ORCA_BINARY, ['orchestration', 'run-list', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  });
});
