/**
 * Ticket persistence, plus the route-handler bodies for `/tickets`.
 *
 * Two invariants this file exists to hold.
 *
 *  1. `number` is per-project and starts at 1, and it is half of the `UNIQUE(project_id,
 *     number)` key that every branch and agent name is derived from (`branchFor` /
 *     `agentNameFor`). A plain read-then-insert lets two concurrent creates read the same
 *     MAX and one of them dies on the constraint, so the counter advance and the insert are
 *     one atomic `batch`, and the insert reads the number back through a subquery rather than
 *     from a JS variable — over HTTP there is no connection to hold a transaction open on.
 *
 *  2. Editing a ticket touches exactly five fields — `title`, `description`, `playbook`,
 *     `taskBreakdown` and `acceptanceCriteria` — and nothing else. `status`, `branch`,
 *     `agent_name`, `session_dir`, `started_at`, `finished` and `died` belong to the
 *     spawn/teardown lifecycle — status in particular IS the concurrency lock
 *     (memory/operations.md), so a PATCH that quietly reassigned it would
 *     walk the board straight past the compare-and-swap that stops a double spawn.
 *     A PATCH naming any of them is a 400; the lifecycle writes through `setRunFields`.
 *
 *     `attachments` and the screenshot pair are absent from that list on purpose: they are
 *     written by an upload path, not by an edit, so a PATCH cannot forge a stored file.
 */
import { db, nowIso, toTicket } from "./db.ts";
import type { Row, Value } from "./sql.ts";
import {
  PLAYBOOKS,
  PRIORITIES,
  type Attachment,
  type ChecklistItem,
  type Playbook,
  type Priority,
  type Ticket,
  type AgentState,
  type SessionKind,
} from "./types.ts";

/** `{ error: "<code>", ...context }` — the uniform error envelope the whole API uses. */
export type ErrorBody = { error: string; field?: string; message?: string; [key: string]: unknown };

export type TicketResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; status: number; body: ErrorBody };

