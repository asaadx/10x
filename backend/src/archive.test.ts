/**
 * Route-level tests for `POST /tickets/:id/archive`: the Done-only guard, the same fail-closed
 * PR-state check `DELETE /tickets/:id` already runs, the `teardown()` reuse (worktree removed,
 * branch deleted for real), and the point of the whole feature — an archived ticket disappears
 * from `listTickets()`/`GET /tickets` while `getTicket(id)` can still resolve it directly,
 * because `SELECT_ONE` is deliberately left unfiltered.
 *
 * Set up the same way `server-pr.test.ts` does: the server under test runs as its own child
 * process, Herdr is a real unix socket (NDJSON, one connection per request, per plan.test.ts
 * and spawn.test.ts), and GitHub is a real local HTTP server queued one response at a time.
 * Branch deletion is real `git`, so it is verified with a real `git branch --list` rather than
 * trusting the app's own claim.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "10x-archive-test-"));
const socketPath = join(dir, "herdr.sock");
const PORT = 4322;
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.HERDR_SOCKET_PATH = socketPath;

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic — see plan.test.ts.
const { db, nowIso } = await import("./db.ts");
const { getTicket } = await import("./ticket-store.ts");

const API_URL = `http://localhost:${PORT}`;
const PROJECT_ID = "archive-test";

// ---------------------------------------------------------------------------
// Fake Herdr: one request per connection, NDJSON, params tracked — same shape as
// spawn.test.ts, because teardown()'s worktree.open/worktree.remove/agent.get conversation is
// itself part of what these tests prove happened.
// ---------------------------------------------------------------------------

type Frame = { result?: unknown; error?: { code: string; message: string } };
type Handler = (params: Record<string, unknown>) => Frame;

const calls: { method: string; params: Record<string, unknown> }[] = [];

const handlers: Record<string, Handler> = {
  "workspace.list": () => ({ result: { type: "workspace_list", workspaces: [] } }),
  "agent.list": () => ({ result: { type: "agent_list", agents: [] } }),
  "worktree.list": () => ({ result: { type: "worktree_list", worktrees: [] } }),
  // Accept has already retired the agent by the time a ticket reaches Done, so teardown's
  // `agent.get` finds nothing — the graceful "agent is already gone" path.
  "agent.get": () => ({ error: { code: "agent_not_found", message: "no such agent" } }),
  "worktree.open": (p) => ({
    result: {
      workspace: { workspace_id: "wARCH" },
      worktree: { path: join(dir, "worktree"), branch: p["branch"] },
    },
  }),
  "worktree.remove": () => ({ result: { type: "worktree_removed" } }),
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
    const params =
      "params" in parsed && typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
    calls.push({ method, params });
    const handler = handlers[method];
    const frame: Frame = handler ? handler(params) : { error: { code: "unknown_method", message: method } };
    socket.end(JSON.stringify({ id: "fake", ...frame }) + "\n");
  });
});
{
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.listen(socketPath, resolve);
  await promise;
}

// ---------------------------------------------------------------------------
// Fake GitHub: a real HTTP server, one queued response consumed per request.
// ---------------------------------------------------------------------------

type GhResponse = { status: number; body: unknown };
let ghQueue: GhResponse[] = [];

const github: HttpServer = createHttpServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const next = ghQueue.shift() ?? { status: 500, body: { message: "no fake GitHub response queued" } };
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
});
const ghPort = await new Promise<number>((resolve) => {
  github.listen(0, "127.0.0.1", () => {
    const addr = github.address();
    resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
  });
});
const GITHUB_URL = `http://127.0.0.1:${ghPort}`;

// ---------------------------------------------------------------------------
// A real repo with a real, committed branch per ticket, so branch deletion can be verified
// with real `git branch --list` rather than trusting the route's own claim.
// ---------------------------------------------------------------------------

const realGit = execFileSync("which", ["git"]).toString().trim();
const repoPath = join(dir, "repo");
mkdirSync(repoPath);
execFileSync(realGit, ["init", "-q", repoPath]);
execFileSync(realGit, ["config", "user.email", "test@example.com"], { cwd: repoPath });
execFileSync(realGit, ["remote", "add", "origin", "https://github.com/acme/proj.git"], { cwd: repoPath });
execFileSync(realGit, ["config", "user.name", "Test"], { cwd: repoPath });
execFileSync(realGit, ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repoPath });

function branchExists(branch: string): boolean {
  const out = execFileSync(realGit, ["-C", repoPath, "branch", "--list", branch]).toString().trim();
  return out !== "";
}

// ---------------------------------------------------------------------------
// The store, seeded directly.
// ---------------------------------------------------------------------------

db.prepare(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run(PROJECT_ID, PROJECT_ID, repoPath, "main", nowIso(), nowIso());

let nextNumber = 1;
function seedTicket(
  id: string,
  over: { status?: string; prNumber?: number | null; prUrl?: string | null; prState?: string | null } = {},
): { id: string; branch: string } {
  const number = nextNumber++;
  const branch = `ticket/${PROJECT_ID}/${number}`;
  execFileSync(realGit, ["-C", repoPath, "branch", branch]);
  db.prepare(
    "INSERT INTO tickets (id, project_id, number, title, description, status, branch, pr_number, pr_url, pr_state, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    PROJECT_ID,
    number,
    `ticket ${id}`,
    "",
    over.status ?? "done",
    branch,
    over.prNumber ?? null,
    over.prUrl ?? null,
    over.prState ?? null,
    nowIso(),
    nowIso(),
  );
  return { id, branch };
}

// ---------------------------------------------------------------------------
// The server child.
// ---------------------------------------------------------------------------

const child = spawn(
  process.execPath,
  ["--import", join(import.meta.dirname, "github-fetch-shim.ts"), join(import.meta.dirname, "server.ts")],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_DIR: dir,
      DB_PATH: join(dir, "10x.db"),
      HERDR_SOCKET_PATH: socketPath,
      GITHUB_TOKEN: "test-token",
      GITHUB_FETCH_SHIM_TARGET: GITHUB_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
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

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function boardIds(): Promise<string[]> {
  const res = await api("GET", `/tickets?project=${PROJECT_ID}`);
  return (res.body["tickets"] as Record<string, unknown>[]).map((t) => t["id"] as string);
}

after(async () => {
  child.kill("SIGTERM");
  for (const socket of sockets) socket.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  await new Promise<void>((r) => {
    github.close(() => r());
  });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("POST /tickets/:id/archive", () => {
  test("archives a Done ticket once the live PR read comes back merged: gone from the board, worktree torn down, branch deleted for real", async () => {
    const { id, branch } = seedTicket("t-merged", {
      status: "done",
      prNumber: 1,
      prUrl: "https://github.com/acme/proj/pull/1",
      prState: null, // never reconciled — forces the live read, same as DELETE's guard
    });
    assert.ok(branchExists(branch));
    ghQueue = [{ status: 200, body: { number: 1, state: "merged", merged: true, additions: 3, deletions: 1 } }];
    const callsBefore = calls.length;

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 200);
    assert.equal(res.body["archived"], true);
    // teardown()'s Herdr conversation actually ran.
    const methods = calls.slice(callsBefore).map((c) => c.method);
    assert.ok(methods.includes("worktree.open"));
    assert.ok(methods.includes("worktree.remove"));
    const removeCall = calls.slice(callsBefore).find((c) => c.method === "worktree.remove");
    assert.equal(removeCall?.params["workspace_id"], "wARCH");
    assert.equal(removeCall?.params["force"], true);
    // Real git: the branch is actually gone, not just claimed gone.
    assert.equal(branchExists(branch), false);
    // Hidden from the board for good.
    assert.ok(!(await boardIds()).includes(id));
  });

  test("refuses a non-Done ticket with 409 not_done, naming the status it found", async () => {
    const { id } = seedTicket("t-in-progress", { status: "in_progress" });

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_done");
    assert.equal(res.body["status"], "in_progress");
    assert.ok((await boardIds()).includes(id));
  });

  test("refuses with 409 pr_open when the live GitHub read says the PR is still open", async () => {
    const { id } = seedTicket("t-open", {
      status: "done",
      prNumber: 2,
      prUrl: "https://github.com/acme/proj/pull/2",
      prState: null,
    });
    ghQueue = [{ status: 200, body: { number: 2, state: "open", merged: false, additions: 5, deletions: 0 } }];

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "pr_open");
    assert.equal(res.body["prNumber"], 2);
    assert.ok((await boardIds()).includes(id));
  });

  test("refuses with 409 pr_state_unknown when the ticket has no recorded pull request", async () => {
    const { id } = seedTicket("t-no-pr", { status: "done" });

    const res = await api("POST", `/tickets/${id}/archive`);

    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "pr_state_unknown");
    assert.ok((await boardIds()).includes(id));
  });

  test("getTicket(id) still resolves an archived ticket by id even though the board no longer lists it", async () => {
    const { id } = seedTicket("t-lookup", {
      status: "done",
      prNumber: 3,
      prUrl: "https://github.com/acme/proj/pull/3",
      prState: "merged", // terminal already, so no live GitHub call is needed here
    });

    const res = await api("POST", `/tickets/${id}/archive`);
    assert.equal(res.status, 200);

    assert.ok(!(await boardIds()).includes(id));
    const direct = getTicket(id);
    assert.equal(direct?.id, id);
    assert.equal(direct?.archived, true);
  });
});
