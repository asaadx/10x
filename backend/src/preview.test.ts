/**
 * Route-level tests for Preview (`POST`/`DELETE /tickets/:id/preview`) against a real git
 * repository with a real remote — a bare repo standing in for GitHub — and a real dev command
 * that listens on the `PORT` it is given. What is proven is the whole point of the feature:
 * the agent's pushed branch is fetched and checked out, the command answers on the ticket's
 * port block, and DELETE (or the board shutting down) leaves nothing listening.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startTestServer } from "./test-server.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-preview-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

// ---------------------------------------------------------------------------
// A clone with an `origin`, and the agent's branch pushed to that origin only — exactly the
// situation after a cloud agent pushes: the branch exists on the remote, not in the clone.
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const origin = join(dir, "origin.git");
const clone = join(dir, "clone");
const work = join(dir, "agent-side");
git(dir, "init", "-q", "--bare", origin);
git(dir, "clone", "-q", origin, clone);
git(dir, "clone", "-q", origin, work);
for (const repo of [clone, work]) {
  git(repo, "config", "user.email", "test@10x.invalid");
  git(repo, "config", "user.name", "10x test");
}
git(clone, "commit", "-q", "--allow-empty", "-m", "init");
git(clone, "push", "-q", "origin", "HEAD:main");
git(work, "fetch", "-q", "origin");
git(work, "checkout", "-q", "-b", "claude/10x-prev-1", "origin/main");
writeFileSync(join(work, "FROM_THE_AGENT.txt"), "hello\n");
git(work, "add", "FROM_THE_AGENT.txt");
git(work, "commit", "-q", "-m", "agent work");
git(work, "push", "-q", "origin", "claude/10x-prev-1");

const devCommand = `node -e "require('http').createServer((q,s)=>s.end('ok '+process.env.PORT)).listen(process.env.PORT)"`;
await db.execute(
  `INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, provision_state, dev_command, created_at, updated_at)
   VALUES ('prev', 'Prev', 'acme', 'prev', ?, 'main', 'ready', ?, ?, ?)`,
  [clone, devCommand, nowIso(), nowIso()],
);
const seed = async (id: string, number: number, branch: string | null) => {
  await db.execute(
    "INSERT INTO tickets (id, project_id, number, title, status, branch, created_at, updated_at) VALUES (?, 'prev', ?, 't', 'in_review', ?, ?, ?)",
    [id, number, branch, nowIso(), nowIso()],
  );
};
await seed("prev-1", 1, "claude/10x-prev-1");
await seed("prev-2", 2, null);
await seed("prev-3", 3, "--upload-pack=touch /tmp/pwned");

// Off the default pool, so a board or another suite on 4100+ cannot collide with this one.
const BASE = 4620;
const server = await startTestServer({
  port: 4327,
  stateDir: dir,
  env: { GITHUB_TOKEN: "", PORT_BLOCK_BASE: String(BASE), AGENT_POLL_MS: "3600000" },
});
const api = server.api;

after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function answers(url: string): Promise<string | null> {
  try {
    return await (await fetch(url)).text();
  } catch {
    return null;
  }
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`${what} within ${ms}ms\n${server.log()}`);
    await delay(100);
  }
}

describe("POST /tickets/:id/preview", () => {
  let url = "";
  let path = "";

  test("checks the pushed branch out and runs the dev command on the ticket's port block", async () => {
    const res = await api("POST", "/tickets/prev-1/preview");
    assert.equal(res.status, 200, JSON.stringify(res.body) + server.log());
    assert.equal(res.body["port"], BASE);
    assert.equal(res.body["url"], `http://localhost:${BASE}`);
    assert.equal(res.body["command"], devCommand);
    assert.equal(res.body["running"], true);
    url = String(res.body["url"]);
    path = String(res.body["path"]);

    assert.equal(path, join(dir, "previews", "prev-1"));
    // The agent's commit, not the base branch.
    assert.equal(readFileSync(join(path, "FROM_THE_AGENT.txt"), "utf8"), "hello\n");
    assert.match(readFileSync(join(path, ".env"), "utf8"), new RegExp(`^PORT=${BASE}$`, "m"));

    assert.equal(await until("the dev server never answered", () => answers(url)), `ok ${BASE}`);

    const board = await api("GET", "/tickets?project=prev");
    const t = (board.body["tickets"] as Record<string, unknown>[]).find((x) => x["id"] === "prev-1");
    assert.deepEqual(t?.["preview"], res.body);
  });

  test("DELETE kills the dev server's process group, removes the checkout and frees the slot", async () => {
    const res = await api("DELETE", "/tickets/prev-1/preview");
    assert.equal(res.status, 200);
    assert.equal(res.body["stopped"], true);
    await until("the dev server kept answering", async () => ((await answers(url)) === null ? true : null));
    assert.equal(existsSync(path), false);
    const slot = (await db.execute("SELECT port_slot FROM tickets WHERE id = 'prev-1'")).rows[0]?.["port_slot"];
    assert.equal(slot, null);
    const board = await api("GET", "/tickets?project=prev");
    const t = (board.body["tickets"] as Record<string, unknown>[]).find((x) => x["id"] === "prev-1");
    assert.equal(t?.["preview"], null);
  });

  test("a ticket whose agent has reported no branch is 409 no_branch", async () => {
    const res = await api("POST", "/tickets/prev-2/preview");
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "no_branch");
  });

  test("an agent-written branch that would read as a git option is refused before git sees it", async () => {
    const res = await api("POST", "/tickets/prev-3/preview");
    assert.equal(res.status, 500);
    assert.match(String(res.body["message"]), /unsafe branch/);
    const slot = (await db.execute("SELECT port_slot FROM tickets WHERE id = 'prev-3'")).rows[0]?.["port_slot"];
    assert.equal(slot, null, "a failed start must not strand its port slot");
  });

  test("shutting the board down stops a running Preview too", async () => {
    const res = await api("POST", "/tickets/prev-1/preview");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const again = String(res.body["url"]);
    await until("the dev server never answered", () => answers(again));
    await server.stop();
    await until("the dev server outlived the board", async () => ((await answers(again)) === null ? true : null));
  });
});
