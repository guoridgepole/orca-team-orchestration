import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { findStoryFiles, parseStoryContent, newStorySkeleton } from '../src/core/story.js';
import { cleanup, tempRepo, VALID_STORY, write } from './helpers.js';

const roots: string[] = [];
after(() => roots.forEach(cleanup));

test('解析功能清单与验收标准', () => {
  const { story, issues } = parseStoryContent(VALID_STORY, 'story-001');
  assert.deepEqual(issues, []);
  assert.equal(story.title, '午餐抽签');
  assert.equal(story.meta.background, '中午不知道吃什么');
  assert.deepEqual(story.meta.notInScope, ['后端接口']);
  assert.deepEqual(story.features.map((item) => item.id), ['F1', 'F2']);
  assert.deepEqual(story.acceptance.map((item) => item.id), ['story-001-1', 'story-001-2']);
});

test('支持表格形式的验收标准', () => {
  const content = `# story-002 待办

## 功能清单

- F1 查看待办

## 验收标准

| 验收 ID | 描述 |
|---|---|
| story-002-1 | 只能看到自己的待办 |
| story-002-2 | 新增后立即出现 |
`;
  const { story, issues } = parseStoryContent(content, 'story-002');
  assert.deepEqual(issues, []);
  assert.deepEqual(story.acceptance.map((item) => item.id), ['story-002-1', 'story-002-2']);
});

test('缺少功能清单段会报错', () => {
  const content = `# story-003 标题\n\n## 验收标准\n\n- [ ] story-003-1 可用\n`;
  const { issues } = parseStoryContent(content, 'story-003');
  assert.ok(issues.some((issue) => issue.message.includes('功能清单')));
});

test('验收 ID 前缀不匹配会报错', () => {
  const content = `# story-004 标题\n\n## 功能清单\n\n- F1 功能\n\n## 验收标准\n\n- [ ] other-1 不对\n`;
  const { issues } = parseStoryContent(content, 'story-004');
  assert.ok(issues.some((issue) => issue.message.includes('必须以')));
});

test('标题 id 与文件名不一致会报错', () => {
  const { issues } = parseStoryContent(VALID_STORY, 'story-999');
  assert.ok(issues.some((issue) => issue.message.includes('不一致')));
});

test('重复功能 ID 会报错', () => {
  const content = `# story-005 标题\n\n## 功能清单\n\n- F1 一\n- F1 二\n\n## 验收标准\n\n- [ ] story-005-1 可用\n`;
  const { issues } = parseStoryContent(content, 'story-005');
  assert.ok(issues.some((issue) => issue.message.includes('重复')));
});

test('new 生成的骨架在填写前不通过 lint', () => {
  const { issues } = parseStoryContent(newStorySkeleton('story-006', '新需求'), 'story-006');
  assert.ok(issues.length > 0);
});

test('findStoryFiles 只收 .md 文件', () => {
  const root = tempRepo('story-files');
  roots.push(root);
  write(root, 'features/story-001.md', VALID_STORY);
  write(root, 'features/notes.txt', 'ignored');
  write(root, 'features/README.md', '# readme');
  const files = findStoryFiles(root, 'features').map((file) => path.basename(file));
  assert.deepEqual(files, ['story-001.md']);
});
