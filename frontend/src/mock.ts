import type { Project, Ticket } from "@/types.ts";

/**
 * Fixtures for the UI-only phase, deleted when the board is wired.
 *
 * Chosen to cover every visual state the board can reach rather than to look tidy: a working
 * agent, a finished-but-unreviewed run, a run that died without finishing, a merged PR, a
 * closed-unmerged PR, an orphaned worktree, and an empty column.
 */

const iso = (daysAgo: number, hour = 9) =>
  new Date(Date.UTC(2026, 7, 31 - daysAgo, hour, 0, 0)).toISOString();

const base = {
  projectId: "p1",
  branch: null,
  agentName: null,
  agentStatus: null,
  finished: false,
  died: false,
  hasWorktree: false,
  prNumber: null,
  prUrl: null,
  prState: null,
  prAdditions: null,
  prDeletions: null,
  diagnostics: null,
} satisfies Partial<Ticket>;

export const MOCK_PROJECTS: Project[] = [
  { id: "p1", name: "10x", slug: "10x", repoPath: "/home/asaad/GitHub/10x", baseBranch: "dev" },
  { id: "p2", name: "10x-test", slug: "10x-test", repoPath: "/home/asaad/GitHub/10x-test", baseBranch: "master" },
];

export const MOCK_TICKETS: Ticket[] = [
  {
    ...base,
    id: "10x-7",
    number: 7,
    title: "Add a keyboard shortcut for the composer",
    description: "Cmd+N should open the New ticket drawer from anywhere on the board.",
    status: "backlog",
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
    status: "backlog",
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
    agentName: "10x-5",
    agentStatus: "working",
    hasWorktree: true,
    diagnostics: { paneBusyRetries: 2, neededReadinessPoll: true, promptNotReadyRetries: 0, spawnMs: 3480, readinessPolls: 19 },
    createdAt: iso(1),
    updatedAt: iso(0, 14),
  },
  {
    ...base,
    id: "10x-4",
    number: 4,
    title: "Search should match ticket ids",
    description: "Typing 10x-4 should find this card.",
    status: "in_progress",
    branch: "ticket/10x/4",
    agentName: "10x-4",
    agentStatus: "died",
    died: true,
    hasWorktree: true,
    diagnostics: { paneBusyRetries: 0, neededReadinessPoll: false, promptNotReadyRetries: 0, spawnMs: 2110, readinessPolls: 4 },
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
    agentName: "10x-3",
    agentStatus: "idle",
    finished: true,
    hasWorktree: true,
    diagnostics: { paneBusyRetries: 0, neededReadinessPoll: false, promptNotReadyRetries: 1, spawnMs: 2890, readinessPolls: 6 },
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
    finished: true,
    hasWorktree: true,
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
