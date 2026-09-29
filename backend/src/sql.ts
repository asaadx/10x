/**
 * The board's one database client: a tiny async `Sql` interface with two drivers behind it.
 * Zero dependencies — `fetch` and `node:sqlite` are both built into Node 24, and that property
 * is a constraint rather than an accident (memory/architecture.md).
 *
 *  - **Turso** (hosted SQLite) when `TURSO_DATABASE_URL` is set. Spoken to over Hrana-over-HTTP,
 *    `POST <url>/v2/pipeline`, because that is also the only thing a cloud agent can reach: the
 *    board and every agent share one store, and neither ever calls the other
 *    (docs/prototype-cloud.md).
 *  - **Local** `node:sqlite` at `DB_PATH` otherwise — tests and offline dev only.
 *
 * Why async everywhere, even for the local driver: the interface has to be the shape of the
 * slowest driver, and a caller that works against one must work against the other unchanged.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Value = string | number | bigint | null | Uint8Array;
export type Row = Record<string, Value>;
export type Result = { rows: Row[]; rowsAffected: number; lastInsertRowid: number | null };
export type Stmt = { sql: string; args?: Value[] };

export interface Sql {
  execute(sql: string, args?: Value[]): Promise<Result>;
  /** Atomic: every statement commits, or none does. Results are in statement order. */
  batch(stmts: Stmt[]): Promise<Result[]>;
}

// ---------------------------------------------------------------------------
// Turso: Hrana over HTTP. https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md
// ---------------------------------------------------------------------------

type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

type HranaStmt = { sql: string; args: HranaValue[]; want_rows: boolean };

export type HranaCond =
  | { type: "ok"; step: number }
  | { type: "error"; step: number }
  | { type: "not"; cond: HranaCond }
  | { type: "and"; conds: HranaCond[] }
  | { type: "or"; conds: HranaCond[] };

type HranaStmtResult = {
  cols: { name: string | null }[];
  rows: HranaValue[][];
  affected_row_count: number;
  last_insert_rowid: string | null;
};

type HranaError = { message: string; code?: string | null };

type HranaResponse = {
  results: (
    | { type: "ok"; response: { type: string; result?: unknown } }
    | { type: "error"; error: HranaError }
  )[];
};

/**
 * Integers travel as decimal STRINGS: a 64-bit rowid does not survive a JSON number, so the
 * protocol refuses to pretend it does. A JS number that is not an integer is a float, and
 * Hrana sends those as plain JSON numbers.
 */
export function encodeValue(v: Value): HranaValue {
  if (v === null) return { type: "null" };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  }
  if (typeof v === "string") return { type: "text", value: v };
  return { type: "blob", base64: Buffer.from(v).toString("base64") };
}

/**
 * Integers decode to `number`, not `bigint`: every integer this board stores (counters, slots,
 * PR numbers, 0/1 flags) is far inside 2^53, and the local driver hands back numbers too — so
 * callers see one type whichever driver answered.
 */
export function decodeValue(v: HranaValue): Value {
  switch (v.type) {
    case "null":
      return null;
    case "integer":
      return Number(v.value);
    case "float":
      return v.value;
    case "text":
      return v.value;
    case "blob":
      return new Uint8Array(Buffer.from(v.base64, "base64"));
  }
}

const toResult = (r: HranaStmtResult): Result => ({
  rows: r.rows.map((cells) => {
    const row: Row = {};
    r.cols.forEach((col, i) => {
      const cell = cells[i];
      row[col.name ?? String(i)] = cell === undefined ? null : decodeValue(cell);
    });
    return row;
  }),
  rowsAffected: r.affected_row_count,
  lastInsertRowid: r.last_insert_rowid === null ? null : Number(r.last_insert_rowid),
});

const hranaStmt = (sql: string, args: Value[] = []): HranaStmt => ({
  sql,
  args: args.map(encodeValue),
  want_rows: true,
});

/** A database error carries SQLite's own message, so a UNIQUE violation reads the same on both drivers. */
const sqlError = (e: HranaError): Error =>
  new Error(e.code ? `${e.message} (${e.code})` : e.message);