/** Written only by the lifecycle routes. `null` clears; absent leaves the column alone. */
export type RunFields = {
  /** The cloud session the board started (server.ts spawn / plan). */
  sessionId?: string | null;
  sessionUrl?: string | null;
  sessionKind?: SessionKind | null;
  /** The board writes `starting` and clears; every other value is the agent's own write. */
  agentState?: AgentState | null;
  agentNote?: string | null;
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
// Row decoding. The `Sql` client hands back Record<string, Value>, so this is the parse
// boundary where dynamic column values become the typed row `toTicket` wants.
// ---------------------------------------------------------------------------

const bad = (column: string, value: Value | undefined): never => {
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
    archived: int(row, "archived"),
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
    priority: text(row, "priority"),
    task_breakdown: jsonList<ChecklistItem>(row, "task_breakdown"),
    acceptance_criteria: jsonList<ChecklistItem>(row, "acceptance_criteria"),
    attachments: jsonList<Attachment>(row, "attachments"),
    screenshot_before: maybeText(row, "screenshot_before"),
    screenshot_after: maybeText(row, "screenshot_after"),
    started_at: maybeText(row, "started_at"),
    session_id: maybeText(row, "session_id"),
    session_url: maybeText(row, "session_url"),
    session_kind: maybeText(row, "session_kind"),
    agent_state: maybeText(row, "agent_state"),
    agent_note: maybeText(row, "agent_note"),
    agent_updated_at: maybeText(row, "agent_updated_at"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  });

// ---------------------------------------------------------------------------
// Statements. Plain strings: the `Sql` client has no prepared-statement handle to cache,
// and the schema is applied by `initDb()`, never at import.
// ---------------------------------------------------------------------------

const SELECT_ALL = "SELECT * FROM tickets WHERE archived = 0 ORDER BY project_id, number";
const SELECT_BY_PROJECT =
  "SELECT * FROM tickets WHERE archived = 0 AND project_id = ? ORDER BY project_id, number";
const SELECT_ONE = "SELECT * FROM tickets WHERE id = ?";
/**
 * Claim the next ticket number by ADVANCING the project's counter, never by reading
 * MAX(number). Deleting the highest ticket would otherwise recycle its number, and since
 * deleting a ticket deliberately leaves its worktree in place (memory/teardown.md), the new ticket's
 * branch would collide with the orphan still on disk — inheriting another ticket's work.
 */
const ADVANCE_NUMBER = "UPDATE projects SET next_number = next_number + 1 WHERE id = ?";
/**
 * The insert that pairs with ADVANCE_NUMBER inside one batch. It reads the number it just
 * claimed back out of the counter (`next_number - 1`) instead of taking it as an argument,
 * so the two statements need nothing from each other's results and can travel in a single
 * Hrana request. `INSERT … SELECT … FROM projects` also makes "no such project" a zero-row
 * insert rather than a foreign-key error, which is how `createTicket` tells a 404 apart.
 */
const INSERT_TICKET = `
  INSERT INTO tickets (id, project_id, number, title, description, status,
                       finished, died, branch, agent_name, session_dir,
                       created_at, updated_at)
  SELECT id || '-' || (next_number - 1), id, next_number - 1, ?, ?, 'backlog',
         0, 0, NULL, NULL, NULL, ?, ?
  FROM projects WHERE id = ?
  RETURNING id`;

/**
 * Shared writer for both mutation paths. Column names are literals from this file, never
 * request data, so interpolating them is safe; the values are always bound.
 *
 * `updated_at` is appended unconditionally, which is also why an empty-fields
 * `setRunFields` still touches the row.
 */
async function writeColumns(id: string, columns: [string, Value][]): Promise<void> {
  const assignments = columns.map(([column]) => `${column} = ?`).join(", ");
  const values = columns.map(([, value]) => value);
  values.push(nowIso(), id);
  const sql = `UPDATE tickets SET ${assignments}${assignments ? ", " : ""}updated_at = ? WHERE id = ?`;
  await db.execute(sql, values);
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
  priority?: unknown;
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
 * only list of playbook values in the codebase, so this guard cannot fall behind the union
 * it narrows to, and the error message can name the allowed values without repeating them.
 */
const isPlaybook = (value: unknown): value is Playbook =>
  PLAYBOOKS.some((playbook) => playbook === value);

/**
 * The same asymmetry again, for priority: `PRIORITIES` is the only list of priority values in
 * the codebase, so this guard cannot fall behind the union it narrows to either.
 */
const isPriority = (value: unknown): value is Priority =>
  PRIORITIES.some((priority) => priority === value);

/** Owned by the lifecycle, so naming one in a PATCH is a mistake worth reporting. */
const IMMUTABLE = [
  "status",
  "number",
  "projectId",
  "branch",
  "agentName",
  "finished",
  "died",
  "archived",
  "sessionDir",
  // The cloud session and the agent's own report: the board and the agent write these into
  // the row directly (docs/prototype-cloud.md), and an edit that forged `agentState: "done"`
  // would move the ticket to review through the poller with no agent behind it.
  "sessionId",
  "sessionUrl",
  "sessionKind",
  "agentState",
  "agentNote",
  "agentUpdatedAt",
] as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listTickets(projectId?: string): Promise<Ticket[]> {
  const { rows } =
    projectId === undefined ? await db.execute(SELECT_ALL) : await db.execute(SELECT_BY_PROJECT, [projectId]);
  return rows.map(decode);
}

/**
 * Every ticket id a project owns, archived included — the one read that deliberately ignores
 * the `archived = 0` filter every other list applies. Deleting a project has to sweep files
 * keyed by ticket id (screenshots), and an archived ticket's files are still on disk even
 * though its card is gone for good.
 */
export async function listProjectTicketIds(projectId: string): Promise<string[]> {
  const { rows } = await db.execute("SELECT id FROM tickets WHERE project_id = ?", [projectId]);
  return rows.map((row) => String(row["id"]));
}

export async function getTicket(id: string): Promise<Ticket | undefined> {
  const { rows } = await db.execute(SELECT_ONE, [id]);
  const row = rows[0];
  return row === undefined ? undefined : decode(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createTicket(input: unknown): Promise<TicketResult> {
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

  // One timestamp, both columns: "never edited" then reads as createdAt === updatedAt.
  const ts = nowIso();
  // Atomic: the counter only advances if the insert lands, and two concurrent creates cannot
  // claim the same number because each batch is one write transaction.
  const [, inserted] = await db.batch([
    { sql: ADVANCE_NUMBER, args: [projectId] },
    { sql: INSERT_TICKET, args: [title.trim(), description ?? "", ts, ts, projectId] },
  ]);
  const id = inserted?.rows[0]?.["id"];
  // No project row means both statements matched nothing: nothing advanced, nothing inserted.
  if (typeof id !== "string") {
    return { ok: false, status: 404, body: { error: "no_such_project", projectId } };
  }

  const ticket = await getTicket(id);
  if (ticket === undefined) throw new Error(`ticket ${id} vanished after insert`);
  return { ok: true, ticket };
}

export async function updateTicket(id: string, input: unknown): Promise<TicketResult> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return notAnObject;

  const existing = await getTicket(id);
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

  const { title, description, playbook, priority, taskBreakdown, acceptanceCriteria }: TicketInput = input;
  const columns: [string, Value][] = [];
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
      return invalid("playbook", `must be one of: ${PLAYBOOKS.join(", ")}`);
    }
    columns.push(["playbook", playbook]);
  }
  if (priority !== undefined) {
    // Same asymmetry as playbook: the column is NOT NULL, so there is nothing to clear, and
    // absent still means "leave the column alone".
    if (!isPriority(priority)) {
      return invalid("priority", `must be one of: ${PRIORITIES.join(", ")}`);
    }
    columns.push(["priority", priority]);
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
      "nothing to update: provide title, description, playbook, priority, taskBreakdown and/or acceptanceCriteria",
    );
  }

  await writeColumns(id, columns);
  const ticket = await getTicket(id);
  if (ticket === undefined) throw new Error(`ticket ${id} vanished during update`);
  return { ok: true, ticket };
}

