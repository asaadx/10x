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
 * of a ticket lagged the schema, and it was missing `busy` entirely. Adding a field to the response is now a compile error here.
 *
 * Keep this file free of anything but the re-exports and what is genuinely frontend-local.
 */

// `Status` is also imported, not just re-exported: `COLUMNS` below needs it in local scope.
import type { Status } from "@10x/backend/types";

// `PLAYBOOKS` and `PRIORITIES` are values, not types, so each needs its own re-export line:
// both are runtime lists the backend validates against, and each entry is both the option a
// picker shows and the value it sends.
export { PLAYBOOKS, PRIORITIES } from "@10x/backend/types";

export type {
  AgentState,
  BoardResponse,
  Playbook,
  Preview,
  Priority,
  Project,
  ProvisionState,
  PullRequestState,
  SessionKind,
  Status,
} from "@10x/backend/types";

/**
 * The board renders the RESPONSE ticket, never the stored row, so `Ticket` here is
 * `BoardTicket`. The backend's `Ticket` lacks `busy` and `preview` — a component typed against
 * it would compile and then render nothing for them, which is the bug this whole arrangement
 * exists to make impossible.
 */
export type { BoardTicket as Ticket } from "@10x/backend/types";

/**
 * The toolbar's sort control: which field orders the board, and which direction. `date` is
 * the field the board has always sorted by; `priority` is the second axis this type was split
 * to accommodate. Direction is generic — "desc" means the highest value first, whether that
 * value is a timestamp (newest) or a priority (highest star count) — so one toggle icon covers
 * both keys instead of the key needing its own asc/desc vocabulary.
 */
export type SortKey = "date" | "priority";
export type SortDirection = "asc" | "desc";
export type SortOrder = { key: SortKey; direction: SortDirection };

/** Column order is the state machine's order, and is not configurable. */
export const COLUMNS = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To Do" },
  { status: "in_progress", label: "In Progress" },
  { status: "in_review", label: "In Review" },
  { status: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ status: Status; label: string }>;
