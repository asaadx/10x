/**
 * Tests for `claimTicket`, the compare-and-swap that is the only lock in the system (memory/operations.md).
 * A double-click, a double-drag or a retry must not start two spawns for one ticket.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TicketRow } from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-db-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts opens the database at module load, so DB_PATH must already be set: the one place
// a dynamic import is required rather than preferred. Static imports hoist above the
// assignments above and would open the real ~/.10x/10x.db.
const { claimTicket, db, initDb, nowIso, setPullRequest, setPullRequestState, toStatus, toTicket } = await import("./db.ts");
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
async function seed(id: string, status: string, updatedAt = ANCIENT): Promise<void> {
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, description, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, PROJECT_ID, nextNumber++, `ticket ${id}`, "", status, ANCIENT, updatedAt],
  );
}

async function readString(id: string, column: "status" | "updated_at"): Promise<string> {
  const row = (await db.execute(`SELECT ${column} AS value FROM tickets WHERE id = ?`, [id])).rows[0];
  const value = row?.["value"];
  if (typeof value !== "string") assert.fail(`no string ${column} for ticket ${id}: ${value}`);
  return value;
}

/**
 * The row `toTicket` wants, which is not the row SQLite hands back: the three list columns
 * are JSON text on disk and typed arrays in `TicketRow`, and parsing them is what
 * ticket-store.ts's `decode` does in production. This is the test's own parse boundary.
 * Both are NOT NULL with an '[]' default, so the read is always text.
 */
async function rowOf(id: string): Promise<TicketRow> {
  const row = (await db.execute("SELECT * FROM tickets WHERE id = ?", [id])).rows[0];
  if (row === undefined) assert.fail(`no ticket ${id}`);
  return {
    ...row,
    task_breakdown: JSON.parse(String(row["task_breakdown"])),
    acceptance_criteria: JSON.parse(String(row["acceptance_criteria"])),
    attachments: JSON.parse(String(row["attachments"])),
  } as TicketRow;
}

describe("claimTicket", () => {
  test("a first claim from todo to in_progress wins and moves the row", async () => {
    await seed("t-win", "todo");
    assert.equal(await claimTicket("t-win", "todo", "in_progress"), true);
    assert.equal(await readString("t-win", "status"), "in_progress");
  });

  // The whole reason the CAS exists: the second of two clicks must lose, not spawn a
  // second agent onto the same branch.
  test("an immediate identical second claim loses", async () => {
    await seed("t-double", "todo");
    assert.equal(await claimTicket("t-double", "todo", "in_progress"), true);
    assert.equal(await claimTicket("t-double", "todo", "in_progress"), false);
    assert.equal(await readString("t-double", "status"), "in_progress");
  });

  test("a claim whose `from` does not match the current status loses", async () => {
    await seed("t-mismatch", "in_progress");
    assert.equal(await claimTicket("t-mismatch", "todo", "in_progress"), false);
    assert.equal(await readString("t-mismatch", "status"), "in_progress");
  });

  test("cancel is the same lock in reverse", async () => {
    await seed("t-cancel", "in_progress");
    assert.equal(await claimTicket("t-cancel", "in_progress", "todo"), true);
    assert.equal(await claimTicket("t-cancel", "in_progress", "todo"), false);
    assert.equal(await readString("t-cancel", "status"), "todo");
  });

  test("a claim on an unknown ticket id loses instead of throwing", async () => {
    assert.equal(await claimTicket("t-nonexistent", "todo", "in_progress"), false);
  });

  test("a claim does not touch any other ticket", async () => {
    await seed("t-target", "todo");
    await seed("t-bystander", "todo");
    assert.equal(await claimTicket("t-target", "todo", "in_progress"), true);
    assert.equal(await readString("t-bystander", "status"), "todo");
    assert.equal(await readString("t-bystander", "updated_at"), ANCIENT);
  });

  test("a winning claim bumps updated_at; a losing one leaves it alone", async () => {
    await seed("t-stamp", "todo");
    assert.equal(await claimTicket("t-stamp", "todo", "in_progress"), true);

    const bumped = await readString("t-stamp", "updated_at");
    assert.ok(bumped > ANCIENT, `expected updated_at past ${ANCIENT}, got ${bumped}`);
    assert.equal(new Date(bumped).toISOString(), bumped, "updated_at must be an ISO instant");

    assert.equal(await claimTicket("t-stamp", "todo", "in_progress"), false);
    assert.equal(await readString("t-stamp", "updated_at"), bumped);
  });
});

/**
 * The two moves `POST /tickets/:id/status` makes itself: legal, and pure status writes, so the
 * claim is the only thing that happens at all (transitions.ts). They take the same lock as
 * everything else — a Plan racing a send-back has to resolve to one winner too.
 */
