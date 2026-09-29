/**
 * Tests for port-slot persistence: reserve, release, reuse, and the boot-time reclaim.
 *
 * The allocator itself is pure and tested in ports.test.ts. What is tested here is the part
 * that survives a restart — a slot the store forgot is a slot handed to two tickets at once.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "10x-port-slots-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
/** Two, so exhaustion is two tickets away instead of ten. Read at load, like DB_PATH. */
process.env.MAX_PORT_SLOTS = "2";

// db.ts opens the database at module load, so DB_PATH must already be set: the one place a
// dynamic import is required rather than preferred. A static import would hoist above the
// assignments above and open the real ~/.10x/10x.db.
const { db, initDb, nowIso, reclaimStalePortSlots, releasePortSlot, reservePortSlot } =
  await import("./db.ts");
await initDb();

// WAL leaves -wal and -shm siblings, so the whole temp directory goes, not just the file.
after(async () => {
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = "proj";
await db.execute(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  [PROJECT_ID, "Test", "/tmp/repo", "main", nowIso(), nowIso()],
);

const ANCIENT = "2020-01-01T00:00:00.000Z";
let nextNumber = 1;

/** Insert one ticket directly, bypassing every code path under test. */
async function seed(id: string, status = "in_progress"): Promise<string> {
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, description, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, PROJECT_ID, nextNumber++, `ticket ${id}`, "", status, ANCIENT, ANCIENT],
  );
  return id;
}

async function storedSlot(id: string): Promise<number | null> {
  const value = (await db.execute("SELECT port_slot FROM tickets WHERE id = ?", [id])).rows[0]?.["port_slot"];
  return typeof value === "number" ? value : null;
}

describe("reservePortSlot", () => {
  test("reserves the lowest free slot and persists it", async () => {
    const a = await seed("res-a");
    assert.deepEqual(await reservePortSlot(a), { ok: true, slot: 0 });
    assert.equal(await storedSlot(a), 0);

    const b = await seed("res-b");
    assert.deepEqual(await reservePortSlot(b), { ok: true, slot: 1 });
    assert.equal(await storedSlot(b), 1);
  });

  test("the ticket past the cap is refused, and holds nothing", async () => {
    const c = await seed("res-c");
    assert.deepEqual(await reservePortSlot(c), { ok: false, reason: "pool_exhausted", cap: 2 });
    assert.equal(await storedSlot(c), null);
  });

  test("a released slot goes to the next ticket that asks", async () => {
    await releasePortSlot("res-a");
    assert.equal(await storedSlot("res-a"), null);
    assert.deepEqual(await reservePortSlot("res-c"), { ok: true, slot: 0 });
    assert.equal(await storedSlot("res-c"), 0);
  });

  test("reserving twice returns the same slot instead of stranding the first", async () => {
    assert.deepEqual(await reservePortSlot("res-c"), { ok: true, slot: 0 });
    assert.equal(await storedSlot("res-c"), 0);
  });

  test("the UNIQUE index makes a double assignment impossible", async () => {
    // The safety is SQLite's, not the allocator's — the same way `claimTicket` leans on a
    // conditional UPDATE rather than on an in-process check.
    const d = await seed("res-d");
    await assert.rejects(async () => await db.execute("UPDATE tickets SET port_slot = 0 WHERE id = ?", [d]),
      /UNIQUE constraint failed/,
    );
  });

  test("releasing a ticket that holds nothing does not touch the row", async () => {
    const before = (await db.execute("SELECT updated_at FROM tickets WHERE id = ?", ["res-d"])).rows[0];
    await releasePortSlot("res-d");
    assert.deepEqual((await db.execute("SELECT updated_at FROM tickets WHERE id = ?", ["res-d"])).rows[0], before);
    assert.equal(before?.["updated_at"], ANCIENT);
  });
});

describe("reclaimStalePortSlots", () => {
  test("frees a slot dropped back to backlog, and leaves a running ticket's alone", async () => {
    // res-b still holds slot 1 from the reservation tests. Dropping it back to backlog
    // without releasing is exactly the residue a killed process leaves; res-c is genuinely
    // in progress on slot 0 and must survive.
    await db.execute("UPDATE tickets SET status = 'backlog' WHERE id = 'res-b'");

    assert.equal(await reclaimStalePortSlots(), 1);
    assert.equal(await storedSlot("res-b"), null);
    assert.equal(await storedSlot("res-c"), 0);
  });

  test("a ticket in review keeps its block; a backlog ticket loses its", async () => {
    // A ticket in review still owns its range — a Preview started there binds it — so the
    // reclaim has to spare it exactly as it spares a running agent. Both slots are freed
    // first so this test owns both sides of the predicate rather than inheriting them.
    await releasePortSlot("res-c");
    const review = await seed("res-review", "in_review");
    const backlog = await seed("res-backlog", "backlog");
    assert.deepEqual(await reservePortSlot(review), { ok: true, slot: 0 });
    assert.deepEqual(await reservePortSlot(backlog), { ok: true, slot: 1 });

    assert.equal(await reclaimStalePortSlots(), 1);
    assert.equal(await storedSlot(review), 0);
    assert.equal(await storedSlot(backlog), null);
  });

  test("a boot with nothing stale reclaims nothing", async () => {
    assert.equal(await reclaimStalePortSlots(), 0);
  });
});
