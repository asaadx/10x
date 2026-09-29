/**
 * Route-level tests for the two pull-request mechanisms:
 *
 *  - Accept. A cloud agent opens its own DRAFT pull request, so Accept marks it ready
 *    (GraphQL `markPullRequestReadyForReview`); an agent that pushed but opened none gets one
 *    opened from its branch — with no local push, because the branch is already on GitHub. A
 *    failed GitHub call hands the claim back.
 *  - The poller's PR reconcile, which backfills state and ±LOC for PRs no webhook reported,
 *    at most once per TTL window.
 *
 * GitHub is a real local HTTP server behind `github-fetch-shim.ts` (test-server.ts). Two
 * servers, not one: the reconcile runs on a timer against the same fake-GitHub queue Accept
 * consumes, so each mechanism gets a server of its own and cannot eat the other's responses.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeGitHub, startTestServer } from "./test-server.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-server-pr-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic.
const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

const ACCEPT_PROJECT = "pr-accept-test";
const RECONCILE_PROJECT = "pr-reconcile-test";
for (const id of [ACCEPT_PROJECT, RECONCILE_PROJECT]) {
  await db.execute(
    "INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, 'acme', 'proj', ?, 'main', ?, ?)",
    [id, id, join(dir, "no-clone-needed"), nowIso(), nowIso()],
  );
}

let nextNumber = 1;
async function seedTicket(
  id: string,
  projectId: string,
  over: { status?: string; branch?: string | null; prNumber?: number | null; prUrl?: string | null; prState?: string | null } = {},
): Promise<void> {
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, description, status, branch, pr_number, pr_url, pr_state, agent_state, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?)",
    [
      id,
      projectId,
      nextNumber++,
      `ticket ${id}`,
      "",
      over.status ?? "in_review",
      over.branch === undefined ? `claude/10x-${id}` : over.branch,
      over.prNumber ?? null,
      over.prUrl ?? null,
      over.prState ?? null,
      nowIso(),
      nowIso(),
    ],
  );
}

const gh = await startFakeGitHub();
const acceptServer = await startTestServer({
  port: 4320,
  stateDir: dir,
  githubUrl: gh.url,
  // The poller is parked: these tests own every fake-GitHub response they queue.
  env: { GITHUB_TOKEN: "test-token", AGENT_POLL_MS: "3600000" },
});

const reconcileGh = await startFakeGitHub();
const reconcileDir = mkdtempSync(join(tmpdir(), "10x-server-pr-reconcile-"));

after(async () => {
  await acceptServer.stop();
  await gh.close();
  await reconcileGh.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(reconcileDir, { recursive: true, force: true });
});

const api = acceptServer.api;

describe("POST /tickets/:id/accept", () => {
  test("marks the agent's draft PR ready and records its state and LOC", async () => {
    await seedTicket("t-draft", ACCEPT_PROJECT, { prNumber: 501, prUrl: "https://github.com/acme/proj/pull/501" });
    gh.queue = [
      {
        status: 200,
        body: {
          number: 501,
          html_url: "https://github.com/acme/proj/pull/501",
          node_id: "PR_node501",
          draft: true,
          state: "open",
          merged: false,
          additions: 14,
          deletions: 2,
        },
      },
      { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } },
    ];
    const before = gh.calls.length;
    const res = await api("POST", "/tickets/t-draft/accept");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body["status"], "done");
    assert.equal(res.body["prNumber"], 501);
    assert.equal(res.body["prState"], "open");
    assert.equal(res.body["prAdditions"], 14);
    const calls = gh.calls.slice(before);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ["GET /repos/acme/proj/pulls/501", "POST /graphql"],
    );
    assert.match(calls[1]?.body ?? "", /markPullRequestReadyForReview/);
    assert.match(calls[1]?.body ?? "", /PR_node501/);
  });

  test("with no PR recorded, opens one from the agent's branch — no push", async () => {
    await seedTicket("t-branch", ACCEPT_PROJECT, { branch: "claude/10x-t-branch-v2" });
    gh.queue = [
      {
        status: 201,
        body: { number: 502, html_url: "https://github.com/acme/proj/pull/502", state: "open", merged: false, additions: 1, deletions: 0 },
      },
    ];
    const before = gh.calls.length;
    const res = await api("POST", "/tickets/t-branch/accept");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body["prNumber"], 502);
    assert.equal(res.body["prUrl"], "https://github.com/acme/proj/pull/502");
    const create = gh.calls.slice(before);
    assert.equal(create.length, 1);
    assert.equal(create[0]?.path, "/repos/acme/proj/pulls");
    // The head is exactly the branch the agent reported, not one 10x derived.
    assert.equal((JSON.parse(create[0]?.body ?? "{}") as { head: string }).head, "claude/10x-t-branch-v2");
  });

  test("a GitHub failure hands the claim back to review", async () => {
    await seedTicket("t-fail", ACCEPT_PROJECT, { prNumber: 503, prUrl: "https://github.com/acme/proj/pull/503" });
    gh.queue = [{ status: 404, body: { message: "Not Found" } }];
    const res = await api("POST", "/tickets/t-fail/accept");
    assert.equal(res.status, 502);
    const row = (await db.execute("SELECT status FROM tickets WHERE id = 't-fail'")).rows[0];
    assert.equal(row?.["status"], "in_review");
  });

  test("nothing to publish is 409 no_branch, and the ticket does not move", async () => {
    await seedTicket("t-nothing", ACCEPT_PROJECT, { branch: null });
    const res = await api("POST", "/tickets/t-nothing/accept");
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "no_branch");
  });

  test("a ticket not in review is refused", async () => {
    await seedTicket("t-early", ACCEPT_PROJECT, { status: "in_progress" });
    const res = await api("POST", "/tickets/t-early/accept");
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_in_review");
  });
});

describe("the poller reconciles PR state", () => {
  test("backfills a never-reported PR once, then leaves it alone for the TTL", async () => {
    // A second store for the second server. Written through a fresh local client rather than
    // the module-level `db`, which is bound to the first file.
    const { localSql } = await import("./sql.ts");
    const sql = localSql(join(reconcileDir, "10x.db"));
    const server = await startTestServer({
      port: 4323,
      stateDir: reconcileDir,
      githubUrl: reconcileGh.url,
      env: { GITHUB_TOKEN: "test-token", AGENT_POLL_MS: "100" },
    });
    try {
      await sql.execute(
        "INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, 'acme', 'proj', '/nowhere', 'main', ?, ?)",
        [RECONCILE_PROJECT, RECONCILE_PROJECT, nowIso(), nowIso()],
      );
      reconcileGh.queue = [
        { status: 200, body: { number: 900, state: "open", merged: false, additions: 7, deletions: 1 } },
        // Would change the row if consumed — it must not be, inside the TTL.
        { status: 200, body: { number: 900, state: "merged", merged: true, additions: 99, deletions: 99 } },
      ];
      await sql.execute(
        "INSERT INTO tickets (id, project_id, number, title, status, branch, pr_number, pr_url, created_at, updated_at) " +
          "VALUES ('t-backfill', ?, 1, 't', 'done', 'claude/10x-t-backfill', 900, 'https://github.com/acme/proj/pull/900', ?, ?)",
        [RECONCILE_PROJECT, nowIso(), nowIso()],
      );

      let ticket: Record<string, unknown> | undefined;
      for (let i = 0; i < 50; i++) {
        const res = await server.api("GET", `/tickets?project=${RECONCILE_PROJECT}`);
        ticket = (res.body["tickets"] as Record<string, unknown>[]).find((t) => t["id"] === "t-backfill");
        if (ticket?.["prState"] !== null && ticket?.["prState"] !== undefined) break;
        await delay(100);
      }
      assert.equal(ticket?.["prState"], "open", server.log());
      assert.equal(ticket?.["prAdditions"], 7);

      // Several more ticks: the second queued response stays queued.
      await delay(500);
      assert.equal(reconcileGh.calls.length, 1);
      assert.equal(reconcileGh.queue.length, 1);
    } finally {
      await server.stop();
    }
  });
});
