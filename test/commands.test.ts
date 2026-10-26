import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { builtinDefaults } from '../src/core/config.js';
import { runRoleCommandChecks } from '../src/core/commands.js';
import { cleanup, tempRepo } from './helpers.js';

test('渲染为空的检查会跳过并给出 warning', () => {
  const root = tempRepo('commands-empty');
  try {
    const config = builtinDefaults('demo');
    config.roles.designer!.run_checks = ['project-test'];

    const outcome = runRoleCommandChecks(root, config, 'designer', 'design', 'story-0.1.0-001', 1);

    assert.deepEqual(outcome.issues, []);
    assert.deepEqual(outcome.results, []);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0]!, /project-test 渲染后为空（对应命令未配置），已跳过/);
  } finally {
    cleanup(root);
  }
});

test('配置了测试命令时正常执行检查并写日志', () => {
  const root = tempRepo('commands-run');
  try {
    const config = builtinDefaults('demo');
    config.project.commands.test = 'exit 0';
    config.roles.designer!.run_checks = ['project-test'];

    const outcome = runRoleCommandChecks(root, config, 'designer', 'design', 'story-0.1.0-001', 1);

    assert.deepEqual(outcome.issues, []);
    assert.deepEqual(outcome.warnings, []);
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.results[0]!.ok, true);
    assert.ok(fs.existsSync(path.join(root, outcome.results[0]!.log)));
  } finally {
    cleanup(root);
  }
});
