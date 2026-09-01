/**
 * Mirrors the backend's `Ticket` for the UI-only phase.
 *
 * Deliberately a copy, and deliberately temporary: `@10x/backend` is a workspace sibling, so
 * the wiring phase replaces this file with a type-only import from it. Duplication is exactly
 * the drift this monorepo was split to prevent — the frontend already once rendered
 * `prState`/`prAdditions`/`prDeletions` as `undefined` because its idea of a ticket lagged the
 * schema. Keep this file empty of anything but the shape.
 */

export type Status = "backlog" | "in_progress" | "in_review" | "done";

export type AgentStatus = "working" | "idle" | "done" | "died" | "blocked";

export type PullRequestState = "open" | "merged" | "closed";

export type Diagnostics = {
  paneBusyRetries: number;
  neededReadinessPoll: boolean;
  promptNotReadyRetries: number;
  spawnMs: number;
  readinessPolls: number;
};

export type Ticket = {
  id: string;
  number: number;
  projectId: string;
  title: string;
  description: string;
  status: Status;
  branch: string | null;
  agentName: string | null;
  agentStatus: AgentStatus | null;
  finished: boolean;
  died: boolean;
  hasWorktree: boolean;
  prNumber: number | null;
  prUrl: string | null;
  prState: PullRequestState | null;
  prAdditions: number | null;
  prDeletions: number | null;
  diagnostics: Diagnostics | null;
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  baseBranch: string;
};

export type SortOrder = "newest" | "oldest";

/** Column order is the state machine's order, and is not configurable. */
export const COLUMNS = [
  { status: "backlog", label: "Backlog" },
  { status: "in_progress", label: "In Progress" },
  { status: "in_review", label: "In Review" },
  { status: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ status: Status; label: string }>;
