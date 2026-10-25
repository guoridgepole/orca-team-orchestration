import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.js';
import { readText } from './paths.js';

export interface StoryMeta {
  background?: string;
  dependsOn: string[];
  notInScope: string[];
  testData: string[];
  details: string[];
}

export interface StoryFeature {
  id: string;
  description: string;
  line: number;
}

export interface AcceptanceItem {
  id: string;
  description: string;
  line: number;
}

export interface Story {
  id: string;
  title: string;
  file: string;
  meta: StoryMeta;
  features: StoryFeature[];
  acceptance: AcceptanceItem[];
}

export interface StoryIssue {
  line: number;
  message: string;
}

export class StoryLintError extends CliError {
  constructor(
    readonly file: string,
    readonly issues: StoryIssue[],
  ) {
    super(
      EXIT.config,
      `需求文件非法：${file}\n${issues.map((issue) => `  第 ${issue.line} 行：${issue.message}`).join('\n')}`,
    );
    this.name = 'StoryLintError';
  }
}

const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const META_KEYS = ['背景', '依赖', '明确不做', '测试数据', '详见'] as const;

export function storyPath(root: string, featuresDir: string, storyId: string): string {
  return path.join(root, featuresDir, `${storyId}.md`);
}

export function findStoryFiles(root: string, featuresDir: string): string[] {
  const dir = path.join(root, featuresDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !entry.name.startsWith('.') &&
        entry.name.toLowerCase() !== 'readme.md',
    )
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export function parseStoryContent(content: string, expectedId: string, file = expectedId): {
  story: Story;
  issues: StoryIssue[];
} {
  const issues: StoryIssue[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const story: Story = {
    id: expectedId,
    title: '',
    file,
    meta: { dependsOn: [], notInScope: [], testData: [], details: [] },
    features: [],
    acceptance: [],
  };

  let section: string | null = null;
  let metaKey: (typeof META_KEYS)[number] | null = null;
  let sawFeaturesHeading = false;
  let sawAcceptanceHeading = false;
  const featureIds = new Set<string>();
  const acceptanceIds = new Set<string>();

  const titleIndex = lines.findIndex((line) => line.trim() !== '');
  if (titleIndex === -1) {
    issues.push({ line: 1, message: '文件为空' });
    return { story, issues };
  }
  const titleMatch = /^#\s+(\S+)\s+(.+)$/.exec(lines[titleIndex]?.trim() ?? '');
  if (!titleMatch) {
    issues.push({ line: titleIndex + 1, message: '第一行必须是 `# <story> <标题>`' });
  } else {
    const [, id, title] = titleMatch;
    if (id !== expectedId) {
      issues.push({ line: titleIndex + 1, message: `标题里的 story id「${id}」与文件名「${expectedId}」不一致` });
    }
    if (!title?.trim()) issues.push({ line: titleIndex + 1, message: '标题不能为空' });
    story.title = title?.trim() ?? '';
  }

  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    const heading = /^##\s+(.+?)\s*$/.exec(trimmed);
    if (heading) {
      section = heading[1] ?? '';
      if (section === '功能清单') sawFeaturesHeading = true;
      if (section === '验收标准') sawAcceptanceHeading = true;
      metaKey = null;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      metaKey = null;
      continue;
    }

    if (section === null) {
      const meta = /^[-*]\s+([^:：]+)[:：]\s*(.*)$/.exec(trimmed);
      if (meta) {
        const key = meta[1]?.trim() as (typeof META_KEYS)[number];
        const value = meta[2]?.trim() ?? '';
        if (!META_KEYS.includes(key)) {
          metaKey = null;
          continue;
        }
        metaKey = key;
        if (key === '背景') story.meta.background = value;
        applyMetaValue(story.meta, key, value);
      } else {
        const indented = /^\s{2,}[-*]\s+(.+)$/.exec(raw);
        if (indented && metaKey) applyMetaValue(story.meta, metaKey, indented[1]?.trim() ?? '');
      }
      continue;
    }

    if (section === '功能清单') {
      const item = parseBullet(trimmed);
      if (!item) {
        if (trimmed.startsWith('|')) continue;
        issues.push({ line, message: '功能清单里的每一行必须是 `- <功能 ID> <描述>`' });
        continue;
      }
      if (!FEATURE_ID.test(item.id)) {
        issues.push({ line, message: `功能 ID 非法：${item.id}` });
        continue;
      }
      if (featureIds.has(item.id)) {
        issues.push({ line, message: `功能 ID 重复：${item.id}` });
        continue;
      }
      featureIds.add(item.id);
      story.features.push({ id: item.id, description: item.description, line });
      continue;
    }

    if (section === '验收标准') {
      const cells = parseTableRow(trimmed);
      if (cells) {
        const [id, ...rest] = cells;
        const description = rest.join(' ').trim();
        if (!id || looksLikeTableHeader(id) || /^[-: ]+$/.test(id)) continue;
        addAcceptance(id, description, line);
        continue;
      }
      const item = parseBullet(trimmed);
      if (!item) {
        issues.push({ line, message: '验收标准里的每一行必须是 `- [ ] <story>-<序号> <描述>` 或表格行' });
        continue;
      }
      addAcceptance(item.id, item.description, line);
    }
  }

  function addAcceptance(id: string, description: string, line: number): void {
    const expectedPrefix = `${expectedId}-`;
    if (!id.startsWith(expectedPrefix)) {
      issues.push({ line, message: `验收 ID「${id}」必须以「${expectedPrefix}」开头` });
      return;
    }
    if (acceptanceIds.has(id)) {
      issues.push({ line, message: `验收 ID 重复：${id}` });
      return;
    }
    if (!description) {
      issues.push({ line, message: `验收项 ${id} 缺少描述` });
      return;
    }
    acceptanceIds.add(id);
    story.acceptance.push({ id, description, line });
  }

  if (!sawFeaturesHeading) issues.push({ line: 1, message: '缺少 `## 功能清单` 段' });
  if (!sawAcceptanceHeading) issues.push({ line: 1, message: '缺少 `## 验收标准` 段' });
  if (sawFeaturesHeading && story.features.length === 0) {
    issues.push({ line: 1, message: '功能清单为空，至少写一条功能' });
  }
  if (sawAcceptanceHeading && story.acceptance.length === 0) {
    issues.push({ line: 1, message: '验收标准为空，至少写一条验收项' });
  }

  return { story, issues };
}

function applyMetaValue(meta: StoryMeta, key: (typeof META_KEYS)[number], value: string): void {
  if (!value) return;
  if (key === '依赖') {
    if (value === '无' || value === '无依赖') return;
    meta.dependsOn.push(...value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean));
  } else if (key === '明确不做') {
    meta.notInScope.push(value);
  } else if (key === '测试数据') {
    meta.testData.push(value);
  } else if (key === '详见') {
    meta.details.push(value);
  }
}

