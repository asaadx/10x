/**
 * Route-level tests for the cloud-session lifecycle — spawn, plan, reject, cancel, delete — and
 * the poller that turns an agent's `done` into the move to review, against the server as a
 * child process with `CLOUD_DRIVER=fake`.
 *
 * `FAKE_AGENT_MS` makes the fake play the agent's half of the protocol (docs/prototype-cloud.md):
 * it writes `working`, then `done` plus a branch, into the same database the board reads. That is
 * the whole loop the product depends on, exercised with no network. `FAKE_CLOUD_LOG` is how
 * this process sees what the child told the "CLI".
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FakeCall } from "./cloud.ts";
import { startTestServer } from "./test-server.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-cloud-routes-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic.
const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

const PROJECT_ID = "cloudproj";
const repoPath = join(dir, "clone");
mkdirSync(repoPath);
await db.execute(
  `INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, provision_state, created_at, updated_at)
   VALUES (?, ?, 'acme', 'widgets', ?, 'trunk', 'ready', ?, ?)`,
  [PROJECT_ID, "Cloud", repoPath, nowIso(), nowIso()],
);

const logFile = join(dir, "cloud-calls.jsonl");
const AGENT_MS = 150;
const server = await startTestServer({
  port: 4325,
  stateDir: dir,
  env: {
    GITHUB_TOKEN: "",
    FAKE_AGENT_MS: String(AGENT_MS),
    FAKE_CLOUD_LOG: logFile,
    AGENT_POLL_MS: "100",
  },
});
const api = server.api;

after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

const calls = (): FakeCall[] =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FakeCall)
    : [];

async function createTicket(title: string, status: "backlog" | "todo" = "todo"): Promise<string> {
  const res = await api("POST", "/tickets", {
    projectId: PROJECT_ID,
    title,
    description: "Make it {{shiny}}.",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = String(res.body["id"]);
  const patched = await api("PATCH", `/tickets/${id}`, { taskBreakdown: [{ text: "do the thing", done: false }] });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  if (status === "todo") assert.equal((await api("POST", `/tickets/${id}/status`, { to: "todo" })).status, 200);
  return id;
}

async function row(id: string): Promise<Record<string, unknown>> {
  const res = await api("GET", `/tickets?project=${PROJECT_ID}`);
  const found = (res.body["tickets"] as Record<string, unknown>[]).find((t) => t["id"] === id);
  if (!found) throw new Error(`${id} is not on the board`);
  return found;
}

async function waitFor(id: string, what: string, ok: (t: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = await row(id);
    if (ok(last)) return last;
    await delay(50);
  }
  throw new Error(`${id} never ${what}; last: ${JSON.stringify(last)}\n${server.log()}`);
}

describe("spawn → agent done → poller → review", () => {
  let id = "";

  test("spawn claims the ticket and starts an implementation session in the clone", async () => {
    id = await createTicket("Add a button");
    const res = await api("POST", `/tickets/${id}/spawn`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(String(res.body["sessionId"]), /^session_fake_\d+$/);
    assert.equal(res.body["sessionUrl"], `https://claude.ai/code/${res.body["sessionId"]}`);

    const t = await row(id);
    assert.equal(t["status"], "in_progress");
    assert.equal(t["sessionKind"], "impl");
    assert.equal(t["sessionId"], res.body["sessionId"]);
    assert.equal(typeof t["startedAt"], "string");
    assert.ok(t["agentState"] === "starting" || t["agentState"] === "working");
    // The board read carries the two process-local fields and nothing Herdr-shaped.
    assert.equal(t["busy"], false);
    assert.equal(t["preview"], null);
    for (const gone of ["paneId", "workspaceId", "worktreePath", "hasWorktree", "diagnostics", "agentStatus"]) {
      assert.ok(!(gone in t), `${gone} should be gone from the board read`);
    }

    const start = calls().find((c) => c.kind === "start" && c.sessionId === res.body["sessionId"]);
    assert.ok(start && start.kind === "start");
    assert.equal(start.cwd, repoPath);
    assert.equal(start.baseBranch, "trunk");
    assert.ok(start.message.startsWith(`10x ticket ${id} — Add a button`));
    assert.ok(start.message.includes(`claude/10x-${id}`));
    // User text that looks like a marker survives: the ticket is concatenated, not templated.
    assert.ok(start.message.includes("Make it {{shiny}}."));
    assert.ok(start.message.includes("- [ ] do the thing"));
  });

  test("the agent's own `done` moves the ticket to review, with the branch it reported", async () => {
    const t = await waitFor(id, "reached review", (r) => r["status"] === "in_review");
    assert.equal(t["agentState"], "done");
    assert.equal(t["branch"], `claude/10x-${id}`);
    assert.equal(t["finished"], true);
    assert.equal(typeof t["agentNote"], "string");
    assert.equal(typeof t["agentUpdatedAt"], "string");
  });

  test("reject needs a reason", async () => {
    const res = await api("POST", `/tickets/${id}/reject`, { reason: "  " });
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "reason_required");
  });

  test("reject sends the reason into the same session, and the next `done` returns it to review", async () => {
    const sessionId = (await row(id))["sessionId"];
    const res = await api("POST", `/tickets/${id}/reject`, { reason: "The button is the wrong colour." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body["status"], "in_progress");
    // In the same statement as the claim, so no poll can see the stale `done` beside it.
    assert.equal(res.body["agentState"], "working");
    assert.equal(res.body["finished"], false);

    const send = calls().find((c) => c.kind === "send" && c.sessionId === sessionId);
    assert.ok(send && send.kind === "send");
    assert.match(send.text, /The button is the wrong colour\./);
    assert.match(send.text, /done/);

    await waitFor(id, "returned to review", (r) => r["status"] === "in_review" && r["agentState"] === "done");
  });

  test("a spawn from anywhere but To Do is refused and moves nothing", async () => {
    const res = await api("POST", `/tickets/${id}/spawn`);
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_in_todo");
    assert.equal((await row(id))["status"], "in_review");
  });
});

describe("reject without a session", () => {
  test("is 409 no_session", async () => {
    const res0 = await db.execute(
      "INSERT INTO tickets (id, project_id, number, title, status, created_at, updated_at) VALUES ('cloudproj-900', ?, 900, 'x', 'in_review', ?, ?)",
      [PROJECT_ID, nowIso(), nowIso()],
    );
    assert.equal(res0.rowsAffected, 1);
    const res = await api("POST", "/tickets/cloudproj-900/reject", { reason: "no" });
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "no_session");
  });
});

describe("cancel", () => {
  test("returns the ticket to To Do, clears the session, and tells the session to stop", async () => {
    const id = await createTicket("Cancel me");
    const spawned = await api("POST", `/tickets/${id}/spawn`);
    assert.equal(spawned.status, 200);

    const res = await api("POST", `/tickets/${id}/cancel`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body["messaged"], true);

    const t = await row(id);
    assert.equal(t["status"], "todo");
    assert.equal(t["sessionId"], null);
    assert.equal(t["sessionUrl"], null);
    assert.equal(t["sessionKind"], null);
    assert.equal(t["agentState"], null);

    const send = calls().find((c) => c.kind === "send" && c.sessionId === spawned.body["sessionId"]);
    assert.ok(send && send.kind === "send");
    assert.match(send.text, /cancelled/i);

    // The fake agent's turn outlives the cancel; scoped to its session, it writes nothing.
    await delay(AGENT_MS * 3);
    const later = await row(id);
    assert.equal(later["status"], "todo");
    assert.equal(later["agentState"], null);
  });

  test("a ticket that is not running is refused", async () => {
    const id = await createTicket("Idle");
    const res = await api("POST", `/tickets/${id}/cancel`);
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_in_progress");
  });
});

describe("plan", () => {
  test("starts a plan session on a backlog ticket without moving it, and a second click reuses it", async () => {
    const id = await createTicket("Plan me", "backlog");
    const first = await api("POST", `/tickets/${id}/plan`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body["reused"], false);

    const t = await row(id);
    assert.equal(t["status"], "backlog");
    assert.equal(t["sessionKind"], "plan");
    assert.equal(t["sessionId"], first.body["sessionId"]);

    const start = calls().find((c) => c.kind === "start" && c.sessionId === first.body["sessionId"]);
    assert.ok(start && start.kind === "start");
    assert.ok(!start.message.includes("claude/10x-"), "a plan session is given no branch");

    const starts = calls().filter((c) => c.kind === "start").length;
    const second = await api("POST", `/tickets/${id}/plan`);
    assert.equal(second.status, 200);
    assert.equal(second.body["reused"], true);
    assert.equal(second.body["sessionId"], first.body["sessionId"]);
    assert.equal(calls().filter((c) => c.kind === "start").length, starts);

    // The planner finishing flags the card; it never moves a backlog ticket.
    await waitFor(id, "saw the planner finish", (r) => r["agentState"] === "done");
    await delay(300);
    assert.equal((await row(id))["status"], "backlog");
  });

  test("plan outside Backlog is refused", async () => {
    const id = await createTicket("Already planned");
    const res = await api("POST", `/tickets/${id}/plan`);
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_in_backlog");
  });
});

describe("the agent's fields are not editable through the API", () => {
  test("PATCHing agentState is 400 immutable_field", async () => {
    const id = await createTicket("Forge me");
    for (const field of ["agentState", "sessionId", "agentNote"]) {
      const res = await api("PATCH", `/tickets/${id}`, { [field]: "done" });
      assert.equal(res.status, 400, field);
      assert.equal(res.body["error"], "immutable_field", field);
    }
  });
});

describe("delete", () => {
  test("deleting a running ticket tells its session and removes the row", async () => {
    const id = await createTicket("Delete me");
    const spawned = await api("POST", `/tickets/${id}/spawn`);
    const res = await api("DELETE", `/tickets/${id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const send = calls().find((c) => c.kind === "send" && c.sessionId === spawned.body["sessionId"]);
    assert.ok(send);
    const board = await api("GET", `/tickets?project=${PROJECT_ID}`);
    assert.ok(!(board.body["tickets"] as Record<string, unknown>[]).some((t) => t["id"] === id));
  });
});

describe("the Herdr routes are gone", () => {
  test("/focus, /worktree and screenshot upload answer 404", async () => {
    const id = await createTicket("Nothing to focus");
    assert.equal((await api("POST", `/tickets/${id}/focus`)).status, 404);
    assert.equal((await api("DELETE", `/tickets/${id}/worktree`)).status, 404);
    assert.equal((await api("POST", `/tickets/${id}/screenshots/before`, {})).status, 404);
  });
});
