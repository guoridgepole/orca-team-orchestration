import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { builtinDefaults } from '../src/core/config.js';
import {
  buildRunState,
  hashContent,
  nextStage,
  readState,
  snapshotSpec,
  specHashMatches,
  storyStatus,
  writeState,
} from '../src/core/state.js';
import type { RunState } from '../src/core/state.js';
import { parseStoryContent } from '../src/core/story.js';
import { VALID_STORY, cleanup, tempRepo, write } from './helpers.js';

const dirs: string[] = [];
const { story } = parseStoryContent(VALID_STORY, 'story-0.1.0-001');

function repo(): string {
  const root = tempRepo('state');
  dirs.push(root);
  return root;
}

function stateAt(root: string, spec = snapshotSpec(root, story.id, VALID_STORY)): RunState {
  return buildRunState(builtinDefaults('demo'), story, spec, 'orca');
}

after(() => {
  for (const dir of dirs) cleanup(dir);
});

describe('spec snapshot', () => {
  it('writes a normalized copy and records its hash', () => {
    const root = repo();
    const spec = snapshotSpec(root, story.id, VALID_STORY.replace(/\n/g, '\r\n'));

    assert.equal(spec.source, 'features/story-0.1.0-001.md');
    assert.equal(spec.snapshot, '.orca-team-orchestration/runs/story-0.1.0-001/spec.md');
    assert.equal(spec.sha256, hashContent(VALID_STORY));

    const copied = fs.readFileSync(path.join(root, spec.snapshot), 'utf8');
    assert.equal(copied, VALID_STORY);
    assert.equal(copied.includes('\r\n'), false);
  });

  it('matches the snapshot hash while the story is unchanged', () => {
    const root = repo();
    const spec = snapshotSpec(root, story.id, VALID_STORY);
    write(root, 'features/story-0.1.0-001.md', VALID_STORY);
    const state = stateAt(root, spec);

    assert.equal(specHashMatches(root, state), true);

    write(root, 'features/story-0.1.0-001.md', `${VALID_STORY}\n- 新增一条\n`);
    assert.equal(specHashMatches(root, state), false);
  });

  it('reports a mismatch when the story file is gone', () => {
    const root = repo();
    const state = stateAt(root);

    assert.equal(specHashMatches(root, state), false);
  });

  it('supports a custom features_dir and still reads legacy source paths', () => {
    const root = repo();
    const spec = snapshotSpec(root, story.id, VALID_STORY, 'specs');
    assert.equal(spec.source, 'specs/story-0.1.0-001.md');
    write(root, 'specs/story-0.1.0-001.md', VALID_STORY);
    const state = stateAt(root, spec);
    assert.equal(specHashMatches(root, state), true);

    const legacy = { ...state, spec: { ...state.spec, source: 'features/story-0.1.0-001.md' } };
    write(root, 'features/story-0.1.0-001.md', VALID_STORY);
    assert.equal(specHashMatches(root, legacy), true);
  });

  it('keeps legacy baseline arrays in pending dispatch state', () => {
    const root = repo();
    const state = stateAt(root);
    state.pending = {
      runId: 'run',
      stage: 'develop',
      role: 'developer',
      round: 1,
      baseline: ['docs/dev/old.md', 'api/src/old.ts'],
    };
    writeState(root, state);
    assert.deepEqual(readState(root, story.id)?.pending?.baseline, ['docs/dev/old.md', 'api/src/old.ts']);
  });
});

describe('run state', () => {
  it('round-trips through .orca-team-orchestration/runs/<story>.json', () => {
    const root = repo();
    const state = stateAt(root);
    writeState(root, state);

    const loaded = readState(root, story.id);
    assert.deepEqual(loaded, state);
  });

  it('records the features and acceptance ids from the story', () => {
    const root = repo();
    const state = stateAt(root);

    assert.deepEqual(state.features, ['F1', 'F2']);
    assert.deepEqual(state.acceptance, ['story-0.1.0-001-1', 'story-0.1.0-001-2']);
    assert.equal(state.story, 'story-0.1.0-001');
    assert.equal(state.title, '午餐抽签');
  });
});

describe('story status', () => {
  it('is 未开始 without state', () => {
    assert.equal(storyStatus(null), '未开始');
  });

  it('is 已验收 once acceptedAt is set', () => {
    const root = repo();
    const state = { ...stateAt(root), acceptedAt: '2026-10-24T00:00:00.000Z' };
    assert.equal(storyStatus(state), '已验收');
  });

  it('is 待验收 after the test stage passes', () => {
    const root = repo();
    const state = stateAt(root);
    state.stages.test = { round: 1, status: 'passed' };
    assert.equal(storyStatus(state), '待验收');
  });

  it('is 待验收 after develop when the project has no test stage', () => {
    const config = builtinDefaults('demo');
    config.flow.test = null;
    const root = repo();
    const state = stateAt(root);
    state.stages.develop = { round: 1, status: 'passed' };

    assert.equal(storyStatus(state, config), '待验收');
  });

  it('is 进行中 while stages are open', () => {
    const root = repo();
    const state = stateAt(root);
    state.stages.design = { round: 1, status: 'passed' };
    assert.equal(storyStatus(state), '进行中');
  });
});

describe('next stage', () => {
  const config = builtinDefaults('demo');
  const root = repo();

  it('walks design → review → develop → test → accept', () => {
    const state = stateAt(root);
    assert.equal(nextStage(config, state), 'design');

    state.stages.design = { round: 1, status: 'passed' };
    assert.equal(nextStage(config, state), 'review');

    state.stages.review = { round: 1, status: 'passed' };
    assert.equal(nextStage(config, state), 'develop');

    state.stages.develop = { round: 1, status: 'passed' };
    assert.equal(nextStage(config, state), 'test');

    state.stages.test = { round: 1, status: 'passed' };
    assert.equal(nextStage(config, state), 'accept');

    state.acceptedAt = '2026-10-24T00:00:00.000Z';
    assert.equal(nextStage(config, state), 'done');
  });

  it('skips review and test when the flow disables them', () => {
    const noReview = builtinDefaults('demo');
    noReview.flow.review = null;
    noReview.flow.test = null;
    const state = stateAt(root);

    assert.equal(nextStage(noReview, state), 'design');
    state.stages.design = { round: 1, status: 'passed' };
    assert.equal(nextStage(noReview, state), 'develop');
    state.stages.develop = { round: 1, status: 'passed' };
    assert.equal(nextStage(noReview, state), 'accept');
  });
});
