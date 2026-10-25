import fs from 'node:fs';
import path from 'node:path';
import type { Violation } from './guards.js';
import { headCommit, headCommits } from './git.js';
import { writeText } from './paths.js';
import { ROOT_REPO_NAME, type WorkspaceLayout } from './workspace.js';

export interface GuardApproval {
  guardId: string;
  reason: string;
  requester: string;
  baseline: string;
  baselines?: Record<string, string>;
  createdAt: string;
  file: string;
}

export interface GuardSettlement {
  blocking: Violation[];
  approved: Violation[];
}

export function approvalsDir(root: string): string {
  return path.join(root, '.orca-team-orchestration', 'approvals');
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function createApproval(
  root: string,
  guardId: string,
  reason: string,
  requester: string,
  layout?: WorkspaceLayout,
): GuardApproval {
  const now = new Date();
  const file = path.posix.join('.orca-team-orchestration', 'approvals', `${stamp(now)}-${guardId}.json`);
  const baselines = layout ? headCommits(layout) : undefined;
  const approval: GuardApproval = {
    guardId,
    reason,
    requester,
    baseline: baselines ? baselines[ROOT_REPO_NAME] ?? '' : headCommit(root),
    ...(baselines ? { baselines } : {}),
    createdAt: now.toISOString(),
    file,
  };
  writeText(path.join(root, file), `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

export function listApprovals(root: string): GuardApproval[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(approvalsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const approvals: GuardApproval[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(approvalsDir(root), entry.name), 'utf8')) as GuardApproval;
      if (typeof parsed.guardId === 'string') {
        approvals.push({ ...parsed, file: parsed.file ?? `.orca-team-orchestration/approvals/${entry.name}` });
      }
    } catch {
      // 损坏的审批文件忽略，不阻塞守则检查
    }
  }
  return approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function approvalCovers(approval: GuardApproval, repo: string, head: string | undefined): boolean {
  if (head === undefined || head === '') return false;
  if (approval.baselines && Object.keys(approval.baselines).length > 0) {
    return approval.baselines[repo] === head;
  }
  return repo === ROOT_REPO_NAME && approval.baseline === head;
}

export function settleViolations(
  root: string,
  violations: Violation[],
  layout?: WorkspaceLayout,
): GuardSettlement {
  if (violations.length === 0) return { blocking: [], approved: [] };
  const heads = layout ? headCommits(layout) : { [ROOT_REPO_NAME]: headCommit(root) };
  const approvals = listApprovals(root);
  const blocking: Violation[] = [];
  const approved: Violation[] = [];
  for (const violation of violations) {
    const repo = violation.repo ?? ROOT_REPO_NAME;
    const covered = approvals.some(
      (approval) => approval.guardId === violation.guardId && approvalCovers(approval, repo, heads[repo]),
    );
    (covered ? approved : blocking).push(violation);
  }
  return { blocking, approved };
}
