/**
 * The hand-back paths: what the board does when the `claude` CLI refuses. A separate server
 * from cloud-routes.test.ts because the failure is configured per process
 * (`FAKE_CLOUD_FAIL=start,send`) — every start and every send in this child fails.
 *
 * The rule under test is "claim first, work second, and a failed step hands the claim back"
 * (memory/operations.md): a ticket must never be left In Progress with no session behind it,
 * nor In Progress after a Reject its agent never heard.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "./test-server.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-cloud-routes-failure-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

const PROJECT_ID = "failproj";
mkdirSync(join(dir, "clone"));
await db.execute(
  `INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, provision_state, created_at, updated_at)
   VALUES (?, 'Fail', 'acme', 'widgets', ?, 'main', 'ready', ?, ?)`,
  [PROJECT_ID, join(dir, "clone"), nowIso(), nowIso()],
);

let n = 1;
async function seed(status: string, extra: { sessionId?: string; agentState?: string } = {}): Promise<string> {
  const id = `${PROJECT_ID}-${n}`;
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, status, session_id, session_url, session_kind, agent_state, finished, created_at, updated_at) " +
      "VALUES (?, ?, ?, 't', ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      PROJECT_ID,
      n++,
      status,
      extra.sessionId ?? null,
      extra.sessionId ? `https://claude.ai/code/${extra.sessionId}` : null,
      extra.sessionId ? "impl" : null,
      extra.agentState ?? null,
      extra.agentState === "done" ? 1 : 0,
      nowIso(),
      nowIso(),
    ],
  );
  return id;
}

const server = await startTestServer({
  port: 4326,
  stateDir: dir,
  env: { GITHUB_TOKEN: "", FAKE_CLOUD_FAIL: "start,send" },
});
const api = server.api;

after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function stored(id: string): Promise<Record<string, unknown>> {
  const r = (await db.execute("SELECT * FROM tickets WHERE id = ?", [id])).rows[0];
  if (!r) throw new Error(`no ${id}`);
  return r;
}

describe("a session that cannot be started", () => {
  test("spawn hands the claim back to To Do and leaves no session on the row", async () => {
    const id = await seed("todo");
    const res = await api("POST", `/tickets/${id}/spawn`);
    assert.equal(res.status, 502);
    assert.equal(res.body["error"], "session_start_failed");
    assert.match(String(res.body["message"]), /configured to fail/);
    const r = await stored(id);
    assert.equal(r["status"], "todo");
    assert.equal(r["session_id"], null);
    assert.equal(r["session_kind"], null);
    assert.equal(r["agent_state"], null);
    assert.equal(r["started_at"], null);
  });

  test("plan clears the half-written session fields", async () => {
    const id = await seed("backlog");
    const res = await api("POST", `/tickets/${id}/plan`);
    assert.equal(res.status, 502);
    const r = await stored(id);
    assert.equal(r["status"], "backlog");
    assert.equal(r["session_kind"], null);
    assert.equal(r["agent_state"], null);
  });
});

describe("a message that cannot be delivered", () => {
  test("reject hands the claim back to review with the agent's own report restored", async () => {
    const id = await seed("in_review", { sessionId: "session_gone", agentState: "done" });
    const res = await api("POST", `/tickets/${id}/reject`, { reason: "try again" });
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "prompt_failed");
    const r = await stored(id);
    assert.equal(r["status"], "in_review");
    assert.equal(r["agent_state"], "done");
    assert.equal(r["finished"], 1);
  });

  test("cancel still cancels — the stop message is best-effort", async () => {
    const id = await seed("in_progress", { sessionId: "session_unreachable", agentState: "working" });
    const res = await api("POST", `/tickets/${id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body["messaged"], false);
    const r = await stored(id);
    assert.equal(r["status"], "todo");
    assert.equal(r["session_id"], null);
  });
});
