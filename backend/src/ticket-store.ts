/**
 * Ticket persistence, plus the route-handler bodies for `/tickets`.
 *
 * Two invariants this file exists to hold.
 *
 *  1. `number` is per-project and starts at 1, and it is half of the `UNIQUE(project_id,
 *     number)` key that every branch and agent name is derived from (`branchFor` /
 *     `agentNameFor`). A plain read-then-insert lets two concurrent creates read the same
 *     MAX and one of them dies on the constraint, so the read and the insert share a
 *     `BEGIN IMMEDIATE`.
 *
 *  2. Editing a ticket touches exactly five fields — `title`, `description`, `playbook`,
 *     `taskBreakdown` and `acceptanceCriteria` — and nothing else. `status`, `branch`,
 *     `agent_name`, `session_dir`, `started_at`, `finished` and `died` belong to the
 *     spawn/teardown lifecycle — status in particular IS the concurrency lock
 *     (memory/herdr-omp-lifecycle.md memory/operations.md), so a PATCH that quietly reassigned it would
 *     walk the board straight past the compare-and-swap that stops a double spawn.
 *     A PATCH naming any of them is a 400; the lifecycle writes through `setRunFields`.
 *
 *     `attachments` and the screenshot pair are absent from that list on purpose: they are
 *     written by an upload path, not by an edit, so a PATCH cannot forge a stored file.
 */
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { db, nowIso, toTicket } from "./db.ts";
import {
  PLAYBOOKS,
  type Attachment,
  type ChecklistItem,
  type Playbook,
  type Ticket,
} from "./types.ts";

/** `{ error: "<code>", ...context }` — the uniform error envelope the whole API uses. */
export type ErrorBody = { error: string; field?: string; message?: string; [key: string]: unknown };

export type TicketResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; status: number; body: ErrorBody };

/** Written only by spawn and teardown. `null` clears; absent leaves the column alone. */
export type RunFields = {
  branch?: string | null;
  agentName?: string | null;
  sessionDir?: string | null;
  /**
   * When the agent began work. The lifecycle's field, not an editable one: it is stamped once,
   * where the spawn compare-and-swap wins, and the card's run timer counts from it.
   */
  startedAt?: string | null;
  finished?: boolean;
  died?: boolean;
};

// ---------------------------------------------------------------------------
// Row decoding. node:sqlite hands back Record<string, SQLOutputValue>, so this is the
// parse boundary where dynamic column values become the typed row `toTicket` wants.
// ---------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

const bad = (column: string, value: SQLOutputValue | undefined): never => {
  throw new Error(`tickets.${column}: unexpected ${value === undefined ? "missing" : typeof value}`);
};

const text = (row: Row, column: string): string => {
  const v = row[column];
  return typeof v === "string" ? v : bad(column, v);
};

const maybeText = (row: Row, column: string): string | null => {
  const v = row[column];
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : bad(column, v);
};

const int = (row: Row, column: string): number => {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return bad(column, v);
};

const intOrNull = (row: Row, column: string): number | null => {
  const v = row[column];
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return bad(column, v);
};

/**
 * A JSON list column: one TEXT value holding a whole array, which is how the plan and the
 * attachments are stored (see db.ts). This is where it becomes a typed array.
 *
 * NULL decodes to an empty list. The migration never actually produces one — SQLite hands the
 * `'[]'` default back for every row that predates a `NOT NULL DEFAULT '[]'` column, verified
 * against node:sqlite — so this only covers a database whose column arrived without that
 * default, where the alternative is every reader crashing on a null it cannot use.
 *
 * A non-array, or JSON that will not parse, throws through `bad()` naming the column: a
 * corrupt row is a bug to surface, and returning `[]` would hide it right up until the next
 * write silently replaced the ticket's plan with nothing.
 *
 * The items themselves are NOT validated. Only this API writes these columns and
 * `updateTicket` narrows every element on the way in, so what comes back out is whatever we
 * put in. This is the seam to tighten if anything else ever gains write access.
 */
const jsonList = <T>(row: Row, column: string): T[] => {
  const v = row[column];
  if (v === null || v === undefined) return [];
  if (typeof v !== "string") return bad(column, v);
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return bad(column, v);
  }
  return Array.isArray(parsed) ? (parsed as T[]) : bad(column, v);
};