export async function deleteTicket(id: string): Promise<{ ok: boolean }> {
  const res = await db.execute("DELETE FROM tickets WHERE id = ?", [id]);
  return { ok: res.rowsAffected === 1 };
}

/** The lifecycle writer. Booleans are INTEGER 0/1 in SQLite, converted here. */
export async function setRunFields(id: string, fields: RunFields): Promise<void> {
  const columns: [string, Value][] = [];
  if (fields.branch !== undefined) columns.push(["branch", fields.branch]);
  if (fields.agentName !== undefined) columns.push(["agent_name", fields.agentName]);
  if (fields.sessionDir !== undefined) columns.push(["session_dir", fields.sessionDir]);
  if (fields.startedAt !== undefined) columns.push(["started_at", fields.startedAt]);
  if (fields.finished !== undefined) columns.push(["finished", fields.finished ? 1 : 0]);
  if (fields.died !== undefined) columns.push(["died", fields.died ? 1 : 0]);
  if (fields.sessionId !== undefined) columns.push(["session_id", fields.sessionId]);
  if (fields.sessionUrl !== undefined) columns.push(["session_url", fields.sessionUrl]);
  if (fields.sessionKind !== undefined) columns.push(["session_kind", fields.sessionKind]);
  if (fields.agentState !== undefined) columns.push(["agent_state", fields.agentState]);
  if (fields.agentNote !== undefined) columns.push(["agent_note", fields.agentNote]);
  await writeColumns(id, columns);
}

/** One-way: there is no unset. Archiving hides a ticket from every board read for good. */
export async function archiveTicket(id: string): Promise<void> {
  await db.execute("UPDATE tickets SET archived = 1, updated_at = ? WHERE id = ?", [nowIso(), id]);
}
