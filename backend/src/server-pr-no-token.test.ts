/**
 * `GITHUB_TOKEN` must be a separate process from `server-pr.test.ts`'s, not a second scenario
 * inside it: `env.ts` (the first import of `server.ts`) loads the repo-root `.env` — which, in
 * this checkout, holds a real `GITHUB_TOKEN` — and `loadEnvFile` only skips a variable already
 * present in the environment. So "missing token" here means an explicit empty string, not an
 * omitted key: an omitted key would still get filled in from `.env` inside the child.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startTestServer } from "./test-server.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-server-pr-no-token-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

const PROJECT_ID = "pr-no-token-test";

// `owner`/`repo` stated explicitly: PR reads take the project's identity from these columns
// now, and this fixture has no repo on disk for the startup backfill to read a remote from.
await db.execute(
  `INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, provision_state, created_at, updated_at)
   VALUES (?, ?, 'acme', 'proj', ?, ?, 'ready', ?, ?)`,
  [PROJECT_ID, PROJECT_ID, "/tmp/does-not-need-to-exist", "main", nowIso(), nowIso()],
);

// A ticket already carrying a PR number but never reconciled — the pre-existing case, what
// `10x-1` had before this change — with a non-terminal, never-checked `prState`.
await db.execute(
  "INSERT INTO tickets (id, project_id, number, title, description, status, branch, pr_number, pr_url, pr_state, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ["t-no-token", PROJECT_ID, 1, "ticket t-no-token", "", "done", "claude/10x-t-no-token", 42, "https://github.com/acme/proj/pull/42", null, nowIso(), nowIso()],
);

// Present but empty, not omitted — see the file doc comment above.
const server = await startTestServer({ port: 4321, stateDir: dir, env: { GITHUB_TOKEN: "" } });

after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the board and the poller without GITHUB_TOKEN", () => {
  test("a null prState stays null instead of anything failing", async () => {
    // Several poll ticks' worth: the poller's PR reconcile must skip quietly without a token.
    await delay(400);
    const res = await server.api("GET", `/tickets?project=${PROJECT_ID}`);
    assert.equal(res.status, 200);
    const t = (res.body["tickets"] as Record<string, unknown>[]).find((x) => x["id"] === "t-no-token");
    assert.equal(t?.["prNumber"], 42);
    assert.equal(t?.["prState"], null);
    assert.equal(t?.["prAdditions"], null);
    assert.equal(t?.["prDeletions"], null);
  });
});
