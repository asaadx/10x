/**
 * Route-level tests for the plug-and-play project surface: the lookup admission test, creating a
 * project from a remote alone, immutability of the fields a project's identity is built from,
 * and the guard that stops a ticket being started against a project whose repo is not on disk
 * yet.
 *
 * Same shape as `server-pr.test.ts`: the server runs as its own child process with a fake Herdr
 * on a unix socket and `github-fetch-shim.ts` redirecting `https://api.github.com/...` to a
 * local listener, so nothing here touches the network or a real repository.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "10x-project-routes-test-"));
const socketPath = join(dir, "herdr.sock");
// Unique across the suite: node:test runs these files concurrently, and two servers sharing a
// port means one answers the other's requests against the wrong database. 4310 is e2e's.
const PORT = 4324;
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.HERDR_SOCKET_PATH = socketPath;

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic — see plan.test.ts.
const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

const API_URL = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Fake Herdr. Nothing here spawns an agent; these handlers exist so boot
// reconciliation finds an empty world and the child comes up.
// ---------------------------------------------------------------------------

const handlers: Record<string, () => { result: unknown }> = {
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
    const parsed = JSON.parse(line) as { method?: string };
    const handler = parsed.method === undefined ? undefined : handlers[parsed.method];
    socket.end(
      JSON.stringify(handler ? handler() : { error: { code: "unhandled", message: line } }) + "\n",
    );
  });
});
{
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.listen(socketPath, resolve);
  await promise;
}

// ---------------------------------------------------------------------------
// Fake GitHub. `GET /repos/:owner/:repo` is the admission test; the answer is
// switchable per test so the failure paths are reachable.
// ---------------------------------------------------------------------------

let repoReply: { status: number; body: unknown } = {
  status: 200,
  body: {
    name: "widgets",
    description: "Widget factory",
    default_branch: "trunk",
    private: true,
    owner: { login: "acme" },
  },
};

const github: HttpServer = createHttpServer((req, res) => {
  res.writeHead(repoReply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(repoReply.body));
});
{
  const { promise, resolve } = Promise.withResolvers<void>();
  github.listen(0, "127.0.0.1", resolve);
  await promise;
}
const githubAddress = github.address();
if (githubAddress === null || typeof githubAddress === "string") {
  throw new Error("fake github did not bind a port");
}
const GITHUB_URL = `http://127.0.0.1:${githubAddress.port}`;

// ---------------------------------------------------------------------------
// A `git` on PATH that answers `ls-remote` locally and delegates everything else.
//
// The lookup route's emptiness probe is `git ls-remote --heads <github url>`, deliberately, so
// that a repo with no commits is detected from refs rather than from GitHub's `default_branch`
// — which is a setting, and is reported even when that branch does not exist (gotchas G8). That
// URL is built inside provision.ts, so nothing short of intercepting `git` keeps this test off
// the network. `EMPTY_REMOTE` flips it between "has commits" and "no commits".
// ---------------------------------------------------------------------------

const realGit = execFileSync("which", ["git"]).toString().trim();
const shimDir = join(dir, "git-shim");
mkdirSync(shimDir);
const emptyFlag = join(dir, "remote-is-empty");
writeFileSync(
  join(shimDir, "git"),
  `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "ls-remote" ]; then
    if [ -f "${emptyFlag}" ]; then exit 0; fi
    echo "1111111111111111111111111111111111111111\trefs/heads/main"
    exit 0
  fi
done
exec "${realGit}" "$@"
`,
);
chmodSync(join(shimDir, "git"), 0o755);

// ---------------------------------------------------------------------------
// A project seeded the old way, so the provisioning guard has something ready
// to contrast against, plus one ticket per state the guard cares about.
// ---------------------------------------------------------------------------

const readyRepo = join(dir, "ready-repo");
mkdirSync(readyRepo);
execFileSync("git", ["init", "-q", readyRepo]);
execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/ready.git"], {
  cwd: readyRepo,
});

await db.execute(
  `INSERT INTO projects (id, name, description, owner, repo, repo_path, base_branch,
                         provision_state, provision_error, created_at, updated_at)
   VALUES (?, ?, '', 'acme', 'ready', ?, 'main', 'ready', '', ?, ?)`,
  ["readyproj", "Ready", readyRepo, nowIso(), nowIso()],
);

await db.execute(
  `INSERT INTO projects (id, name, description, owner, repo, repo_path, base_branch,
                         provision_state, provision_error, created_at, updated_at)
   VALUES (?, ?, '', 'acme', 'cloning', ?, 'main', 'cloning', '', ?, ?)`,
  ["cloningproj", "Cloning", join(dir, "not-there-yet"), nowIso(), nowIso()],
);

const seedTicket = async (id: string, projectId: string, number: number, status: string): Promise<void> => {
  await db.execute(
    `INSERT INTO tickets (id, project_id, number, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
    [id, projectId, number, `ticket ${id}`, status, nowIso(), nowIso()],
  );
};
await seedTicket("cloningproj-1", "cloningproj", 1, "todo");
await seedTicket("cloningproj-2", "cloningproj", 2, "backlog");

// A project whose clone already lives where 10x would put one — the case the delete route
// must actually remove.
const projectsRoot = join(dir, "repos");
const ownedRepo = join(projectsRoot, "ownedclone");
mkdirSync(ownedRepo, { recursive: true });
writeFileSync(join(ownedRepo, "sentinel"), "10x's own clone\n");

await db.execute(
  `INSERT INTO projects (id, name, description, owner, repo, repo_path, base_branch,
                         provision_state, provision_error, created_at, updated_at)
   VALUES (?, ?, '', 'acme', 'ownedclone', ?, 'main', 'ready', '', ?, ?)`,
  ["ownedclone", "Owned clone", ownedRepo, nowIso(), nowIso()],
);

// A project that predates this feature: its `repo_path` is a folder the user pointed 10x at
// directly, sitting outside `PROJECTS_ROOT` entirely — the migration backfills identity without
// ever moving it there (db.ts's `backfillProjectIdentity`).
const alienRepo = join(dir, "alien-repo");
mkdirSync(alienRepo, { recursive: true });
writeFileSync(join(alienRepo, "sentinel"), "the user's own checkout\n");

await db.execute(
  `INSERT INTO projects (id, name, description, owner, repo, repo_path, base_branch,
                         provision_state, provision_error, created_at, updated_at)
   VALUES (?, ?, '', 'acme', 'alien', ?, 'main', 'ready', '', ?, ?)`,
  ["alienclone", "Alien clone", alienRepo, nowIso(), nowIso()],
);

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
      PROJECTS_ROOT: join(dir, "repos"),
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
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /projects/lookup is the admission test", () => {
  test("a readable repo answers with the metadata the dialog needs, not just ok", async () => {
    repoReply = {
      status: 200,
      body: {
        name: "widgets",
        description: "Widget factory",
        default_branch: "trunk",
        private: true,
        owner: { login: "acme" },
      },
    };
    const res = await api("GET", "/projects/lookup?remote=https://github.com/acme/widgets");
    assert.equal(res.status, 200);
    assert.equal(res.body["owner"], "acme");
    assert.equal(res.body["repo"], "widgets");
    assert.equal(res.body["description"], "Widget factory");
    // Not "main": the dialog must show the repo's real default, or the first worktree is
    // created off a branch that does not exist.
    assert.equal(res.body["defaultBranch"], "trunk");
    assert.equal(res.body["private"], true);
  });

  test("a non-GitHub host is refused with its own code, before any network call", async () => {
    const res = await api("GET", "/projects/lookup?remote=https://gitlab.com/acme/widgets");
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "invalid_remote");
  });

  test("a repo the token cannot see is distinguishable from one that does not exist", async () => {
    repoReply = { status: 404, body: { message: "Not Found" } };
    const missing = await api("GET", "/projects/lookup?remote=https://github.com/acme/ghost");
    assert.equal(missing.status, 404);
    assert.equal(missing.body["error"], "repo_not_found");

    repoReply = { status: 403, body: { message: "Forbidden" } };
    const forbidden = await api("GET", "/projects/lookup?remote=https://github.com/acme/secret");
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body["error"], "repo_not_accessible");
  });

  test("a brand-new repo with no commits reports empty, despite GitHub naming a default branch", async () => {
    // The case a user testing 10x with a fresh repo hits first. GitHub reports
    // default_branch: "main" for a commitless repo, but that branch does not exist as a ref, so
    // the first worktree would fail with `invalid reference: main` (gotchas G8). Emptiness
    // therefore comes from ls-remote returning no refs, never from this field.
    repoReply = {
      status: 200,
      body: { name: "fresh", description: null, default_branch: "main", private: false, owner: { login: "acme" } },
    };
    writeFileSync(emptyFlag, "");
    try {
      const res = await api("GET", "/projects/lookup?remote=https://github.com/acme/fresh");
      assert.equal(res.status, 200);
      assert.equal(res.body["defaultBranch"], "main");
      assert.equal(res.body["empty"], true);
    } finally {
      rmSync(emptyFlag, { force: true });
    }
  });

  test("a repo that does have commits reports empty false", async () => {
    repoReply = {
      status: 200,
      body: { name: "widgets", description: null, default_branch: "main", private: false, owner: { login: "acme" } },
    };
    const res = await api("GET", "/projects/lookup?remote=https://github.com/acme/widgets");
    assert.equal(res.status, 200);
    assert.equal(res.body["empty"], false);
  });

  test("a browser-pasted URL with a /tree suffix and a trailing slash still resolves", async () => {
    repoReply = {
      status: 200,
      body: { name: "widgets", description: null, default_branch: "main", private: false, owner: { login: "acme" } },
    };
    const res = await api("GET", "/projects/lookup?remote=https://github.com/acme/widgets/tree/main/");
    assert.equal(res.status, 200);
    assert.equal(res.body["repo"], "widgets");
    // A null description must arrive as a string, or the dialog prefills "null".
    assert.equal(res.body["description"], "");
  });
});

describe("POST /projects takes a remote, and derives the rest", () => {
  test("the slug, repo path and identity are all derived from the remote alone", async () => {
    repoReply = {
      status: 200,
      body: { name: "hearth-home-automation", description: "", default_branch: "main", private: false, owner: { login: "acme" } },
    };
    const res = await api("POST", "/projects", {
      remote: "https://github.com/acme/hearth-home-automation",
      name: "Hearth",
      description: "Home automation brain",
    });
    assert.equal(res.status, 201);
    // Word-boundary truncation, not a 20-char slice: `hearth-home-automati` would read as a typo
    // and lands in every branch name this project ever creates.
    assert.equal(res.body["id"], "hearth-home");
    assert.equal(res.body["owner"], "acme");
    assert.equal(res.body["repo"], "hearth-home-automation");
    assert.equal(res.body["repoPath"], join(dir, "repos", "hearth-home"));
    assert.equal(res.body["description"], "Home automation brain");
  });

  test("a caller-supplied repoPath is refused rather than quietly obeyed", async () => {
    const res = await api("POST", "/projects", {
      remote: "https://github.com/acme/other",
      name: "Other",
      repoPath: "/tmp/somewhere-else",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "immutable_field");
  });

  test("a non-GitHub remote cannot create a project at all", async () => {
    const res = await api("POST", "/projects", {
      remote: "/home/me/local-only-repo",
      name: "Local",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "invalid_remote");
  });
});

describe("PATCH /projects/:id keeps identity fixed and prose free", () => {
  test("name and description are editable", async () => {
    const res = await api("PATCH", "/projects/readyproj", {
      name: "Renamed",
      description: "Now with a description",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body["name"], "Renamed");
    assert.equal(res.body["description"], "Now with a description");
  });

  test("repoPath is derived, so changing it is refused", async () => {
    const res = await api("PATCH", "/projects/readyproj", { repoPath: "/tmp/elsewhere" });
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "immutable_field");
  });

  test("a healthy project cannot be repointed at another repo — its PRs would be orphaned", async () => {
    const res = await api("PATCH", "/projects/readyproj", { owner: "someone", repo: "else" });
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "immutable_field");
  });
});

describe("starting work needs a repository on disk", () => {
  test("spawn is refused while the repo is still downloading, and says which state", async () => {
    const res = await api("POST", "/tickets/cloningproj-1/spawn");
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "project_not_provisioned");
    assert.equal(res.body["provisionState"], "cloning");
  });

  test("the refusal does not move the ticket — the guard runs before the claim", async () => {
    const board = await fetch(`${API_URL}/tickets?project=cloningproj`).then((r) => r.json());
    const tickets = (board as { tickets: { id: string; status: string }[] }).tickets;
    const ticket = tickets.find((t) => t.id === "cloningproj-1");
    assert.ok(ticket);
    assert.equal(ticket.status, "todo");
  });

  test("planning is refused for the same reason", async () => {
    const res = await api("POST", "/tickets/cloningproj-2/plan");
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "project_not_provisioned");
  });
});


describe("DELETE /projects/:id only removes a clone 10x actually owns", () => {
  test("a repo_path under PROJECTS_ROOT is removed along with the project", async () => {
    assert.ok(existsSync(ownedRepo));
    const res = await api("DELETE", "/projects/ownedclone");
    assert.equal(res.status, 200);
    assert.equal(res.body["ok"], true);
    assert.equal(res.body["warnings"], undefined);
    assert.equal(existsSync(ownedRepo), false);
    assert.equal((await api("GET", "/projects/lookup?remote=x")).status, 400); // server still alive
  });

  test("a repo_path outside PROJECTS_ROOT — a project that predates this feature — is left in place", async () => {
    assert.ok(existsSync(alienRepo));
    const res = await api("DELETE", "/projects/alienclone");
    assert.equal(res.status, 200);
    assert.equal(res.body["ok"], true);
    // The project row is still gone even though its folder was not 10x's to remove.
    assert.ok(Array.isArray(res.body["warnings"]));
    assert.match((res.body["warnings"] as string[])[0] ?? "", /predates 10x/);
    assert.equal(existsSync(alienRepo), true);
    assert.equal(readFileSync(join(alienRepo, "sentinel"), "utf8"), "the user's own checkout\n");
  });
});
