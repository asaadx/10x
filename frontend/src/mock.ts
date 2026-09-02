import type { Project, Ticket } from "@/types.ts";

/**
 * Fixtures for the UI-only phase, deleted when the board is wired.
 *
 * Chosen to cover every visual state the board can reach rather than to look tidy: a working
 * agent, a finished-but-unreviewed run, a run that died without finishing, a merged PR, a
 * closed-unmerged PR, an orphaned worktree, and an empty column.
 *
 * These are checked against the real `GET /tickets` shape now, not a local copy of it, so the
 * resolved fields have to be internally consistent: `branch` and `agentName` are always present
 * because the board derives them, `agentStatus`/`paneId`/`workspaceId` are non-null only while
 * Herdr still has the agent, and `worktreePath` is non-null exactly when `hasWorktree` is.
 */

const iso = (daysAgo: number, hour = 9) =>
  new Date(Date.UTC(2026, 7, 31 - daysAgo, hour, 0, 0)).toISOString();

/** Herdr's worktree directory: its per-repo folder plus the branch with `/` turned into `-`. */
const worktree = (number: number) => `/home/asaad/.herdr/worktrees/10x/ticket-10x-${number}`;

/** The zero value of `Diagnostics`: a ticket that has never been spawned, or whose run is over. */
const noDiagnostics = {
  startAttempts: 0,
  paneBusyRetries: 0,
  startReturnedStatus: null,
  startReturnedReady: null,
  startReturnedAfterMs: null,
  neededReadinessPoll: false,
  readinessPolls: 0,
  readyAfterMs: null,
  promptAttempts: 0,
  promptNotReadyRetries: 0,
  reusedExistingAgent: false,
};

/**
 * A complete ticket rather than a `Partial`, so the shared defaults are checked against the
 * real type once instead of failing at every spread site. Every fixture overrides
 * its identity fields.
 */
const base: Ticket = {
  id: "",
  // The backend has no separate `slug`: a project's id IS the slug that branches are built
  // from, which is why every branch below reads `ticket/10x/<n>`.
  projectId: "10x",
  number: 0,
  title: "",
  description: "",
  status: "backlog",
  branch: "",
  agentName: "",
  agentStatus: null,
  finished: false,
  died: false,
  sessionDir: null,
  hasWorktree: false,
  worktreePath: null,
  paneId: null,
  workspaceId: null,
  busy: false,
  prNumber: null,
  prUrl: null,
  prState: null,
  prAdditions: null,
  prDeletions: null,
  diagnostics: noDiagnostics,
  createdAt: iso(0),
  updatedAt: iso(0),
};

export const MOCK_PROJECTS: Project[] = [
  {
    id: "10x",
    name: "10x",
    repoPath: "/home/asaad/GitHub/10x",
    baseBranch: "dev",
    createdAt: iso(30),
    updatedAt: iso(30),
  },
  {
    id: "10x-test",
    name: "10x-test",
    repoPath: "/home/asaad/GitHub/10x-test",
    baseBranch: "master",
    createdAt: iso(20),
    updatedAt: iso(20),
  },
];

