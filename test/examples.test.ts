import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { EXIT } from '../src/core/errors.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
const EXAMPLES_ROOT = path.resolve(path.dirname(CLI), '..', '..', '..', 'examples');

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('examples', () => {
  for (const name of ['static-site', 'todo-app']) {
    const dir = path.join(EXAMPLES_ROOT, name);

    it(`${name}: stories pass lint`, () => {
      const result = runCli(['--repo', dir, 'lint']);
      assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
      assert.match(result.stdout, /LINT: PASS/);
    });

    it(`${name}: config loads and prints`, () => {
      const result = runCli(['--repo', dir, 'config', '--print']);
      assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
      assert.match(result.stdout, /^version: 1/);
    });
  }

  it('todo-app story declares acceptance ids with the story prefix', () => {
    const result = runCli(['--repo', path.join(EXAMPLES_ROOT, 'todo-app'), 'lint', 'story-0.2.0-001', '--json']);
    assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });
});
