import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { findOrcaExecutable, resolveOrcaBinary } from '../src/core/orca.js';
import { cleanup, write } from './helpers.js';

const dirs: string[] = [];

function binDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-orchestration-resolve-'));
  dirs.push(dir);
  return dir;
}

function fakeBinary(dir: string, name: string, versionOutput: string): string {
  if (process.platform === 'win32') {
    write(dir, `${name}.CMD`, `@echo ${versionOutput}\r\n@exit /b 0\r\n`);
    return path.join(dir, `${name}.CMD`);
  }
  write(dir, name, `#!/bin/sh\necho ${versionOutput}\n`);
  fs.chmodSync(path.join(dir, name), 0o755);
  return path.join(dir, name);
}

after(() => {
  for (const dir of dirs) cleanup(dir);
});

function withEnv(env: NodeJS.ProcessEnv, run: () => void): void {
  const backup = { ...process.env };
  try {
    Object.assign(process.env, env);
    run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in backup)) delete process.env[key];
    }
    Object.assign(process.env, backup);
  }
}

describe('findOrcaExecutable', () => {
  it('PATH 中同时存在 orca-ide 与 orca 时优先 orca-ide', () => {
    const dir = binDir();
    const ide = fakeBinary(dir, 'orca-ide', '1.4.240');
    fakeBinary(dir, 'orca', '1.4.240');
    withEnv({ PATH: dir }, () => {
      assert.equal(findOrcaExecutable(), ide);
    });
  });

  it('PATH 中仅有 orca 时接受 semver 版本输出（macOS/Windows 布局）', () => {
    const dir = binDir();
    const orca = fakeBinary(dir, 'orca', '1.4.240');
    withEnv({ PATH: dir }, () => {
      assert.equal(findOrcaExecutable(), orca);
    });
  });

  it('PATH 中的 orca 若不是 Orca IDE 版本输出则不采纳（如 GNOME Orca）', () => {
    const dir = binDir();
    const imposter = fakeBinary(dir, 'orca', 'Orca 46.0');
    withEnv({ PATH: dir }, () => {
      assert.notEqual(findOrcaExecutable(), imposter);
    });
  });
});

describe('resolveOrcaBinary', () => {
  it('explicit 参数优先于环境变量与自动探测', () => {
    const dir = binDir();
    fakeBinary(dir, 'orca-ide', '1.4.240');
    withEnv({ PATH: dir, ORCA_TEAM_ORCHESTRATION_ORCA: '/somewhere/orca' }, () => {
      assert.equal(resolveOrcaBinary('/explicit/orca'), '/explicit/orca');
    });
  });

  it('ORCA_TEAM_ORCHESTRATION_ORCA 覆盖自动探测', () => {
    const dir = binDir();
    fakeBinary(dir, 'orca-ide', '1.4.240');
    withEnv({ PATH: dir, ORCA_TEAM_ORCHESTRATION_ORCA: '/somewhere/orca' }, () => {
      assert.equal(resolveOrcaBinary(), '/somewhere/orca');
    });
  });

  it('ORCA_TEAM_ORCHESTRATION_ORCA 设为空串时禁用自动探测', () => {
    const dir = binDir();
    fakeBinary(dir, 'orca-ide', '1.4.240');
    withEnv({ PATH: dir, ORCA_TEAM_ORCHESTRATION_ORCA: '' }, () => {
      assert.equal(resolveOrcaBinary(), null);
    });
  });
});
