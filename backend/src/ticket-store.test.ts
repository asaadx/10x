/**
 * Tests for the ticket write and decode paths: `setRunFields`, the lifecycle writer used by
 * spawn, teardown and reject to flip `finished`/`died` without touching the fields a plain
 * `updateTicket` owns, and the plan fields (`playbook` plus the two checklists) that
 * `updateTicket` does own.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so these are erased and load nothing before DB_PATH is set below.
import type { ErrorBody } from "./ticket-store.ts";
import type { Ticket } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-ticket-store-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts opens the database at module load, so DB_PATH must already be set — same reason
// db.test.ts uses a dynamic import.
const { db, initDb, nowIso } = await import("./db.ts");
await initDb();
const { setRunFields, updateTicket, getTicket } = await import("./ticket-store.ts");

after(async () => {
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = "proj";
await db.execute(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  [PROJECT_ID, "Test", "/tmp/repo", "main", nowIso(), nowIso()],
);

let nextNumber = 1;

async function seed(id: string, finished: number, died: number): Promise<void> {
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, description, status, finished, died, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)",
    [id, PROJECT_ID, nextNumber++, `ticket ${id}`, "", finished, died, nowIso(), nowIso()],
  );
}

async function readFlags(id: string): Promise<{ finished: number; died: number }> {
  const row = (await db.execute("SELECT finished, died FROM tickets WHERE id = ?", [id])).rows[0] as
    | { finished: number; died: number }
    | undefined;
  if (!row) assert.fail(`no row for ticket ${id}`);
  return row;
}

async function loaded(id: string): Promise<Ticket> {
  const ticket = await getTicket(id);
  if (ticket === undefined) assert.fail(`no ticket ${id}`);
  return ticket;
}

/** Asserts a rejection and hands back the envelope, so each caller checks only its field. */
async function rejected(id: string, patch: object): Promise<ErrorBody> {
  const result = await updateTicket(id, patch);
  if (result.ok) assert.fail(`expected ${JSON.stringify(patch)} to be rejected`);
  assert.equal(result.status, 400);
  return result.body;
}

describe("setRunFields", () => {
  test("clearing finished leaves died untouched", async () => {
    await seed("t-clear-finished", 1, 1);
    await setRunFields("t-clear-finished", { finished: false });
    const flags = await readFlags("t-clear-finished");
    assert.equal(flags.finished, 0);
    assert.equal(flags.died, 1);
  });

  test("an absent field is left alone entirely, not just re-written with its old value", async () => {
    await seed("t-absent", 1, 0);
    await setRunFields("t-absent", { finished: false });
    const flags = await readFlags("t-absent");
    assert.equal(flags.finished, 0);
    assert.equal(flags.died, 0);
  });
});

describe("plan column decoding", () => {
  test("a row inserted with only the original columns decodes to the plan-field defaults", async () => {
    await seed("t-decode-defaults", 0, 0);
    const ticket = await loaded("t-decode-defaults");
    // Not null: the column is NOT NULL DEFAULT 'Fullstack', so a row created without a
    // playbook still has one, which is what the type promises every consumer.
    assert.equal(ticket.playbook, "Fullstack");
    // Same guarantee for priority: the column is NOT NULL DEFAULT 'low', so a ticket
    // created (or migrated) with no priority ever named still reads as the lowest one.
    assert.equal(ticket.priority, "low");
    assert.deepEqual(ticket.taskBreakdown, []);
    assert.deepEqual(ticket.acceptanceCriteria, []);
    assert.deepEqual(ticket.attachments, []);
    assert.deepEqual(ticket.screenshots, { before: null, after: null });
    assert.equal(ticket.startedAt, null);
  });

  test("the screenshot pair decodes each side independently", async () => {
    await seed("t-decode-shots", 0, 0);
    await db.execute("UPDATE tickets SET screenshot_before = ? WHERE id = ?", ["/shots/before.png", "t-decode-shots"]);
    assert.deepEqual((await loaded("t-decode-shots")).screenshots, {
      before: "/shots/before.png",
      after: null,
    });
  });

  // Cloud agents write these columns over Turso (prompts/*.md), so one malformed write must not
  // throw every board read: the unusable part decodes as empty rather than failing loudly.
  test("a corrupt checklist column decodes to empty instead of throwing the board read", async () => {
    await seed("t-decode-corrupt", 0, 0);
    await db.execute("UPDATE tickets SET task_breakdown = ? WHERE id = ?", ["[{not json", "t-decode-corrupt"]);
    assert.deepEqual((await getTicket("t-decode-corrupt"))?.taskBreakdown, []);
  });

  test("a checklist column holding valid JSON that is not an array also decodes to empty", async () => {
    await seed("t-decode-object", 0, 0);
    await db.execute("UPDATE tickets SET acceptance_criteria = ? WHERE id = ?", ['{"text":"one","done":false}', "t-decode-object"]);
    assert.deepEqual((await getTicket("t-decode-object"))?.acceptanceCriteria, []);
  });
});