function parseBullet(line: string): { id: string; description: string } | null {
  const match = /^[-*]\s+(?:\[[ xX]\]\s+)?(\S+)\s+(.+)$/.exec(line);
  if (!match) return null;
  return { id: match[1] ?? '', description: match[2]?.trim() ?? '' };
}

function parseTableRow(line: string): string[] | null {
  if (!line.startsWith('|')) return null;
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function looksLikeTableHeader(value: string): boolean {
  return /^验收\s*ID$/i.test(value) || value === 'ID' || value === '验收项';
}

export function loadStory(root: string, featuresDir: string, storyId: string): Story {
  if (!STORY_ID.test(storyId)) {
    throw new CliError(EXIT.usage, `story id 非法：${storyId}`);
  }
  const file = storyPath(root, featuresDir, storyId);
  const content = readText(file);
  if (content === null) {
    throw new CliError(EXIT.config, `找不到需求文件：${path.relative(root, file)}`);
  }
  const { story, issues } = parseStoryContent(content, storyId, file);
  if (issues.length > 0) {
    throw new StoryLintError(file, issues);
  }
  return story;
}

export function newStorySkeleton(storyId: string, title: string): string {
  return `# ${storyId} ${title}

- 背景:

## 功能清单

- F1 

## 验收标准

- [ ] ${storyId}-1 
`;
}
