/**
 * The shared vocabulary of the two packages.
 *
 * The frontend imports this file across the workspace (`@10x/backend/types`), which is the
 * whole reason it exists: `frontend/src/types.ts` used to be a hand-copied duplicate and it
 * drifted — the backend gained `prState`/`prAdditions`/`prDeletions` and the board rendered
 * nothing for weeks. One definition, two consumers, and adding a field is now a compile error
 * on the side that forgot it.
 *
 * It MUST stay free of imports with side effects. `db.ts` opens a SQLite database at module
 * load, so anything reachable from here has to be inert — in practice this file imports
 * nothing at all, and the frontend imports it with `import type` so it erases completely
 * rather than dragging `node:sqlite` into a browser bundle.
 */

/**
 * `backlog` holds raw ideas and `todo` holds work that is ready to start; the only move
 * between them is a Plan. Splitting them is what keeps guesswork out of `in_progress` — an
 * implementation agent inherits a plan rather than deriving one.
 *
 * `in_review` is reached automatically when the agent's turn completes, and the ticket keeps
 * both its live agent and its port block while it sits there — a Reject has to be able to
 * re-prompt the same agent with its full context, and a Preview binds the same range.
 */
export type Status = "backlog" | "todo" | "in_progress" | "in_review" | "done";

/** The three states a PR can be in from the board's point of view, mirroring `Status`. */
export type PullRequestState = "open" | "merged" | "closed";

export type Project = {
  /** Immutable slug used in branch and agent names. Renaming would orphan worktrees. */
  id: string;
  /** Display name. Freely renameable — nothing derived depends on it. */
  name: string;
  repoPath: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
};

export type Ticket = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  /** A turn ended after `working` was observed (memory/agent-status.md). */
  finished: boolean;
  /** The pane exited. NOT the same as finished (memory/teardown.md rule 3). */
  died: boolean;
  /** Persisted, not derived — see db.ts rule 1. Null until first spawn. */
  branch: string | null;
  agentName: string | null;
  /** OMP transcript directory, needed by teardown and outliving the worktree (memory/reconciliation.md). */
  sessionDir: string | null;
  /** Set together by `setPullRequest` once Accept opens the PR. Null until then. */
  prNumber: number | null;
  prUrl: string | null;
  // Written by the webhook receiver from the `pull_request` payload (server.ts
  // /webhooks/github). additions/deletions need no API call — they are already on the event.
  prState: PullRequestState | null;
  prAdditions: number | null;
  prDeletions: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Per-run spawn diagnostics.
 *
 * Deliberately NOT persisted: these describe one attempt at starting an agent and are
 * debugging output, not ticket state. Losing them on restart is correct.
 *
 * Their reason for existing is memory/spawn.md — `agent.start` returns before the agent is usable, so
 * the guard retries and polls. These fields let the UI show whether that fired, which is
 * normal rather than a fault.
 */
export type Diagnostics = {
  startAttempts: number;
  paneBusyRetries: number;
  startReturnedStatus: string | null;
  startReturnedReady: boolean | null;
  startReturnedAfterMs: number | null;
  neededReadinessPoll: boolean;
  readinessPolls: number;
  readyAfterMs: number | null;
  promptAttempts: number;
  promptNotReadyRetries: number;
  /** True when spawn re-attached to an already-running agent rather than starting one. */
  reusedExistingAgent: boolean;
};

/**
 * A ticket-namespaced worktree no live ticket claims. Reported, never reclaimed.
 *
 * Lives here rather than in reconcile.ts, which produces it, because it is part of the
 * `GET /tickets` response and this file is the only one the frontend may reach.
 */
export type Orphan = { branch: string; path: string };

/**
 * What `GET /tickets` actually returns for each ticket: the stored row plus everything the
 * board resolves at read time. Distinct from `Ticket` on purpose — four of these fields exist
 * only in the response, and a frontend typed against `Ticket` would be quietly wrong.
 */
export type BoardTicket = Ticket & {
  branch: string; // resolved, never null in a response
  agentName: string; // resolved, never null in a response
  /**
   * Herdr's `agent_status` string, passed through untouched. Left as `string` deliberately:
   * nothing in this codebase knows the closed set Herdr emits — `isSettled` and
   * `isAgentReady` in lifecycle.ts test individual values against a bare `string` — and a
   * union guessed here would silently exclude a status the board then failed to display.
   */
  agentStatus: string | null;
  hasWorktree: boolean;
  worktreePath: string | null;
  paneId: string | null;
  workspaceId: string | null;
  busy: boolean;
  /**
   * ISO timestamp of when the agent was spawned, or `null` when unknown. NOT persisted yet —
   * there is no `started_at` column — so the server always sends `null` here today. A real
   * value requires a `started_at` write, once, at the point the spawn compare-and-swap wins.
   */
  startedAt: string | null;
  /**
   * A before/after screenshot pair for a ticket that changed the UI, or `null` when the
   * ticket has none. NOT persisted — there is no table and no capture path — so the server
   * always sends `null` here today. Populating it means having the agent capture the two
   * images. Each URL is independently nullable: a pair can exist before both shots are
   * taken, and the UI falls back to a placeholder pane for whichever one is missing.
   */
  screenshots: { before: string | null; after: string | null } | null;
  diagnostics: Diagnostics;
};

/** The `GET /tickets` body. `board()` in server.ts is annotated with this so it cannot drift. */
export type BoardResponse = { tickets: BoardTicket[]; unowned: Orphan[] };
