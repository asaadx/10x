/**
 * Tests for the one thing that decides WHICH commit a ticket's work starts from: `spawn`
 * fetching the project's remote and branching off `origin/<base>` rather than the local base
 * branch (memory/gotchas.md G7).
 *
 * The repositories here are real, and the clone is deliberately two commits behind its
 * upstream, because the bug is invisible to a mock: it is about git refs, and the fix is
 * asserted as refs. Herdr is faked over a real unix socket the way spawn.test.ts fakes it —
 * `worktree.create` is where `base` is observed, so its params ARE the subject.
 *
 * No agent is started for real and nothing binds a TCP port.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDiagnostics } from "./diagnostics.ts";
import { blockFor } from "./ports.ts";
// Type-only, so it erases at runtime and hoisting it above the env assignments is harmless.
import type { RunSpec, RunState } from "./runner.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-base-test-"));
const socketPath = join(dir, "herdr.sock");
process.env.STATE_DIR = dir;
process.env.HERDR_SOCKET_PATH = socketPath;

// Dynamic, not static: runner.ts reads `STATE_DIR` and pulls in herdr.ts, which reads
// `HERDR_SOCKET_PATH`, at module load — a static import would hoist above the two assignments
// above and bind the real Herdr socket.
const { spawn } = await import("./runner.ts");

// ---------------------------------------------------------------------------
// Three real repositories: a bare upstream, a seed checkout that pushes to it, and the clone
// 10x owns. The clone is left behind on purpose — that is the production state this fixes,
// since nothing but `spawn` ever fetches a repo 10x cloned itself.
// ---------------------------------------------------------------------------

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

const upstream = join(dir, "upstream.git");
const seed = join(dir, "seed");
const clone = join(dir, "clone");
/** Its only job is to exist upstream at clone time and be gone by spawn time, proving --prune. */
const DELETED_BRANCH = "abandoned";

git("init", "-q", "--bare", "-b", "main", upstream);
git("init", "-q", "-b", "main", seed);
git("-C", seed, "config", "user.email", "test@10x.invalid");
git("-C", seed, "config", "user.name", "10x test");
git("-C", seed, "commit", "-q", "--allow-empty", "-m", "first");
git("-C", seed, "remote", "add", "origin", upstream);
git("-C", seed, "push", "-q", "origin", "main");
git("-C", seed, "push", "-q", "origin", `main:${DELETED_BRANCH}`);

git("clone", "-q", upstream, clone);
const staleTip = git("-C", clone, "rev-parse", "main");

git("-C", seed, "commit", "-q", "--allow-empty", "-m", "second");
git("-C", seed, "commit", "-q", "--allow-empty", "-m", "third");
git("-C", seed, "push", "-q", "origin", "main");
git("-C", seed, "push", "-q", "origin", "--delete", DELETED_BRANCH);
const upstreamTip = git("-C", seed, "rev-parse", "main");
assert.notEqual(staleTip, upstreamTip, "fixture: the clone must start out behind");

/** A repo whose `origin` cannot be reached at all — an unreachable remote, no network needed. */
const broken = join(dir, "broken");
git("init", "-q", "-b", "main", broken);
git("-C", broken, "remote", "add", "origin", join(dir, "no-such-repo.git"));

