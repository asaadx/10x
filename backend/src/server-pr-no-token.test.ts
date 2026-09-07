/**
 * `GITHUB_TOKEN` must be a separate process from `server-pr.test.ts`'s, not a second scenario
 * inside it: `env.ts` (the first import of `server.ts`) loads the repo-root `.env` — which, in
 * this checkout, holds a real `GITHUB_TOKEN` — and `loadEnvFile` only skips a variable already
 * present in the environment. So "missing token" here means an explicit empty string, not an
 * omitted key: an omitted key would still get filled in from `.env` inside the child.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "10x-server-pr-no-token-test-"));
const socketPath = join(dir, "herdr.sock");
const PORT = 4321;
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.HERDR_SOCKET_PATH = socketPath;

const { db, nowIso } = await import("./db.ts");

const API_URL = `http://localhost:${PORT}`;
const PROJECT_ID = "pr-no-token-test";

// Fake Herdr — same shape as server-pr.test.ts and plan.test.ts.
type Frame = { result?: unknown; error?: { code: string; message: string } };
type Handler = () => Frame;
const handlers: Record<string, Handler> = {
  "workspace.list": () => ({ result: { type: "workspace_list", workspaces: [] } }),
  "agent.list": () => ({ result: { type: "agent_list", agents: [] } }),
  "worktree.list": () => ({ result: { type: "worktree_list", worktrees: [] } }),
};
const sockets: Socket[] = [];
const herdr: Server = createServer((socket) => {
  sockets.push(socket);
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    buf = "";
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("method" in parsed)) {
      socket.end(JSON.stringify({ error: { code: "bad_frame", message: line } }) + "\n");
      return;
    }
    const method = String(parsed.method);
    const handler = handlers[method];
    const frame: Frame = handler ? handler() : { error: { code: "unknown_method", message: method } };
    socket.end(JSON.stringify({ id: "fake", ...frame }) + "\n");
  });
});
{
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.listen(socketPath, resolve);
  await promise;
}

// `owner`/`repo` stated explicitly: PR reads take the project's identity from these columns
// now, and this fixture has no repo on disk for the startup backfill to read a remote from.
db.prepare(
  `INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, provision_state, created_at, updated_at)
   VALUES (?, ?, 'acme', 'proj', ?, ?, 'ready', ?, ?)`,
).run(PROJECT_ID, PROJECT_ID, "/tmp/does-not-need-to-exist", "main", nowIso(), nowIso());

// A ticket already carrying a PR number but never reconciled — the pre-existing case, what
// `10x-1` had before this change — with a non-terminal, never-checked `prState`.
db.prepare(
  "INSERT INTO tickets (id, project_id, number, title, description, status, branch, pr_number, pr_url, pr_state, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
).run("t-no-token", PROJECT_ID, 1, "ticket t-no-token", "", "done", "ticket-no-token-1", 42, "https://github.com/acme/proj/pull/42", null, nowIso(), nowIso());

const child = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: dir,
    DB_PATH: join(dir, "10x.db"),
    HERDR_SOCKET_PATH: socketPath,
    // Present but empty, not omitted — see the file doc comment above.
    GITHUB_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (c: unknown) => {
  serverLog += String(c);
});
child.stderr.on("data", (c: unknown) => {
  serverLog += String(c);
});

{
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${API_URL}/projects`).then((r) => r.text());
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`server never came up: ${serverLog}\n${err}`);
      await delay(100);
    }
  }
}

after(async () => {
  child.kill("SIGTERM");
  for (const socket of sockets) socket.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("board() without GITHUB_TOKEN", () => {
  test("degrades to today's behavior — a null prState stays null instead of the request failing", async () => {
    const res = await fetch(`${API_URL}/tickets?project=${PROJECT_ID}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tickets: Record<string, unknown>[] };
    const t = body.tickets.find((x) => x["id"] === "t-no-token");
    assert.equal(t?.["prNumber"], 42);
    assert.equal(t?.["prState"], null);
    assert.equal(t?.["prAdditions"], null);
    assert.equal(t?.["prDeletions"], null);
  });
});
