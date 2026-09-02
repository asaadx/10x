/**
 * The frontend's view of the shared vocabulary.
 *
 * Not a copy any more: every shape below comes from `@10x/backend/types`, the single file both
 * packages define these in. The backend is the source of truth for that vocabulary, and a
 * vocabulary is data, so one value — `PLAYBOOKS` — crosses alongside the types rather than
 * being re-stated here. The rest are `import type`, which `verbatimModuleSyntax` erases at
 * build. That file is import-free by design, so even the value export pulls in nothing but
 * itself — no backend code, and in particular no `node:sqlite`, reaches the bundle.
 *
 * The duplication this replaces is exactly the drift the monorepo was split to prevent: the
 * frontend once rendered `prState`/`prAdditions`/`prDeletions` as `undefined` because its idea
 * of a ticket lagged the schema, and it was missing `worktreePath`, `paneId`, `workspaceId` and
 * `busy` entirely. Adding a field to the response is now a compile error here.
 *
 * Keep this file free of anything but the re-exports and what is genuinely frontend-local.
 */

// `Status` is also imported, not just re-exported: `COLUMNS` below needs it in local scope.
import type { Status } from "@10x/backend/types";

// `PLAYBOOKS` is a value, not a type, so it needs its own re-export line: it is the runtime
// list the backend validates against, and each entry is both the option the picker shows and
// the value it sends.
export { PLAYBOOKS } from "@10x/backend/types";

export type {
  BoardResponse,
  Diagnostics,
  Orphan,
  Playbook,
  Project,
  PullRequestState,
  Status,
} from "@10x/backend/types";

/**
 * The board renders the RESPONSE ticket, never the stored row, so `Ticket` here is
 * `BoardTicket`. The backend's `Ticket` deliberately lacks `agentStatus`, `hasWorktree`,
 * `diagnostics` and the rest — a component typed against it would compile and then render
 * nothing for them, which is the bug this whole arrangement exists to make impossible.
 */
export type { BoardTicket as Ticket } from "@10x/backend/types";

export type SortOrder = "newest" | "oldest";

/** Column order is the state machine's order, and is not configurable. */
export const COLUMNS = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To Do" },
  { status: "in_progress", label: "In Progress" },
  { status: "in_review", label: "In Review" },
  { status: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ status: Status; label: string }>;
