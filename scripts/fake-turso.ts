/**
 * A fake Turso: just enough Hrana-over-HTTP (`POST /v2/pipeline`) on top of `node:sqlite` to
 * run the board's Turso driver end to end with no network — in `sql.test.ts`, and by hand so
 * the board can be pointed at "Turso" locally. NOT a production path, and not a complete
 * Hrana server: `execute`, `batch` (conditions ok / error / not / and / or) and `close`, one
 * stream per request, no batons.
 *
 *   node scripts/fake-turso.ts --port 8080 --db ./x.db
 *   TURSO_DATABASE_URL=http://127.0.0.1:8080 node backend/src/server.ts
 *
 * Every request is answered synchronously against one connection, so two pipelines can never
 * interleave inside a transaction — the same isolation a real server gives each stream.
 */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import {
  decodeValue,
  encodeValue,
  runLocal,
  type HranaCond,
  type Result,
  type Value,
} from "../backend/src/sql.ts";

type WireStmt = { sql: string; args?: Parameters<typeof decodeValue>[0][] };
type WireRequest =
  | { type: "execute"; stmt: WireStmt }
  | { type: "batch"; batch: { steps: { stmt: WireStmt; condition?: HranaCond | null }[] } }
  | { type: "close" };

const wireResult = (r: Result) => {
  const cols = r.rows[0] ? Object.keys(r.rows[0]).map((name) => ({ name, decltype: null })) : [];
  return {
    cols,
    rows: r.rows.map((row) => cols.map((c) => encodeValue(row[c.name] ?? null))),
    affected_row_count: r.rowsAffected,
    last_insert_rowid: r.lastInsertRowid === null ? null : String(r.lastInsertRowid),
    replication_index: null,
  };
};

const wireError = (err: unknown) => ({ message: err instanceof Error ? err.message : String(err), code: "SQLITE_ERROR" });

function run(db: DatabaseSync, stmt: WireStmt): Result {
  const args: Value[] = (stmt.args ?? []).map(decodeValue);
  return runLocal(db, stmt.sql, args);
}

function evaluate(cond: HranaCond, ok: (boolean | undefined)[]): boolean {
  switch (cond.type) {
    // A skipped step is `undefined`: neither ok nor error, exactly as Hrana defines it.
    case "ok":
      return ok[cond.step] === true;
    case "error":
      return ok[cond.step] === false;
    case "not":
      return !evaluate(cond.cond, ok);
    case "and":
      return cond.conds.every((c) => evaluate(c, ok));
    case "or":
      return cond.conds.some((c) => evaluate(c, ok));
  }
}

function handle(db: DatabaseSync, req: WireRequest): unknown {
  if (req.type === "close") return { type: "ok", response: { type: "close" } };
  if (req.type === "execute") {
    try {
      return { type: "ok", response: { type: "execute", result: wireResult(run(db, req.stmt)) } };
    } catch (err) {
      return { type: "error", error: wireError(err) };
    }
  }
  if (req.type === "batch") {
    const ok: (boolean | undefined)[] = [];
    const stepResults: unknown[] = [];
    const stepErrors: unknown[] = [];
    req.batch.steps.forEach((step, i) => {
      stepResults[i] = null;
      stepErrors[i] = null;
      if (step.condition && !evaluate(step.condition, ok)) return; // skipped
      try {
        stepResults[i] = wireResult(run(db, step.stmt));
        ok[i] = true;
      } catch (err) {
        stepErrors[i] = wireError(err);
        ok[i] = false;
      }
    });
    return { type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors } } };
  }
  return { type: "error", error: { message: `unsupported request type`, code: "UNSUPPORTED" } };
}

export function startFakeTurso(opts: { port?: number; dbPath: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const db = new DatabaseSync(opts.dbPath);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v2/pipeline") {
        res.writeHead(404).end("not found");
        return;
      }
      let body: { requests?: WireRequest[] };
      try {
        body = JSON.parse(raw) as { requests?: WireRequest[] };
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const results = (body.requests ?? []).map((r) => handle(db, r));
      // A request that closed its stream left no transaction behind; roll back one that did
      // not, so a crashed client cannot wedge the database for the next request.
      if (db.isTransaction) db.exec("ROLLBACK");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  const { promise, resolve } = Promise.withResolvers<{ url: string; close: () => Promise<void> }>();
  server.listen(opts.port ?? 0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    resolve({
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((done) =>
          server.close(() => {
            db.close();
            done();
          }),
        ),
    });
  });
  return promise;
}

if (import.meta.main) {
  const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const { url } = await startFakeTurso({ port: Number(flag("--port") ?? 8080), dbPath: flag("--db") ?? ":memory:" });
  console.log(`fake turso → ${url}`);
}
