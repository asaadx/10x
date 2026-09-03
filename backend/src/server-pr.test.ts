/**
 * Route-level tests for the two PR-metadata mechanisms: Accept capturing state/LOC straight
 * off the create response with no follow-up call (github.ts's widened `PullRequest`), and
 * board()'s reconcile-on-read backfilling a stale/never-seen state, cached for
 * `PR_CHECK_TTL_MS` so a one-second poll does not hit GitHub on every tick.
 *
 * GitHub is faked the way Herdr already is in this suite — a real listener, not a stubbed
 * module: `github-fetch-shim.ts` is loaded into the child's process via `node --import` and
 * redirects `https://api.github.com/...` to the local HTTP server below, and a real `git` shim
 * on `PATH` no-ops `git push` to github.com (the URL is reconstructed as a literal
 * `…@github.com/...` inside github.ts, so nothing short of intercepting `git` itself lets
 * Accept's push step succeed with no real network) while delegating every other subcommand —
 * `git remote get-url origin`, in particular — to the real binary. The server under test runs
 * as its own child process, the same shape `plan.test.ts` and `spawn.test.ts` already use.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "10x-server-pr-test-"));
const socketPath = join(dir, "herdr.sock");
const PORT = 4320;
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.HERDR_SOCKET_PATH = socketPath;

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic — see plan.test.ts.
const { db, nowIso } = await import("./db.ts");

const API_URL = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Fake Herdr: one request per connection, NDJSON — identical shape to plan.test.ts.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fake GitHub: a real HTTP server, one queued response consumed per request. `github.ts`'s
// hardcoded `https://api.github.com` base is never touched — `github-fetch-shim.ts` rewrites
// it inside the child process.
// ---------------------------------------------------------------------------

type GhResponse = { status: number; body: unknown };
let ghQueue: GhResponse[] = [];
const ghCalls: { method: string; path: string }[] = [];

const github: HttpServer = createHttpServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += String(c);
  });
  req.on("end", () => {
    ghCalls.push({ method: req.method ?? "", path: req.url ?? "" });
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
// A real `git` on PATH that no-ops `push` and delegates every other subcommand for real.
// ---------------------------------------------------------------------------

const realGit = execFileSync("which", ["git"]).toString().trim();
const shimDir = join(dir, "git-shim");
mkdirSync(shimDir);
const pushLog = join(dir, "git-push.log");
writeFileSync(
  join(shimDir, "git"),
  `#!/bin/sh\nif [ "$1" = "push" ]; then\n  echo "$@" >> "${pushLog}"\n  exit 0\nfi\nexec "${realGit}" "$@"\n`,
);
chmodSync(join(shimDir, "git"), 0o755);

// A real repo, only so `git remote get-url origin` has something to read.
const repoPath = join(dir, "repo");
mkdirSync(repoPath);
execFileSync(realGit, ["init", "-q", repoPath]);
execFileSync(realGit, ["remote", "add", "origin", "https://github.com/acme/proj.git"], { cwd: repoPath });

// ---------------------------------------------------------------------------
// The store, seeded directly. Two projects: `dueForCheck` in board() is only ever computed
// from the already project-filtered ticket list, so scoping each describe's board() calls to
// its own project keeps the two mechanisms under test from racing the same fake-GitHub queue.
// ---------------------------------------------------------------------------

const ACCEPT_PROJECT = "pr-accept-test";
const RECONCILE_PROJECT = "pr-reconcile-test";
for (const id of [ACCEPT_PROJECT, RECONCILE_PROJECT]) {
  db.prepare(
    "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, id, repoPath, "main", nowIso(), nowIso());
}

function seedTicket(
  id: string,
  projectId: string,
  number: number,
  over: { status?: string; branch?: string | null; prNumber?: number | null; prUrl?: string | null; prState?: string | null } = {},
): void {
  db.prepare(
    "INSERT INTO tickets (id, project_id, number, title, description, status, branch, pr_number, pr_url, pr_state, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    projectId,
    number,
    `ticket ${id}`,
    "",
    over.status ?? "in_review",
    over.branch ?? `ticket-${projectId}-${number}`,
    over.prNumber ?? null,
    over.prUrl ?? null,
    over.prState ?? null,
    nowIso(),
    nowIso(),
  );
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
      PATH: `${shimDir}:${process.env.PATH}`,
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

describe("POST /tickets/:id/accept captures PR metadata from the create response", () => {
  test("prState/prAdditions/prDeletions are populated in the accept response itself — one call, no follow-up read", async () => {
    seedTicket("t-accept", ACCEPT_PROJECT, 1, { status: "in_review" });
    ghQueue = [
      {
        status: 201,
        body: {
          number: 501,
          html_url: "https://github.com/acme/proj/pull/501",
          state: "open",
          merged: false,
          additions: 14,
          deletions: 2,
        },
      },
    ];
    const callsBefore = ghCalls.length;
    const res = await api("POST", "/tickets/t-accept/accept");
    assert.equal(res.status, 200);
    assert.equal(res.body["prNumber"], 501);
    assert.equal(res.body["prUrl"], "https://github.com/acme/proj/pull/501");
    assert.equal(res.body["prState"], "open");
    assert.equal(res.body["prAdditions"], 14);
    assert.equal(res.body["prDeletions"], 2);
    // Exactly one fake-GitHub call — the create POST. No GET .../pulls/501 was needed to see it.
    assert.equal(ghCalls.length - callsBefore, 1);
    assert.equal(ghCalls[callsBefore]?.method, "POST");
  });
});

describe("board() reconciles PR state on read", () => {
  test("backfills a ticket whose prState is null — the pre-existing case — with one live read", async () => {
    seedTicket("t-backfill", RECONCILE_PROJECT, 2, {
      status: "done",
      prNumber: 900,
      prUrl: "https://github.com/acme/proj/pull/900",
      prState: null,
    });
    ghQueue = [{ status: 200, body: { number: 900, state: "open", merged: false, additions: 7, deletions: 1 } }];
    const callsBefore = ghCalls.length;
    const res = await api("GET", `/tickets?project=${RECONCILE_PROJECT}`);
    assert.equal(res.status, 200);
    const tickets = res.body["tickets"] as Record<string, unknown>[];
    const t = tickets.find((x) => x["id"] === "t-backfill");
    assert.equal(t?.["prState"], "open");
    assert.equal(t?.["prAdditions"], 7);
    assert.equal(t?.["prDeletions"], 1);
    assert.equal(ghCalls.length - callsBefore, 1);
  });

  test("a ticket already checked within the TTL window is not re-fetched", async () => {
    // Queued response WOULD change the stored value if consumed — if the cache works this is
    // left in the queue untouched, and the board keeps serving the value the prior test read.
    ghQueue = [{ status: 200, body: { number: 900, state: "merged", merged: true, additions: 99, deletions: 99 } }];
    const callsBefore = ghCalls.length;
    const res = await api("GET", `/tickets?project=${RECONCILE_PROJECT}`);
    const tickets = res.body["tickets"] as Record<string, unknown>[];
    const t = tickets.find((x) => x["id"] === "t-backfill");
    assert.equal(t?.["prState"], "open");
    assert.equal(t?.["prAdditions"], 7);
    assert.equal(ghCalls.length - callsBefore, 0);
  });
});