const refOrNull = (repo: string, ref: string): string | null => {
  try {
    return git("-C", repo, "rev-parse", "--verify", ref);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The fake Herdr: one request per connection, NDJSON, closed after the reply — except
// `events.subscribe`, which runner.ts treats as long-lived and reopens if it closes.
// ---------------------------------------------------------------------------

type Frame = { result?: unknown; error?: { code: string; message: string } };

let calls: { method: string; params: Record<string, unknown> }[] = [];
/** `origin/main` as it stood when `worktree.create` arrived: ordering, observed from git. */
let originMainAtCreate: string | null = null;

const handlers: Record<string, (params: Record<string, unknown>) => Frame> = {
  "worktree.open": () => ({
    error: { code: "worktree_not_found", message: "no worktree on that branch" },
  }),
  "worktree.create": () => {
    originMainAtCreate = refOrNull(clone, "refs/remotes/origin/main");
    return {
      result: {
        type: "worktree_created",
        workspace: { workspace_id: "wBASE" },
        root_pane: { pane_id: "wBASE:p1" },
        worktree: { path: clone, branch: "ticket/basetest/1" },
      },
    };
  },
  "agent.start": (p) => ({ result: { type: "agent_started", agent: { name: p["name"] } } }),
  "agent.get": () => ({
    result: {
      agent: {
        pane_id: "wBASE:p1",
        workspace_id: "wBASE",
        agent_status: "idle",
        interactive_ready: true,
        agent_session: { value: join(dir, "sessions", "s1", "transcript.jsonl") },
      },
    },
  }),
  "agent.prompt": () => ({ result: { type: "agent_prompted" } }),
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

    // The one connection Herdr does not close: ending it would set runner.ts's reopen
    // backoff running through every later test.
    if (method === "events.subscribe") {
      socket.write(JSON.stringify({ id: "fake", result: { type: "subscription_started" } }) + "\n");
      return;
    }

    const handler = handlers[method];
    const frame: Frame = handler
      ? handler(params)
      : { error: { code: "unknown_method", message: method } };
    socket.end(JSON.stringify({ id: "fake", ...frame }) + "\n");
  });
});
{
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.listen(socketPath, resolve);
  await promise;
}

const runSpec = (over: Partial<RunSpec> = {}): RunSpec => ({
  projectId: "basetest",
  number: 1,
  title: "Base off the upstream tip",
  description: "",
  taskBreakdown: [],
  acceptanceCriteria: [],
  repoPath: clone,
  base: "main",
  apiUrl: "http://localhost:4010",
  ...over,
});

const started: RunState[] = [];
async function start(spec: RunSpec) {
  const state: RunState = { diagnostics: freshDiagnostics(), sessionDir: null };
  started.push(state);
  await spawn(
    spec,
    blockFor(3),
    state,
    () => {},
    () => {},
  );
  return state;
}

after(async () => {
  for (const state of started) {
    state.stream?.close();
    state.stream = undefined;
  }
  for (const socket of sockets) socket.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("spawn refreshes the base before creating the worktree", () => {
  test("fetches origin first, then branches off origin/<base>", async () => {
    calls = [];
    await start(runSpec());

    // What Herdr is asked for. `origin/main`, not `main`: verified live, `base: "main"` lands
    // the worktree on the stale commit (memory/gotchas.md G7).
    const create = calls.find((c) => c.method === "worktree.create")?.params;
    assert.equal(create?.["base"], "origin/main");
    assert.equal(create?.["cwd"], clone);

    // The fetch, proven by refs rather than by trusting the call order: `origin/main` was
    // already at the upstream tip by the time `worktree.create` arrived.
    assert.equal(originMainAtCreate, upstreamTip);
    assert.equal(refOrNull(clone, "refs/remotes/origin/main"), upstreamTip);

    // And the local base branch is deliberately NOT moved. Fast-forwarding it is impossible
    // here — it is checked out, so git refuses `fetch origin main:main` — which is the whole
    // reason the remote-tracking ref is what gets branched off.
    assert.equal(refOrNull(clone, "refs/heads/main"), staleTip);

    // --prune, not a bare fetch: a branch deleted upstream leaves no ref behind to be
    // branched off by a project whose base branch was renamed.
    assert.equal(refOrNull(clone, `refs/remotes/origin/${DELETED_BRANCH}`), null);
  });

  test("an unreachable remote fails the spawn instead of producing a stale worktree", async () => {
    calls = [];

    // Same shape as a refused Herdr call: `spawn` rejects, server.ts rolls the claim and the
    // port slot back. Silently branching off whatever the clone happens to hold would be a
    // ticket built on the wrong code, which is worse than a Start that visibly did not happen.
    await assert.rejects(
      () => start(runSpec({ repoPath: broken })),
      /fetch --prune origin|does not appear to be a git repository/,
    );

    assert.deepEqual(calls.map((c) => c.method), ["worktree.open"]);
  });
});