export const MOCK_TICKETS: Ticket[] = [
  {
    ...base,
    id: "10x-8",
    number: 8,
    title: "Hide old Done tickets behind a filter",
    description: "Done grows without bound. An `archived` flag and a toggle, not a sixth column.",
    status: "backlog",
    branch: "ticket/10x/8",
    agentName: "ticket-10x-8",
    createdAt: iso(0, 11),
    updatedAt: iso(0, 11),
  },
  {
    ...base,
    id: "10x-7",
    number: 7,
    title: "Add a keyboard shortcut for the composer",
    description: "Cmd+N should open the New ticket drawer from anywhere on the board.",
    status: "backlog",
    branch: "ticket/10x/7",
    agentName: "ticket-10x-7",
    createdAt: iso(0),
    updatedAt: iso(0),
  },
  {
    ...base,
    id: "10x-6",
    number: 6,
    title: "Reject should preserve the previous reason",
    description:
      "When a ticket is rejected twice, the drawer starts empty. Pre-fill it with the last reason so a small amendment does not mean retyping the whole thing.",
    status: "todo",
    branch: "ticket/10x/6",
    agentName: "ticket-10x-6",
    createdAt: iso(3),
    updatedAt: iso(3),
  },
  {
    ...base,
    id: "10x-5",
    number: 5,
    title: "Kill the agent's dev server on review",
    description: "Find what listens in the ticket's port block and prove it belongs to the worktree before killing it.",
    status: "in_progress",
    branch: "ticket/10x/5",
    agentName: "ticket-10x-5",
    agentStatus: "working",
    sessionDir: "/home/asaad/.omp/sessions/ticket-10x-5",
    hasWorktree: true,
    worktreePath: worktree(5),
    paneId: "w15:p1",
    workspaceId: "w15",
    // The pane was busy twice and readiness had to be polled — the spawn guard firing, which
    // is normal rather than a fault (memory/spawn.md).
    diagnostics: {
      ...noDiagnostics,
      startAttempts: 3,
      paneBusyRetries: 2,
      startReturnedStatus: "starting",
      startReturnedReady: false,
      startReturnedAfterMs: 210,
      neededReadinessPoll: true,
      readinessPolls: 19,
      readyAfterMs: 3480,
      promptAttempts: 1,
    },
    createdAt: iso(1),
    updatedAt: iso(0, 14),
  },
  {
    ...base,
    id: "10x-9",
    number: 9,
    title: "Validate the project slug at creation time",
    description: "Reject a slug that cannot become a branch, at the point the project is created.",
    status: "in_progress",
    branch: "ticket/10x/9",
    agentName: "ticket-10x-9",
    // Herdr saw a real question UI. `agent.prompt` refuses a blocked agent outright, so this
    // ticket cannot move until a human answers (memory/agent-status.md).
    agentStatus: "blocked",
    sessionDir: "/home/asaad/.omp/sessions/ticket-10x-9",
    hasWorktree: true,
    worktreePath: worktree(9),
    paneId: "w17:p1",
    workspaceId: "w17",
    diagnostics: {
      ...noDiagnostics,
      startAttempts: 1,
      startReturnedStatus: "idle",
      startReturnedReady: true,
      startReturnedAfterMs: 1980,
      readyAfterMs: 1980,
      promptAttempts: 1,
    },
    createdAt: iso(1, 12),
    updatedAt: iso(0, 9),
  },
  {
    ...base,
    id: "10x-4",
    number: 4,
    title: "Search should match ticket ids",
    description: "Typing 10x-4 should find this card.",
    status: "in_progress",
    branch: "ticket/10x/4",
    agentName: "ticket-10x-4",
    // The pane exited, so Herdr no longer lists the agent: no status, no pane, no workspace.
    // `died` is the persisted fact; `agentStatus` only ever carries what Herdr reports.
    died: true,
    sessionDir: "/home/asaad/.omp/sessions/ticket-10x-4",
    hasWorktree: true,
    worktreePath: worktree(4),
    diagnostics: {
      ...noDiagnostics,
      startAttempts: 1,
      startReturnedStatus: "idle",
      startReturnedReady: true,
      startReturnedAfterMs: 2110,
      readyAfterMs: 2110,
      promptAttempts: 1,
    },
    createdAt: iso(2),
    updatedAt: iso(1),
  },
  {
    ...base,
    id: "10x-3",
    number: 3,
    title: "Diagnostics collapses itself after a second",
    description: "The poll rebuilds the card, which recreates the details element and loses its open state.",
    status: "in_review",
    branch: "ticket/10x/3",
    agentName: "ticket-10x-3",
    agentStatus: "idle",
    finished: true,
    sessionDir: "/home/asaad/.omp/sessions/ticket-10x-3",
    hasWorktree: true,
    worktreePath: worktree(3),
    paneId: "w9:p1",
    workspaceId: "w9",
    diagnostics: {
      ...noDiagnostics,
      startAttempts: 1,
      startReturnedStatus: "starting",
      startReturnedReady: false,
      startReturnedAfterMs: 90,
      neededReadinessPoll: true,
      readinessPolls: 6,
      readyAfterMs: 2890,
      promptAttempts: 2,
      promptNotReadyRetries: 1,
    },
    createdAt: iso(4),
    updatedAt: iso(0, 11),
  },
  {
    ...base,
    id: "10x-2",
    number: 2,
    title: "Record merged and closed PR state from a webhook",
    description: "State derives from merged plus state, never from action.",
    status: "done",
    branch: "ticket/10x/2",
    agentName: "ticket-10x-2",
    finished: true,
    // Retired agent, worktree not yet reclaimed — the state "Remove worktree" exists for. The
    // transcript outlives the worktree, and diagnostics are per-run so they are gone.
    sessionDir: "/home/asaad/.omp/sessions/ticket-10x-2",
    hasWorktree: true,
    worktreePath: worktree(2),
    prNumber: 30,
    prUrl: "https://github.com/asaadx/10x/pull/30",
    prState: "merged",
    prAdditions: 412,
    prDeletions: 87,
    createdAt: iso(6),
    updatedAt: iso(2),
  },
  {
    ...base,
    id: "10x-1",
    number: 1,
    title: "Spike: drag and drop between columns",
    description: "Abandoned — only two of the eight moves are legal, so buttons already say it better.",
    status: "done",
    branch: "ticket/10x/1",
    agentName: "ticket-10x-1",
    finished: true,
    prNumber: 12,
    prUrl: "https://github.com/asaadx/10x/pull/12",
    prState: "closed",
    prAdditions: 64,
    prDeletions: 9,
    createdAt: iso(9),
    updatedAt: iso(5),
  },
];