const decode = (row: Row): Ticket =>
  toTicket({
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    number: int(row, "number"),
    title: text(row, "title"),
    description: text(row, "description"),
    status: text(row, "status"),
    finished: int(row, "finished"),
    died: int(row, "died"),
    branch: maybeText(row, "branch"),
    agent_name: maybeText(row, "agent_name"),
    session_dir: maybeText(row, "session_dir"),
    pr_number: intOrNull(row, "pr_number"),
    pr_url: maybeText(row, "pr_url"),
    pr_state: maybeText(row, "pr_state"),
    pr_additions: intOrNull(row, "pr_additions"),
    pr_deletions: intOrNull(row, "pr_deletions"),
    // Total, not `maybeText`: the column is NOT NULL with a default (db.ts), so a NULL here is
    // a corrupt row and belongs in `bad()` rather than being smuggled through as a value.
    // `toTicket` casts it to `Playbook`; why that is a cast and not a check is noted there.
    playbook: text(row, "playbook"),
    task_breakdown: jsonList<ChecklistItem>(row, "task_breakdown"),
    acceptance_criteria: jsonList<ChecklistItem>(row, "acceptance_criteria"),
    attachments: jsonList<Attachment>(row, "attachments"),
    screenshot_before: maybeText(row, "screenshot_before"),
    screenshot_after: maybeText(row, "screenshot_after"),
    started_at: maybeText(row, "started_at"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  });

// ---------------------------------------------------------------------------
// Statements. Prepared once: db.ts has already run the schema at import time.
// ---------------------------------------------------------------------------

const SELECT_ALL = db.prepare("SELECT * FROM tickets ORDER BY project_id, number");
const SELECT_BY_PROJECT = db.prepare(
  "SELECT * FROM tickets WHERE project_id = ? ORDER BY project_id, number",
);
const SELECT_ONE = db.prepare("SELECT * FROM tickets WHERE id = ?");
const SELECT_PROJECT_ID = db.prepare("SELECT id FROM projects WHERE id = ?");
/**
 * Claim the next ticket number by ADVANCING the project's counter, never by reading
 * MAX(number). Deleting the highest ticket would otherwise recycle its number, and since
 * deleting a ticket deliberately leaves its worktree in place (memory/teardown.md), the new ticket's
 * branch would collide with the orphan still on disk — inheriting another ticket's work.
 * RETURNING gives us the claimed value and the increment in one atomic statement.
 */
const CLAIM_NEXT_NUMBER = db.prepare(
  "UPDATE projects SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS next",
);
const INSERT_TICKET = db.prepare(`
  INSERT INTO tickets (id, project_id, number, title, description, status,
                       finished, died, branch, agent_name, session_dir,
                       created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'backlog', 0, 0, NULL, NULL, NULL, ?, ?)
`);
const DELETE_TICKET = db.prepare("DELETE FROM tickets WHERE id = ?");

/**
 * Shared writer for both mutation paths. Column names are literals from this file, never
 * request data, so interpolating them is safe; the values are always bound.
 *
 * `updated_at` is appended unconditionally, which is also why an empty-fields
 * `setRunFields` still touches the row.
 */
function writeColumns(id: string, columns: [string, SQLInputValue][]): void {
  const assignments = columns.map(([column]) => `${column} = ?`).join(", ");
  const values = columns.map(([, value]) => value);
  values.push(nowIso(), id);
  const sql = `UPDATE tickets SET ${assignments}${assignments ? ", " : ""}updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...values);
}

// ---------------------------------------------------------------------------
// Input narrowing
// ---------------------------------------------------------------------------

/**
 * The untrusted request body. Fields stay `unknown` because JSON gives no guarantees —
 * each one is narrowed at its own use below.
 */
type TicketInput = {
  projectId?: unknown;
  title?: unknown;
  description?: unknown;
  playbook?: unknown;
  taskBreakdown?: unknown;
  acceptanceCriteria?: unknown;
};

const invalid = (field: string, message: string): TicketResult => ({
  ok: false,
  status: 400,
  body: { error: "invalid_input", field, message },
});

const notAnObject: TicketResult = {
  ok: false,
  status: 400,
  body: { error: "invalid_input", message: "body must be a JSON object" },
};

/**
 * The request-side counterpart to `jsonList`: a checklist read out of the database is trusted
 * because only this function let it in, which is exactly why this one validates every item.
 * Both lists are stored as JSON text, so an item missing `done` would be written verbatim and
 * come back as a row the board can render neither ticked nor unticked.
 */
const isChecklist = (value: unknown): value is ChecklistItem[] =>
  Array.isArray(value) &&
  value.every(
    (item: unknown): boolean =>
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string" &&
      "done" in item &&
      typeof item.done === "boolean",
  );

/**
 * The same asymmetry, for the one closed vocabulary a request can set. `PLAYBOOKS` is the
 * only list of slugs in the codebase, so this guard cannot fall behind the union it narrows
 * to, and the error message can name the allowed values without repeating them.
 */
const isPlaybook = (value: unknown): value is Playbook =>
  PLAYBOOKS.some((playbook) => playbook.slug === value);

/** Owned by the lifecycle, so naming one in a PATCH is a mistake worth reporting. */
const IMMUTABLE = [
  "status",
  "number",
  "projectId",
  "branch",
  "agentName",
  "finished",
  "died",
  "sessionDir",
] as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listTickets(projectId?: string): Ticket[] {
  const rows = projectId === undefined ? SELECT_ALL.all() : SELECT_BY_PROJECT.all(projectId);
  return rows.map(decode);
}

export function getTicket(id: string): Ticket | undefined {
  const row = SELECT_ONE.get(id);
  return row === undefined ? undefined : decode(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function createTicket(input: unknown): TicketResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return notAnObject;
  const { projectId, title, description }: TicketInput = input;

  if (typeof projectId !== "string" || projectId === "") {
    return invalid("projectId", "required, must be a non-empty string");
  }
  if (typeof title !== "string" || title.trim() === "") {
    return invalid("title", "required, must be a non-empty string");
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return invalid("description", "must be a string when present");
  }

  let id: string;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (SELECT_PROJECT_ID.get(projectId) === undefined) {
      db.exec("ROLLBACK");
      return { ok: false, status: 404, body: { error: "no_such_project", projectId } };
    }

    const counted = CLAIM_NEXT_NUMBER.get(projectId);
    if (counted === undefined) throw new Error("next-number claim returned no row");
    const number = int(counted, "next");
    id = `${projectId}-${number}`;
    // One timestamp, both columns: "never edited" then reads as createdAt === updatedAt.
    const ts = nowIso();

    INSERT_TICKET.run(id, projectId, number, title.trim(), description ?? "", ts, ts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const ticket = getTicket(id);
  if (ticket === undefined) throw new Error(`ticket ${id} vanished after insert`);
  return { ok: true, ticket };
}

export function updateTicket(id: string, input: unknown): TicketResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return notAnObject;

  const existing = getTicket(id);
  if (existing === undefined) {
    return { ok: false, status: 404, body: { error: "no_such_ticket", id } };
  }

  for (const field of IMMUTABLE) {
    if (Object.hasOwn(input, field)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "immutable_field",
          field,
          message: `${field} is owned by the spawn/teardown lifecycle and cannot be edited`,
        },
      };
    }
  }

  const { title, description, playbook, taskBreakdown, acceptanceCriteria }: TicketInput = input;
  const columns: [string, SQLInputValue][] = [];
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim() === "") {
      return invalid("title", "must be a non-empty string");
    }
    columns.push(["title", title.trim()]);
  }
  if (description !== undefined) {
    if (typeof description !== "string") return invalid("description", "must be a string");
    columns.push(["description", description]);
  }
  if (playbook !== undefined) {
    // Nothing to clear: the column is NOT NULL, so there is no "no profile" to write and null
    // is a non-member like any other. Absent still means "leave the column alone".
    if (!isPlaybook(playbook)) {
      return invalid("playbook", `must be one of: ${PLAYBOOKS.map((p) => p.slug).join(", ")}`);
    }
    columns.push(["playbook", playbook]);
  }
  if (taskBreakdown !== undefined) {
    if (!isChecklist(taskBreakdown)) {
      return invalid("taskBreakdown", "must be an array of { text: string, done: boolean }");
    }
    columns.push(["task_breakdown", JSON.stringify(taskBreakdown)]);
  }
  if (acceptanceCriteria !== undefined) {
    if (!isChecklist(acceptanceCriteria)) {
      return invalid("acceptanceCriteria", "must be an array of { text: string, done: boolean }");
    }
    columns.push(["acceptance_criteria", JSON.stringify(acceptanceCriteria)]);
  }
  if (columns.length === 0) {
    return invalid(
      "title",
      "nothing to update: provide title, description, playbook, taskBreakdown and/or acceptanceCriteria",
    );
  }

  writeColumns(id, columns);
  const ticket = getTicket(id);
  if (ticket === undefined) throw new Error(`ticket ${id} vanished during update`);
  return { ok: true, ticket };
}

export function deleteTicket(id: string): { ok: boolean } {
  return { ok: DELETE_TICKET.run(id).changes === 1 };
}

/** The lifecycle writer. Booleans are INTEGER 0/1 in SQLite, converted here. */
export function setRunFields(id: string, fields: RunFields): void {
  const columns: [string, SQLInputValue][] = [];
  if (fields.branch !== undefined) columns.push(["branch", fields.branch]);
  if (fields.agentName !== undefined) columns.push(["agent_name", fields.agentName]);
  if (fields.sessionDir !== undefined) columns.push(["session_dir", fields.sessionDir]);
  if (fields.startedAt !== undefined) columns.push(["started_at", fields.startedAt]);
  if (fields.finished !== undefined) columns.push(["finished", fields.finished ? 1 : 0]);
  if (fields.died !== undefined) columns.push(["died", fields.died ? 1 : 0]);
  writeColumns(id, columns);
}