describe("updateTicket plan fields", () => {
  test("playbook and both checklists round-trip with item order and done flags intact", async () => {
    await seed("t-round-trip", 0, 0);
    const taskBreakdown = [
      { text: "read the schema", done: true },
      { text: "write the decode test", done: false },
      { text: "run the suite", done: true },
    ];
    const acceptanceCriteria = [
      { text: "suite passes", done: false },
      { text: "no implementation changed", done: true },
    ];
    const result = await updateTicket("t-round-trip", {
      playbook: "Frontend",
      taskBreakdown,
      acceptanceCriteria,
    });
    if (!result.ok) assert.fail(`update rejected: ${JSON.stringify(result.body)}`);
    assert.equal(result.ticket.playbook, "Frontend");
    assert.deepEqual(result.ticket.taskBreakdown, taskBreakdown);
    assert.deepEqual(result.ticket.acceptanceCriteria, acceptanceCriteria);

    // Re-read rather than trusting the value the writer returned: the point is what SQLite kept.
    const reread = await loaded("t-round-trip");
    assert.deepEqual(reread.taskBreakdown, taskBreakdown);
    assert.deepEqual(reread.acceptanceCriteria, acceptanceCriteria);
    assert.deepEqual(
      reread.taskBreakdown.map((item) => item.text),
      ["read the schema", "write the decode test", "run the suite"],
    );
  });

  test("an unrecognised playbook is rejected, naming the field and writing nothing", async () => {
    await seed("t-playbook-unknown", 0, 0);
    await updateTicket("t-playbook-unknown", { playbook: "Backend" });
    assert.equal((await loaded("t-playbook-unknown")).playbook, "Backend");

    // Lowercase "frontend" is the near-miss worth rejecting: it is exactly what this branch
    // used to store, and the stored value is now the displayed name, case and all.
    const body = await rejected("t-playbook-unknown", { playbook: "frontend" });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "playbook");
    // The frontend shows this message, so it has to name what is allowed.
    assert.match(String(body.message), /Fullstack/);
    // Rejected means nothing was written: the value that was there survives.
    assert.equal((await loaded("t-playbook-unknown")).playbook, "Backend");
  });

  test("null is rejected too — a NOT NULL column has nothing to clear", async () => {
    await seed("t-playbook-null", 0, 0);
    await updateTicket("t-playbook-null", { playbook: "DevOps" });

    const body = await rejected("t-playbook-null", { playbook: null });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "playbook");
    assert.equal((await loaded("t-playbook-null")).playbook, "DevOps");
  });

  test("a playbook that is not a string at all is rejected the same way", async () => {
    await seed("t-playbook-nonstring", 0, 0);
    const body = await rejected("t-playbook-nonstring", { playbook: 3 });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "playbook");
    assert.equal((await loaded("t-playbook-nonstring")).playbook, "Fullstack");
  });

  test("a checklist that is not an array is rejected, naming that checklist", async () => {
    await seed("t-reject-scalar", 0, 0);
    const body = await rejected("t-reject-scalar", { taskBreakdown: "first thing, second thing" });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "taskBreakdown");
    // Rejected means nothing was written, not written-then-complained-about.
    assert.deepEqual((await loaded("t-reject-scalar")).taskBreakdown, []);
  });

  test("a checklist array containing a non-object is rejected, naming that checklist", async () => {
    await seed("t-reject-nonobject", 0, 0);
    const body = await rejected("t-reject-nonobject", {
      acceptanceCriteria: [{ text: "fine", done: false }, "not an item"],
    });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "acceptanceCriteria");
  });

  test("a checklist item missing text is rejected, naming that checklist", async () => {
    await seed("t-reject-no-text", 0, 0);
    const body = await rejected("t-reject-no-text", { taskBreakdown: [{ done: true }] });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "taskBreakdown");
  });

  test("a checklist item whose done is not a boolean is rejected, naming that checklist", async () => {
    await seed("t-reject-done", 0, 0);
    const body = await rejected("t-reject-done", {
      acceptanceCriteria: [{ text: "ship it", done: "yes" }],
    });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "acceptanceCriteria");
  });
});