describe("claimTicket for the manual Backlog/To Do moves", () => {
  test("accepting a plan claims backlog to todo", async () => {
    await seed("t-plan", "backlog");
    assert.equal(await claimTicket("t-plan", "backlog", "todo"), true);
    assert.equal(await readString("t-plan", "status"), "todo");
  });

  test("sending a ticket back to be re-planned claims todo to backlog", async () => {
    await seed("t-replan", "todo");
    assert.equal(await claimTicket("t-replan", "todo", "backlog"), true);
    assert.equal(await readString("t-replan", "status"), "backlog");
  });

  test("a second Plan on a ticket already in To Do loses", async () => {
    await seed("t-plan-twice", "backlog");
    assert.equal(await claimTicket("t-plan-twice", "backlog", "todo"), true);
    assert.equal(await claimTicket("t-plan-twice", "backlog", "todo"), false);
    assert.equal(await readString("t-plan-twice", "status"), "todo");
  });

  // A rollback undoes the claim that just won, so its target is that claim's source. A spawn
  // that fails after claiming `todo → in_progress` puts the ticket back in To Do; Backlog would
  // demote a planned ticket to a raw idea and Start would then refuse it.
  test("a failed spawn rolls the claim back to todo", async () => {
    await seed("t-rollback", "todo");
    assert.equal(await claimTicket("t-rollback", "todo", "in_progress"), true);
    assert.equal(await claimTicket("t-rollback", "in_progress", "todo"), true);
    assert.equal(await readString("t-rollback", "status"), "todo");
  });
});

/**
 * The `in_progress → in_review` transition is automatic: it fires from the spawn handler's
 * status callback the moment a turn settles. Since a turn can settle more than once — a human
 * steering the agent in Herdr produces a second `working → done` cycle — the claim is the only
 * thing standing between "the turn completed" and a ticket being re-transitioned.
 */
describe("claimTicket across in_review", () => {
  test("a settled turn claims in_progress to in_review", async () => {
    await seed("t-review", "in_progress");
    assert.equal(await claimTicket("t-review", "in_progress", "in_review"), true);
    assert.equal(await readString("t-review", "status"), "in_review");
  });

  test("a second settle finds nothing to claim and leaves the row untouched", async () => {
    await seed("t-resettle", "in_progress");
    assert.equal(await claimTicket("t-resettle", "in_progress", "in_review"), true);
    const moved = await readString("t-resettle", "updated_at");

    assert.equal(await claimTicket("t-resettle", "in_progress", "in_review"), false);
    assert.equal(await readString("t-resettle", "status"), "in_review");
    assert.equal(await readString("t-resettle", "updated_at"), moved);
  });

  // Why an In Review card offers no Cancel: the endpoint claims `in_progress → todo` and
  // matches no row from here, so the button would be one that cannot work.
  test("a cancel cannot claim a ticket that has moved to review", async () => {
    await seed("t-review-cancel", "in_review");
    assert.equal(await claimTicket("t-review-cancel", "in_progress", "todo"), false);
    assert.equal(await readString("t-review-cancel", "status"), "in_review");
  });

  test("a claim into review from the wrong source state loses", async () => {
    await seed("t-review-wrong", "backlog");
    assert.equal(await claimTicket("t-review-wrong", "in_progress", "in_review"), false);
    assert.equal(await readString("t-review-wrong", "status"), "backlog");
    assert.equal(await readString("t-review-wrong", "updated_at"), ANCIENT);
  });
});

describe("claimTicket for reject", () => {
  test("a reject claims in_review to in_progress", async () => {
    await seed("t-reject", "in_review");
    assert.equal(await claimTicket("t-reject", "in_review", "in_progress"), true);
    assert.equal(await readString("t-reject", "status"), "in_progress");
  });

  test("a reject loses from backlog", async () => {
    await seed("t-reject-backlog", "backlog");
    assert.equal(await claimTicket("t-reject-backlog", "in_review", "in_progress"), false);
    assert.equal(await readString("t-reject-backlog", "status"), "backlog");
  });

  test("a reject loses from in_progress", async () => {
    await seed("t-reject-inprogress", "in_progress");
    assert.equal(await claimTicket("t-reject-inprogress", "in_review", "in_progress"), false);
    assert.equal(await readString("t-reject-inprogress", "status"), "in_progress");
  });

  test("a reject loses from done", async () => {
    await seed("t-reject-done", "done");
    assert.equal(await claimTicket("t-reject-done", "in_review", "in_progress"), false);
    assert.equal(await readString("t-reject-done", "status"), "done");
  });

  // The failure-recovery path (server.ts /reject): a failed re-prompt hands the claim
  // straight back, so this reverse claim must succeed after the forward one.
  test("a failed prompt hands the claim back from in_progress to in_review", async () => {
    await seed("t-reject-handback", "in_review");
    assert.equal(await claimTicket("t-reject-handback", "in_review", "in_progress"), true);
    assert.equal(await claimTicket("t-reject-handback", "in_progress", "in_review"), true);
    assert.equal(await readString("t-reject-handback", "status"), "in_review");
  });
});