export function tursoSql(databaseUrl: string, authToken: string | undefined): Sql {
  // `libsql://` is the scheme Turso's dashboard hands out; the HTTP API lives on the same host.
  const base = databaseUrl.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
  const endpoint = `${base}/v2/pipeline`;

  async function pipeline(requests: unknown[]): Promise<HranaResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authToken) headers["authorization"] = `Bearer ${authToken}`;
    // `close` always rides in the same request: no baton is kept, so every call is its own
    // stream and nothing can leak a half-open transaction between two calls.
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ baton: null, requests: [...requests, { type: "close" }] }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`turso ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as HranaResponse;
  }

  function first(response: HranaResponse): { type: string; result?: unknown } {
    const r = response.results[0];
    if (r === undefined) throw new Error("turso: empty pipeline response");
    if (r.type === "error") throw sqlError(r.error);
    return r.response;
  }

  return {
    async execute(sql, args) {
      const response = first(await pipeline([{ type: "execute", stmt: hranaStmt(sql, args) }]));
      return toResult(response.result as HranaStmtResult);
    },

    /*
     * ONE request, never BEGIN and COMMIT as separate calls: a statement that failed in the
     * middle would leave the others to commit on their own. Inside a single Hrana `batch` the
     * server evaluates each step's condition, so the chain below is the transaction:
     *
     *   0      BEGIN IMMEDIATE
     *   1..n   each statement, only if the previous step was ok
     *   n+1    COMMIT, only if the last statement was ok
     *   n+2    ROLLBACK, if COMMIT did not run ok (a failed or skipped step on the way)
     *
     * A skipped step is neither ok nor error, so "not ok(commit)" covers both a failed COMMIT
     * and one that never ran because something earlier failed.
     */
    async batch(stmts) {
      if (stmts.length === 0) return [];
      const steps: { stmt: HranaStmt; condition?: HranaCond }[] = [
        { stmt: hranaStmt("BEGIN IMMEDIATE") },
      ];
      stmts.forEach((s, i) => steps.push({ stmt: hranaStmt(s.sql, s.args), condition: { type: "ok", step: i } }));
      const commitIdx = steps.length;
      steps.push({ stmt: hranaStmt("COMMIT"), condition: { type: "ok", step: commitIdx - 1 } });
      steps.push({
        stmt: hranaStmt("ROLLBACK"),
        condition: { type: "not", cond: { type: "ok", step: commitIdx } },
      });

      const response = first(await pipeline([{ type: "batch", batch: { steps } }]));
      const result = response.result as {
        step_results: (HranaStmtResult | null)[];
        step_errors: (HranaError | null)[];
      };
      // The first error is the cause; later steps were skipped because of it.
      const err = result.step_errors.find((e) => e !== null && e !== undefined);
      if (err) throw sqlError(err);
      if (!result.step_results[commitIdx]) throw new Error("turso: batch did not commit");
      return stmts.map((_, i) => {
        const r = result.step_results[i + 1];
        if (!r) throw new Error(`turso: batch step ${i} has no result`);
        return toResult(r);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Local: node:sqlite. Also the engine behind scripts/fake-turso.ts.
// ---------------------------------------------------------------------------

/**
 * Run one statement on a `node:sqlite` handle and report it the way Hrana does.
 *
 * node:sqlite splits "returns rows" (`all`) from "reports changes" (`run`), and a
 * `… RETURNING` statement needs both. `columns()` says whether the statement produces rows;
 * for those, the change count is the `total_changes()` delta across the call, which is exact
 * for the statement itself and 0 for a plain SELECT — not the stale `changes()` a SELECT
 * would otherwise inherit from the last write.
 */
export function runLocal(db: DatabaseSync, sql: string, args: Value[] = []): Result {
  const stmt = db.prepare(sql);
  if (stmt.columns().length === 0) {
    const r = stmt.run(...args);
    return { rows: [], rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  const total = db.prepare("SELECT total_changes() AS n, last_insert_rowid() AS id");
  const before = Number(total.get()?.["n"]);
  const rows = stmt.all(...args).map((r) => ({ ...r }) as Row);
  const after = total.get();
  return {
    rows,
    rowsAffected: Number(after?.["n"]) - before,
    lastInsertRowid: Number(after?.["id"]),
  };
}

export function localSql(path: string): Sql {
  // Opened on first use, not at construction: importing db.ts must not touch the disk, so a
  // test can set DB_PATH after import and a module that never queries never opens anything.
  let handle: DatabaseSync | undefined;
  const open = (): DatabaseSync => {
    if (handle) return handle;
    mkdirSync(dirname(path), { recursive: true });
    handle = new DatabaseSync(path);
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA foreign_keys = ON");
    // A second process (the e2e server, a server child in a route test) writes the same
    // file; wait for its lock rather than failing a BEGIN IMMEDIATE outright.
    handle.exec("PRAGMA busy_timeout = 5000");
    return handle;
  };

  return {
    async execute(sql, args) {
      return runLocal(open(), sql, args);
    },
    // Synchronous inside: no `await` between BEGIN and COMMIT, so nothing else on this
    // connection can interleave a statement into the transaction.
    async batch(stmts) {
      const db = open();
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = stmts.map((s) => runLocal(db, s.sql, s.args));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/** The driver choice, in one place: Turso when configured, the local file otherwise. */
export function openSql(localPath: string): Sql {
  const url = process.env.TURSO_DATABASE_URL;
  if (url !== undefined && url.trim() !== "") return tursoSql(url.trim(), process.env.TURSO_AUTH_TOKEN);
  return localSql(localPath);
}
