import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { findStoryFiles, parseStoryContent, newStorySkeleton, requireVersion, versionFromStory } from '../src/core/story.js';
import { isStoryId } from '../src/core/config.js';
import { renderArtifactPath } from '../src/core/checks.js';
import { cleanup, tempRepo, VALID_STORY, write } from './helpers.js';

const roots: string[] = [];
after(() => roots.forEach(cleanup));

test('解析功能清单与验收标准', () => {
  const { story, issues } = parseStoryContent(VALID_STORY, 'story-0.1.0-001');
  assert.deepEqual(issues, []);
  assert.equal(story.title, '午餐抽签');
  assert.equal(story.meta.background, '中午不知道吃什么');
  assert.deepEqual(story.meta.notInScope, ['后端接口']);
  assert.deepEqual(story.features.map((item) => item.id), ['F1', 'F2']);
  assert.deepEqual(story.acceptance.map((item) => item.id), ['story-0.1.0-001-1', 'story-0.1.0-001-2']);
});

test('支持表格形式的验收标准', () => {
  const content = `# story-0.2.0-001 待办

## 功能清单

- F1 查看待办

## 验收标准

| 验收 ID | 描述 |
|---|---|
| story-0.2.0-001-1 | 只能看到自己的待办 |
| story-0.2.0-001-2 | 新增后立即出现 |
`;
  const { story, issues } = parseStoryContent(content, 'story-0.2.0-001');
  assert.deepEqual(issues, []);
  assert.deepEqual(story.acceptance.map((item) => item.id), ['story-0.2.0-001-1', 'story-0.2.0-001-2']);
});

test('缺少功能清单段会报错', () => {
  const content = `# story-0.1.0-003 标题\n\n## 验收标准\n\n- [ ] story-0.1.0-003-1 可用\n`;
  const { issues } = parseStoryContent(content, 'story-0.1.0-003');
  assert.ok(issues.some((issue) => issue.message.includes('功能清单')));
});

test('验收 ID 前缀不匹配会报错', () => {
  const content = `# story-0.1.0-004 标题\n\n## 功能清单\n\n- F1 功能\n\n## 验收标准\n\n- [ ] other-1 不对\n`;
  const { issues } = parseStoryContent(content, 'story-0.1.0-004');
  assert.ok(issues.some((issue) => issue.message.includes('必须以')));
});

test('标题 id 与文件名不一致会报错', () => {
  const { issues } = parseStoryContent(VALID_STORY, 'story-0.1.0-999');
  assert.ok(issues.some((issue) => issue.message.includes('不一致')));
});

test('重复功能 ID 会报错', () => {
  const content = `# story-0.1.0-005 标题\n\n## 功能清单\n\n- F1 一\n- F1 二\n\n## 验收标准\n\n- [ ] story-0.1.0-005-1 可用\n`;
  const { issues } = parseStoryContent(content, 'story-0.1.0-005');
  assert.ok(issues.some((issue) => issue.message.includes('重复')));
});

test('new 生成的骨架在填写前不通过 lint', () => {
  const { issues } = parseStoryContent(newStorySkeleton('story-0.1.0-006', '新需求'), 'story-0.1.0-006');
  assert.ok(issues.length > 0);
});

test('story id 必须是 story-<版本>-<序号>', () => {
  assert.equal(versionFromStory('story-0.1.0-001'), '0.1.0');
  assert.equal(versionFromStory('story-1.1.1-02'), '1.1.1');
  assert.equal(versionFromStory('story-001'), null);
  assert.equal(versionFromStory('story-1.0-01'), null);
  assert.equal(versionFromStory('x-0.1.0-01'), null);
  assert.equal(versionFromStory('story-0.1.0'), null);
  assert.throws(() => requireVersion('story-abc'), /格式：story-<版本>-<序号>/);
  assert.equal(isStoryId('story-0.1.0-001'), true);
  assert.equal(isStoryId('story-1.1.1-02'), true);
  assert.equal(isStoryId('story-001'), false);
  assert.equal(isStoryId('story-0.1.0-'), false);
  assert.equal(isStoryId('story-0.1.0-0a'), false);
});

test('renderArtifactPath 从 story 派生版本', () => {
  assert.equal(
    renderArtifactPath('docs/v{{version}}/design/{{story}}-r{{round}}.md', 'story-0.1.0-001', 2),
    'docs/v0.1.0/design/story-0.1.0-001-r2.md',
  );
  assert.equal(
    renderArtifactPath('docs/v{{version}}/design/{{story}}.md', 'bad-id', 1),
    'docs/v{{version}}/design/bad-id.md',
  );
});

test('findStoryFiles 只收 .md 文件', () => {
  const root = tempRepo('story-files');
  roots.push(root);
  write(root, 'features/story-0.1.0-001.md', VALID_STORY);
  write(root, 'features/notes.txt', 'ignored');
  write(root, 'features/README.md', '# readme');
  const files = findStoryFiles(root, 'features').map((file) => path.basename(file));
  assert.deepEqual(files, ['story-0.1.0-001.md']);
});
