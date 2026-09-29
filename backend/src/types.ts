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
 * `backlog` holds raw ideas and `todo` holds work that is ready to start; both moves between
 * them are a human clicking a button: a plan is accepted, or a ticket is sent back to be
 * re-planned. Splitting them is what keeps guesswork out of `in_progress` — an implementation
 * agent inherits a plan rather than deriving one.
 *
 * `transitions.ts` is the authoritative table of which moves are legal and which route owns
 * each one. Read it there rather than here: a second copy of the machine is how this comment
 * went stale in the first place.
 *
 * `in_review` is reached automatically when the agent reports `done` (server.ts's poller), and
 * the ticket keeps its cloud session while it sits there — a Reject is a follow-up message
 * into the same session, which still holds the full context.
 */
export type Status = "backlog" | "todo" | "in_progress" | "in_review" | "done";

/** The three states a PR can be in from the board's point of view, mirroring `Status`. */
export type PullRequestState = "open" | "merged" | "closed";

/** Which kind of cloud session a ticket's `sessionId` names: the planner or the implementer. */
export type SessionKind = "plan" | "impl";

/**
 * The cloud agent's self-reported state. The board writes `starting`; the agent writes the
 * rest into the shared database, because a session's status cannot be read any other way.
 */
export type AgentState = "starting" | "working" | "done" | "blocked" | "failed";

/**
 * Which configured profile a ticket is dispatched with. 10x owns this vocabulary, so a closed
 * union is safe and gives the board an exhaustive option list.
 *
 * The array is the whole vocabulary and the type is derived from it, never the other way
 * around: the list is needed at runtime as well as at compile time, because the PATCH
 * validator in ticket-store.ts tests membership against exactly these values. A hand-written
 * union beside a hand-written validation list is two copies of one fact, and they drift
 * silently — the only symptom is the board offering a value the API then refuses to write.
 *
 * The displayed name IS the stored value, so a playbook has no second identity to keep in
 * sync — nothing to map, nothing to drift. Array order is the order the picker offers, so
 * that is one fact in one place too.
 */
export const PLAYBOOKS = [
  "Fullstack",
  "Frontend",
  "Backend",
  "Database",
  "DevOps",
  "Docs",
  "Research",
] as const;

export type Playbook = (typeof PLAYBOOKS)[number];

/**
 * How urgently a ticket should be worked, board-owned rather than derived: nothing computes
 * it from age or status, a human sets it. Mirrors `Playbook` in every way that matters — a
 * closed union 10x owns, an array that is both the runtime validation list and the type, and
 * array order is the order the picker offers (low to high, cheapest to justify first).
 *
 * The UI renders it as stars rather than the word, so the position in this array IS the star
 * count: `PRIORITIES.indexOf(p) + 1` stars, never a second low/medium/high-to-count mapping
 * that could drift from this list.
 */
export const PRIORITIES = ["low", "medium", "high"] as const;

export type Priority = (typeof PRIORITIES)[number];

/**
 * One line of a task breakdown or an acceptance criteria list. Stored as JSON text inside the
 * ticket row rather than as a child table (see db.ts): a list is only ever read and written
 * whole with its ticket, and the board derives its own ticked/total counts from the array.
 */
export type ChecklistItem = { text: string; done: boolean };

/**
 * A file attached to a ticket for the agent's prompt to reference. `path` is server-side, not
 * a URL: the file lives under STATE_DIR and the server decides how it is served. `size` and
 * `mime` are recorded at upload time so listing attachments never has to stat them.
 */
export type Attachment = { name: string; size: number; mime: string; path: string };

/**
 * Which side of a ticket's legacy before/after screenshot pair. Nothing writes these any more —
 * cloud agents post their shots on the pull request — but the columns and the board's panes
 * still exist until the frontend drops them.
 */
export type ScreenshotSide = "before" | "after";

/**
 * How far along a project's local clone is. A project is only usable at `ready`: spawn and plan
 * refuse anything else, because there is no repository on disk to create a worktree in yet.
 */
export const PROVISION_STATES = ["pending", "cloning", "ready", "failed"] as const;
export type ProvisionState = (typeof PROVISION_STATES)[number];

export type Project = {
  /** Immutable slug used in branch and agent names. Renaming would orphan worktrees. */
  id: string;
  /** Display name. Freely renameable — nothing derived depends on it. */
  name: string;
  /** The user's own note about what this project is. Display only; never sent to an agent. */
  description: string;
  /**
   * GitHub identity, and the project's real identity. `repoPath` is only where this repo
   * happens to be materialised on this machine; owner/repo is what the project *is*, and what
   * every push and pull request targets.
   */
  owner: string;
  repo: string;
  /**
   * Derived, never user-supplied: `$PROJECTS_ROOT/<id>`. 10x clones here itself rather than
   * borrowing a checkout you also work in, so the base branch is never dirty or mid-rebase.
   */
  repoPath: string;
  /**
   * The bare upstream branch name, e.g. `main` — never `origin/main`. Pull requests need the
   * real branch name as their base; only worktree creation takes the `origin/` prefix
   * (memory/gotchas.md G7).
   */
  baseBranch: string;
  provisionState: ProvisionState;
  /** Empty unless `provisionState` is `failed`. Redacted — never holds a token. */
  provisionError: string;
  /**
   * Whether `repoPath` is a clone 10x made, i.e. sits directly under `PROJECTS_ROOT`.
   *
   * Derived rather than stored, and on the wire rather than recomputed in the UI, because two
   * things must agree about it: the delete route only removes the directory when this is true,
   * and the confirmation dialog must only *promise* to remove it when this is true. A project
   * that predates this feature keeps whatever folder the user pointed 10x at — often their own
   * working checkout — and telling them it is about to be deleted would be a lie about an
   * irreversible act.
   */
  ownsClone: boolean;
  /** The command Preview runs in a ticket's checkout, with `PORT` set. '' = start nothing. */
  devCommand: string;
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
  /** The agent reported `done` and the ticket moved to review; cleared by Reject and respawn. */
  finished: boolean;
  /** Legacy (Herdr: the pane exited). Nothing sets it any more; kept until the frontend drops it. */
  died: boolean;
  /** Hidden from every board read once true. No un-archive — see memory/parking-lot.md. */
  archived: boolean;
  /** The branch the agent reports it pushed. Null until it does. */
  branch: string | null;
  /** Legacy (Herdr agent name). Nothing sets it any more; kept until the frontend drops it. */
  agentName: string | null;
  /** Legacy (OMP transcript directory). Nothing sets it any more. */
  sessionDir: string | null;
  /** The agent's draft PR, written by the agent; or the PR Accept opened from `branch`. */
  prNumber: number | null;
  prUrl: string | null;
  // Written by the webhook receiver from the `pull_request` payload (server.ts
  // /webhooks/github). additions/deletions need no API call — they are already on the event.
  prState: PullRequestState | null;
  prAdditions: number | null;
  prDeletions: number | null;
  /**
   * The dispatch profile. Never null: the column is NOT NULL with a 'Fullstack' default (see
   * db.ts), because every ticket is dispatched with some profile and the picker offers no way
   * to choose none — a nullable field would model a state the product does not have.
   */
  playbook: Playbook;
  /**
   * Never null: the column is NOT NULL with a 'low' default (see db.ts), so a ticket that
   * predates this field, or one created without ever naming a priority, reads as the lowest
   * one rather than an absence the board would have to special-case.
   */
  priority: Priority;
  /**
   * The plan and its attachments, each one JSON text in a single column (see db.ts). Empty
   * arrays, never null: the columns default to '[]', so "no items yet" and "never migrated"
   * decode identically and no consumer has to guard.
   */
  taskBreakdown: ChecklistItem[];
  acceptanceCriteria: ChecklistItem[];
  attachments: Attachment[];
  /**
   * The before/after pair for a ticket that changed the UI. Two nullable columns underneath,
   * nested here because each side stands alone — a ticket has a before for the whole length of
   * its run before the after exists — and the board renders a placeholder for whichever is
   * missing. The object itself is always present; only its sides are nullable.
   */
  screenshots: { before: string | null; after: string | null };
  /**
   * When the AGENT began work, distinct from `createdAt`: null on a ticket that has never been
   * spawned, and what the card's run timer counts from. Stamped by the spawn claim, never by an
   * edit.
   */
  startedAt: string | null;
  /**
   * The Claude Code cloud session working this ticket (docs/prototype-cloud.md). The board
   * writes the id, url and kind when it starts one; null on a ticket that has never had one.
   */
  sessionId: string | null;
  sessionUrl: string | null;
  sessionKind: SessionKind | null;
  /**
   * The agent's own report, written by the agent straight into the shared database — there is
   * no API to read a session's status, so this is the only signal the board has. Null means
   * "no usable report", including a value outside the union (db.ts `toAgentState`).
   */
  agentState: AgentState | null;
  /** The agent's last one-paragraph summary, or its question when `blocked`. */
  agentNote: string | null;
  /** ISO instant of the agent's last write. */
  agentUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A local Preview of a ticket's pushed branch (docs/prototype-cloud.md "Preview"): the branch
 * fetched into a detached worktree under `$STATE_DIR/previews/<ticketId>`, a port block
 * reserved for it, and — only when the project has a `devCommand` — that command running.
 * Held in server memory, so it is gone after a backend restart.
 */
export type Preview = {
  path: string;
  port: number;
  url: string;
  /** The project's dev command, or `""` when none is configured and nothing was started. */
  command: string;
  running: boolean;
};

/**
 * What `GET /tickets` returns for each ticket. Since the move to cloud sessions the board is a
 * pure database read: everything about the agent (session link, state, last note) was written
 * into the row by the board or by the agent itself, and the only thing resolved at read time is
 * the in-memory Preview and whether an operation is in flight.
 */
export type BoardTicket = Ticket & {
  busy: boolean;
  preview: Preview | null;
};

export type BoardResponse = { tickets: BoardTicket[] };
