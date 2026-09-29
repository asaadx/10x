/**
 * The `Sql` contract, run against BOTH drivers: the local `node:sqlite` one, and the Turso one
 * talking real Hrana-over-HTTP to scripts/fake-turso.ts. Whatever the board relies on — batch
 * atomicity above all, then the CAS row count, integer round-trips and RETURNING — has to
 * hold identically on both, or the tests (local) would prove nothing about production (Turso).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeValue, localSql, tursoSql, type Sql } from "./sql.ts";
import { startFakeTurso } from "../../scripts/fake-turso.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-sql-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function contract(name: string, open: () => Promise<{ sql: Sql; close: () => Promise<void> }>): void {
  describe(`Sql contract: ${name}`, () => {
    let sql: Sql;
    let close: () => Promise<void> = async () => {};

    before(async () => {
      ({ sql, close } = await open());
      await sql.execute(
        "CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, f REAL, s TEXT, b BLOB, status TEXT)",
      );
    });
    after(() => close());

    test("integers, floats, text, null and blobs round-trip with their types", async () => {
      await sql.execute("INSERT INTO t (id, n, f, s, b) VALUES (?, ?, ?, ?, ?)", [
        "types",
        9_007_199_254_740_991, // 2^53 - 1: the largest integer a number carries exactly
        1.5,
        "héllo",
        new Uint8Array([0, 1, 255]),
      ]);
      const { rows } = await sql.execute("SELECT n, f, s, b, status FROM t WHERE id = ?", ["types"]);
      const row = rows[0];
      assert.equal(row?.["n"], 9_007_199_254_740_991);
      assert.equal(typeof row?.["n"], "number");
      assert.equal(row?.["f"], 1.5);
      assert.equal(row?.["s"], "héllo");
      assert.deepEqual([...((row?.["b"] as Uint8Array | undefined) ?? [])], [0, 1, 255]);
      assert.equal(row?.["status"], null);
    });

    test("a bigint argument is accepted and decodes back to a number", async () => {
      await sql.execute("INSERT INTO t (id, n) VALUES (?, ?)", ["big", 42n]);
      const { rows } = await sql.execute("SELECT n FROM t WHERE id = 'big'");
      assert.equal(rows[0]?.["n"], 42);
    });

    test("rowsAffected is the CAS verdict: 1 for the winner, 0 for the loser", async () => {
      await sql.execute("INSERT INTO t (id, n, status) VALUES ('cas', 0, 'todo')");
      const cas = "UPDATE t SET status = ? WHERE id = ? AND status = ?";
      const first = await sql.execute(cas, ["in_progress", "cas", "todo"]);
      const second = await sql.execute(cas, ["in_progress", "cas", "todo"]);
      assert.equal(first.rowsAffected, 1);
      assert.equal(second.rowsAffected, 0);
    });

    test("a plain SELECT reports no rows affected, whatever the last write was", async () => {
      await sql.execute("UPDATE t SET n = n WHERE id = 'cas'");
      const { rowsAffected } = await sql.execute("SELECT * FROM t");
      assert.equal(rowsAffected, 0);
    });

    test("RETURNING yields rows AND the affected count", async () => {
      await sql.execute("INSERT INTO t (id, n) VALUES ('ret', 7)");
      const res = await sql.execute("UPDATE t SET n = n + 1 WHERE id = ? RETURNING n - 1 AS before", ["ret"]);
      assert.deepEqual(res.rows, [{ before: 7 }]);
      assert.equal(res.rowsAffected, 1);
    });

    test("an INSERT reports its rowid", async () => {
      const res = await sql.execute("INSERT INTO t (id, n) VALUES ('rowid', 1)");
      assert.equal(typeof res.lastInsertRowid, "number");
      const { rows } = await sql.execute("SELECT rowid AS r FROM t WHERE id = 'rowid'");
      assert.equal(res.lastInsertRowid, rows[0]?.["r"]);
    });

    test("a SQL error throws with SQLite's own message", async () => {
      await assert.rejects(sql.execute("INSERT INTO t (id, n) VALUES ('ret', 1)"), /UNIQUE constraint failed/);
      await assert.rejects(sql.execute("SELECT nope FROM t"), /no such column/);
    });

    test("batch returns every statement's result, in order, and commits them all", async () => {
      const results = await sql.batch([
        { sql: "INSERT INTO t (id, n) VALUES (?, ?)", args: ["b1", 1] },
        { sql: "INSERT INTO t (id, n) VALUES (?, ?)", args: ["b2", 2] },
        // A later statement reads what an earlier one wrote: one transaction, not three.
        { sql: "SELECT SUM(n) AS total FROM t WHERE id IN ('b1', 'b2')" },
      ]);
      assert.equal(results.length, 3);
      assert.equal(results[0]?.rowsAffected, 1);
      assert.deepEqual(results[2]?.rows, [{ total: 3 }]);
    });

    test("batch is atomic: a failing middle statement leaves NOTHING written", async () => {
      await assert.rejects(
        sql.batch([
          { sql: "INSERT INTO t (id, n) VALUES ('a1', 1)" },
          { sql: "INSERT INTO t (id, n) VALUES ('b1', 1)" }, // duplicate key from the test above
          { sql: "INSERT INTO t (id, n) VALUES ('a3', 3)" },
        ]),
        /UNIQUE constraint failed/,
      );
      const { rows } = await sql.execute("SELECT id FROM t WHERE id IN ('a1', 'a3')");
      assert.deepEqual(rows, []);
    });

    test("the connection is usable after a failed batch — no transaction left open", async () => {
      await sql.execute("INSERT INTO t (id, n) VALUES ('after', 1)");
      const results = await sql.batch([{ sql: "UPDATE t SET n = 2 WHERE id = 'after'" }]);
      assert.equal(results[0]?.rowsAffected, 1);
    });

    test("an empty batch is a no-op", async () => {
      assert.deepEqual(await sql.batch([]), []);
    });
  });
}

contract("local node:sqlite", async () => ({
  sql: localSql(join(dir, "local.db")),
  close: async () => {},
}));

contract("turso driver over fake-turso", async () => {
  const fake = await startFakeTurso({ dbPath: join(dir, "turso.db") });
  // The libsql:// scheme Turso hands out is rewritten to https, so the fake is addressed by
  // its http URL directly; the rewrite itself is pinned below.
  return { sql: tursoSql(fake.url, "test-token"), close: fake.close };
});

describe("Turso wire encoding", () => {
  test("integers go over the wire as strings, floats as numbers", () => {
    assert.deepEqual(encodeValue(1), { type: "integer", value: "1" });
    assert.deepEqual(encodeValue(12345678901234567890n), { type: "integer", value: "12345678901234567890" });
    assert.deepEqual(encodeValue(0.25), { type: "float", value: 0.25 });
    assert.deepEqual(encodeValue(null), { type: "null" });
    assert.deepEqual(encodeValue(new Uint8Array([1, 2])), { type: "blob", base64: "AQI=" });
  });

  test("libsql:// is rewritten to https:// and the bearer token is sent", async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          results: [
            {
              type: "ok",
              response: {
                type: "execute",
                result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null },
              },
            },
            { type: "ok", response: { type: "close" } },
          ],
        }),
      );
    }) as typeof fetch;
    try {
      await tursoSql("libsql://db-org.turso.io", "tok").execute("SELECT 1");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(seen[0]?.url, "https://db-org.turso.io/v2/pipeline");
    assert.equal(seen[0]?.auth, "Bearer tok");
    // `close` rides in the same request: no baton is ever kept between calls.
    assert.deepEqual(
      (seen[0]?.body as { requests: { type: string }[] }).requests.map((r) => r.type),
      ["execute", "close"],
    );
  });

  test("a batch is ONE request: BEGIN, chained conditions, COMMIT, and ROLLBACK on not-ok(COMMIT)", async () => {
    let body: { requests: { type: string; batch?: { steps: { stmt: { sql: string }; condition?: unknown }[] } }[] } | undefined;
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      body = JSON.parse(String(init?.body));
      const ok = { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };
      return new Response(
        JSON.stringify({
          results: [
            {
              type: "ok",
              response: { type: "batch", result: { step_results: [ok, ok, ok, ok, null], step_errors: [null, null, null, null, null] } },
            },
            { type: "ok", response: { type: "close" } },
          ],
        }),
      );
    }) as typeof fetch;
    try {
      await tursoSql("https://x", undefined).batch([{ sql: "S1" }, { sql: "S2" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 1);
    const steps = body?.requests[0]?.batch?.steps ?? [];
    assert.deepEqual(
      steps.map((s) => [s.stmt.sql, s.condition ?? null]),
      [
        ["BEGIN IMMEDIATE", null],
        ["S1", { type: "ok", step: 0 }],
        ["S2", { type: "ok", step: 1 }],
        ["COMMIT", { type: "ok", step: 2 }],
        ["ROLLBACK", { type: "not", cond: { type: "ok", step: 3 } }],
      ],
    );
  });
});