describe("updateTicket priority", () => {
  test("priority round-trips through a PATCH the same way playbook does", async () => {
    await seed("t-priority-round-trip", 0, 0);
    const result = await updateTicket("t-priority-round-trip", { priority: "high" });
    if (!result.ok) assert.fail(`update rejected: ${JSON.stringify(result.body)}`);
    assert.equal(result.ticket.priority, "high");
    assert.equal((await loaded("t-priority-round-trip")).priority, "high");
  });

  test("an unrecognised priority is rejected, naming the field and writing nothing", async () => {
    await seed("t-priority-unknown", 0, 0);
    await updateTicket("t-priority-unknown", { priority: "medium" });
    assert.equal((await loaded("t-priority-unknown")).priority, "medium");

    const body = await rejected("t-priority-unknown", { priority: "urgent" });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "priority");
    // The frontend shows this message, so it has to name what is allowed.
    assert.match(String(body.message), /low, medium, high/);
    // Rejected means nothing was written: the value that was there survives.
    assert.equal((await loaded("t-priority-unknown")).priority, "medium");
  });

  test("null is rejected too — a NOT NULL column has nothing to clear", async () => {
    await seed("t-priority-null", 0, 0);
    await updateTicket("t-priority-null", { priority: "high" });

    const body = await rejected("t-priority-null", { priority: null });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "priority");
    assert.equal((await loaded("t-priority-null")).priority, "high");
  });

  test("a priority that is not a string at all is rejected the same way", async () => {
    await seed("t-priority-nonstring", 0, 0);
    const body = await rejected("t-priority-nonstring", { priority: 3 });
    assert.equal(body["error"], "invalid_input");
    assert.equal(body.field, "priority");
    assert.equal((await loaded("t-priority-nonstring")).priority, "low");
  });
});

describe("updateTicket immutability, now that the write path has grown plan fields", () => {
  test("a PATCH naming status is still rejected", async () => {
    await seed("t-immutable-status", 0, 0);
    const body = await rejected("t-immutable-status", { status: "done" });
    assert.equal(body["error"], "immutable_field");
    assert.equal(body.field, "status");
  });

  test("every other lifecycle-owned field is still rejected", async () => {
    await seed("t-immutable-rest", 0, 0);
    const owned: [string, unknown][] = [
      ["number", 7],
      ["projectId", "other"],
      ["branch", "ticket/x"],
      ["agentName", "agent-x"],
      ["finished", true],
      ["died", true],
      ["sessionDir", "/tmp/session"],
    ];
    for (const [field, value] of owned) {
      const body = await rejected("t-immutable-rest", { [field]: value });
      assert.equal(body["error"], "immutable_field", `${field} must be immutable`);
      assert.equal(body.field, field);
    }
  });
});

describe("startedAt is lifecycle-owned", () => {
  test("setRunFields stamps started_at and null clears it", async () => {
    await seed("t-started", 0, 0);
    assert.equal((await loaded("t-started")).startedAt, null);

    await setRunFields("t-started", { startedAt: "2026-01-02T03:04:05.000Z" });
    assert.equal((await loaded("t-started")).startedAt, "2026-01-02T03:04:05.000Z");

    await setRunFields("t-started", { finished: true });
    assert.equal(
      (await loaded("t-started")).startedAt,
      "2026-01-02T03:04:05.000Z",
      "an absent startedAt must leave the stamp alone",
    );

    await setRunFields("t-started", { startedAt: null });
    assert.equal((await loaded("t-started")).startedAt, null);
  });

  test("a PATCH naming only startedAt writes nothing and reports nothing to update", async () => {
    await seed("t-started-patch-only", 0, 0);
    const body = await rejected("t-started-patch-only", { startedAt: "2026-01-02T03:04:05.000Z" });
    assert.equal(body["error"], "invalid_input");
    assert.match(String(body.message), /nothing to update/);
    assert.equal((await loaded("t-started-patch-only")).startedAt, null);
  });

  test("a PATCH carrying startedAt beside an editable field ignores startedAt", async () => {
    await seed("t-started-patch-mixed", 0, 0);
    await setRunFields("t-started-patch-mixed", { startedAt: "2026-01-02T03:04:05.000Z" });

    const result = await updateTicket("t-started-patch-mixed", {
      title: "renamed",
      startedAt: "2030-12-31T00:00:00.000Z",
    });
    if (!result.ok) assert.fail(`update rejected: ${JSON.stringify(result.body)}`);
    assert.equal(result.ticket.title, "renamed");
    assert.equal(result.ticket.startedAt, "2026-01-02T03:04:05.000Z");
  });
});