describe("toStatus", () => {
  test("decodes \"done\" as \"done\"", () => {
    assert.equal(toStatus("done"), "done");
  });

  test("an unknown string still decodes as backlog", async () => {
    assert.equal(toStatus("archived"), "backlog");
  });
});

describe("claimTicket into done", () => {
  test("a claim from in_review to done succeeds", async () => {
    await seed("t-done", "in_review");
    assert.equal(await claimTicket("t-done", "in_review", "done"), true);
    assert.equal(await readString("t-done", "status"), "done");
  });

  test("a claim into done fails from backlog", async () => {
    await seed("t-done-backlog", "backlog");
    assert.equal(await claimTicket("t-done-backlog", "in_review", "done"), false);
    assert.equal(await readString("t-done-backlog", "status"), "backlog");
  });

  test("a claim into done fails from in_progress", async () => {
    await seed("t-done-progress", "in_progress");
    assert.equal(await claimTicket("t-done-progress", "in_review", "done"), false);
    assert.equal(await readString("t-done-progress", "status"), "in_progress");
  });

  test("a claim into done fails from a ticket already done", async () => {
    await seed("t-done-twice", "done");
    assert.equal(await claimTicket("t-done-twice", "in_review", "done"), false);
    assert.equal(await readString("t-done-twice", "status"), "done");
  });

  // The Accept handler's failure-recovery path: a publish that throws after the claim must
  // be able to hand the ticket back to review rather than stranding it in Done with no PR.
  test("a done ticket can be claimed back to in_review", async () => {
    await seed("t-done-revert", "in_review");
    assert.equal(await claimTicket("t-done-revert", "in_review", "done"), true);
    assert.equal(await claimTicket("t-done-revert", "done", "in_review"), true);
    assert.equal(await readString("t-done-revert", "status"), "in_review");
  });

  test("handing a ticket back from done loses if it never made it to done", async () => {
    await seed("t-done-revert-miss", "in_review");
    assert.equal(await claimTicket("t-done-revert-miss", "done", "in_review"), false);
    assert.equal(await readString("t-done-revert-miss", "status"), "in_review");
  });
});

describe("setPullRequest", () => {
  test("stores both values and they survive a read back through toTicket", async () => {
    await seed("t-pr", "in_review");
    await setPullRequest("t-pr", 42, "https://example.com/pr/42");
    const row = await rowOf("t-pr");
    const ticket = toTicket(row);
    assert.equal(ticket.prNumber, 42);
    assert.equal(ticket.prUrl, "https://example.com/pr/42");
  });

  test("a ticket that has never been accepted reads null for both", async () => {
    await seed("t-no-pr", "backlog");
    const row = await rowOf("t-no-pr");
    const ticket = toTicket(row);
    assert.equal(ticket.prNumber, null);
    assert.equal(ticket.prUrl, null);
  });
});

describe("setPullRequestState", () => {
  test("stores all three columns and moves updated_at, matched by pr_url", async () => {
    await seed("t-pr-state", "in_review");
    await db.execute("UPDATE tickets SET pr_url = ? WHERE id = ?", ["https://example.com/pr/9", "t-pr-state"]);
    const before = await readString("t-pr-state", "updated_at");
    const matched = await setPullRequestState("https://example.com/pr/9", "merged", 12, 3);
    assert.equal(matched, true);
    const row = await rowOf("t-pr-state");
    const ticket = toTicket(row);
    assert.equal(ticket.prState, "merged");
    assert.equal(ticket.prAdditions, 12);
    assert.equal(ticket.prDeletions, 3);
    assert.notEqual(await readString("t-pr-state", "updated_at"), before);
  });

  test("an unknown PR url matches nothing and leaves every existing row untouched", async () => {
    await seed("t-pr-other", "in_review");
    await db.execute("UPDATE tickets SET pr_url = ? WHERE id = ?", ["https://example.com/pr/99", "t-pr-other"]);
    const before = await readString("t-pr-other", "updated_at");
    const matched = await setPullRequestState("https://example.com/pr/does-not-exist", "closed", 1, 1);
    assert.equal(matched, false);
    const row = await rowOf("t-pr-other");
    assert.equal(row.pr_state, null);
    assert.equal(await readString("t-pr-other", "updated_at"), before);
  });
});
