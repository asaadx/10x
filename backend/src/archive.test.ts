/**
 * Route-level tests for `POST /tickets/:id/archive`: the Done-only guard, the same fail-closed
 * PR-state check `DELETE /tickets/:id` runs, and the point of the whole feature — an archived
 * ticket disappears from `listTickets()`/`GET /tickets` while `getTicket(id)` can still resolve
 * it directly, because `SELECT_ONE` is deliberately left unfiltered.
 *
 * The server under test runs as its own child process and GitHub is a real local HTTP server
 * queued one response at a time (test-server.ts).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeGitHub, startTestServer } from "./test-server.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-archive-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic.
const { db, initDb, nowIso } = await import("./db.ts");
await initDb();
const { getTicket } = await import("./ticket-store.ts");

const PROJECT_ID = "archive-test";

await db.execute(
  "INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, 'acme', 'proj', ?, ?, ?, ?)",
  [PROJECT_ID, PROJECT_ID, join(dir, "repo"), "main", nowIso(), nowIso()],
);

let nextNumber = 1;
async function seedTicket(
  id: string,
  over: { status?: string; prNumber?: number | null; prUrl?: string | null; prState?: string | null } = {},
): Promise<{ id: string }> {
  const number = nextNumber++;
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, description, status, branch, pr_number, pr_url, pr_state, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, PROJECT_ID, number, `ticket ${id}`, "", over.status ?? "done", `claude/10x-${id}`, over.prNumber ?? null, over.prUrl ?? null, over.prState ?? null, nowIso(), nowIso()],
  );
  return { id };
}

const gh = await startFakeGitHub();
const server = await startTestServer({
  port: 4322,
  stateDir: dir,
  githubUrl: gh.url,
  // The poller would reconcile PR states against the same fake-GitHub queue these tests fill
  // one response at a time, so it is parked out of the way.
  env: { GITHUB_TOKEN: "test-token", AGENT_POLL_MS: "3600000" },
});
const api = server.api;

async function boardIds(): Promise<string[]> {
  const res = await api("GET", `/tickets?project=${PROJECT_ID}`);
  return (res.body["tickets"] as Record<string, unknown>[]).map((t) => t["id"] as string);
}

after(async () => {
  await server.stop();
  await gh.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("POST /tickets/:id/archive", () => {
  test("archives a Done ticket once the live PR read comes back merged: gone from the board, still readable by id", async () => {
    const { id } = await seedTicket("t-merged", {
      status: "done",
      prNumber: 1,
      prUrl: "https://github.com/acme/proj/pull/1",
      prState: null, // never reconciled — forces the live read, same as DELETE's guard
    });
    gh.queue = [{ status: 200, body: { number: 1, state: "merged", merged: true, additions: 3, deletions: 1 } }];

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 200);
    assert.equal(res.body["archived"], true);
    // The freshly read terminal state was persisted on the way through.
    assert.equal(res.body["prState"], "merged");
    assert.ok(!(await boardIds()).includes(id));
  });

  test("refuses a non-Done ticket with 409 not_done, naming the status it found", async () => {
    const { id } = await seedTicket("t-in-progress", { status: "in_progress" });

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_done");
    assert.equal(res.body["status"], "in_progress");
    assert.ok((await boardIds()).includes(id));
  });

  test("refuses with 409 pr_open when the live GitHub read says the PR is still open", async () => {
    const { id } = await seedTicket("t-open", {
      status: "done",
      prNumber: 2,
      prUrl: "https://github.com/acme/proj/pull/2",
      prState: null,
    });
    gh.queue = [{ status: 200, body: { number: 2, state: "open", merged: false, additions: 5, deletions: 0 } }];

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "pr_open");
    assert.equal(res.body["prNumber"], 2);
    assert.ok((await boardIds()).includes(id));
  });

  test("refuses with 409 pr_state_unknown when the ticket has no recorded pull request", async () => {
    const { id } = await seedTicket("t-no-pr", { status: "done" });

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "pr_state_unknown");
    assert.ok((await boardIds()).includes(id));
  });

  test("await getTicket(id) still resolves an archived ticket by id even though the board no longer lists it", async () => {
    const { id } = await seedTicket("t-lookup", {
      status: "done",
      prNumber: 3,
      prUrl: "https://github.com/acme/proj/pull/3",
      prState: "merged", // terminal already, so no live GitHub call is needed here
    });

    const res = await api("POST", `/tickets/${id}/archive`);
    assert.equal(res.status, 200);

    assert.ok(!(await boardIds()).includes(id));
    const direct = await getTicket(id);
    assert.equal(direct?.id, id);
    assert.equal(direct?.archived, true);
  });
});
