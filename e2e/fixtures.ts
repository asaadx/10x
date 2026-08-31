/**
 * E2E fixtures: a backend on a throwaway state dir, throwaway git repos, the Herdr
 * preflight, and the spawn helpers the agent-lifecycle specs share. Everything created
 * here is registered for `cleanupAll()`, which every spec calls from `afterAll` so a
 * failed run leaves nothing behind — no worktree, no branch, no agent, no transcript.
 */
import { expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HerdrError, request } from "../src/herdr.ts";

const git = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * 4310 avoids two ranges that are already spoken for: the real board runs on 4010, and
 * 4100-4199 is the per-ticket dev-server pool (memory/architecture.md).
 */
const PORT = 4310;

const READY_TIMEOUT_MS = 15_000;

export type Board = { baseUrl: string; stop(): Promise<void> };

/** Temp dirs and live servers this run owns, drained by `cleanupAll`. */
const tempDirs: string[] = [];
/** Repos from `makeRepo`, kept apart because each leaves a Herdr source workspace behind. */
const repos: string[] = [];
const running = new Set<Board>();

/**
 * Where each board keeps its SQLite file. `storedTicket` needs it because GET /tickets
 * derives `branch` and `agentName` when the columns are null, so the API cannot tell
 * "cleared" from "set".
 */
const stateDirs = new WeakMap<Board, string>();

const HERDR_SOCKET =
  process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");

/**
 * Preflight. Without Herdr the spawn and teardown paths fail as socket connection errors
 * deep inside a request, which reads as a mystery timeout rather than a missing dependency.
 */
export function requireHerdr(): void {
  if (existsSync(HERDR_SOCKET)) return;
  throw new Error(
    `no Herdr socket at ${HERDR_SOCKET} — Herdr must be running for the e2e suite. ` +
      "Start it, or point HERDR_SOCKET_PATH at a live socket.",
  );
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function startBoard(): Promise<Board> {
  return boardOn(await tempDir("10x-e2e-state-"));
}

/**
 * A new backend on the SAME state dir and database — which is what a restart is. Herdr keeps
 * the panes and agents running while only our store comes back, so a fresh state dir would
 * prove nothing about reconciliation.
 */
export async function restartBoard(board: Board): Promise<Board> {
  const stateDir = stateDirs.get(board);
  if (stateDir === undefined) throw new Error("that board did not come from startBoard()");
  await board.stop();
  return boardOn(stateDir);
}

async function boardOn(stateDir: string): Promise<Board> {
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_DIR: stateDir,
      DB_PATH: join(stateDir, "10x.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so `stop()` can signal the whole tree: the server shells out
    // to git during teardown and an orphaned child would hold the port.
    detached: true,
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn `node src/server.ts`");

  // Kept so a startup failure reports what the server said instead of just "timed out".
  let log = "";
  const collect = (chunk: unknown) => {
    log += String(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const exit = Promise.withResolvers<void>();
  child.on("exit", () => exit.resolve());
  child.on("error", (err) => {
    log += `spawn error: ${err.message}\n`;
    exit.resolve();
  });

  const baseUrl = `http://127.0.0.1:${PORT}`;
  const board: Board = {
    baseUrl,
    async stop() {
      running.delete(board);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          // Negative pid: the group, not just the leader.
          process.kill(-pid, "SIGTERM");
        } catch (err) {
          console.warn(`could not signal 10x server group ${pid}:`, err);
        }
      }
      await exit.promise;
    },
  };
  running.add(board);
  stateDirs.set(board, stateDir);

  let lastProbeError = "never reached";
  const probe = async (): Promise<number | undefined> => {
    try {
      const res = await fetch(`${baseUrl}/projects`);
      await res.text();
      return res.status;
    } catch (err) {
      // ECONNREFUSED until the listener binds. Recorded rather than logged: the deadline
      // below is what turns a persistent failure into a message.
      lastProbeError = err instanceof Error ? err.message : String(err);
      return undefined;
    }
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await board.stop();
      throw new Error(`10x server exited before becoming ready:\n${log}`);
    }
    if ((await probe()) === 200) return board;
    await delay(100);
  }

  await board.stop();
  throw new Error(
    `10x server did not answer GET ${baseUrl}/projects within ${READY_TIMEOUT_MS}ms ` +
      `(last probe: ${lastProbeError}):\n${log}`,
  );
}

export async function makeRepo(): Promise<string> {
  const dir = await tempDir("10x-e2e-repo-");
  await git("git", ["init", "-q"], { cwd: dir });
  // Local, because CI has no global git identity and the initial commit below needs one.
  await git("git", ["config", "user.email", "e2e@10x.invalid"], { cwd: dir });
  await git("git", ["config", "user.name", "10x e2e"], { cwd: dir });
  await git("git", ["commit", "-q", "--allow-empty", "-m", "chore: initial commit"], { cwd: dir });
  /*
   * `dev`, not the git default. A project's `baseBranch` defaults to `main` and is only
   * handed to git at spawn time, so registering a project whose base branch does not exist
   * succeeds and then fails much later. Specs register with `baseBranch: "dev"` explicitly.
   */
  await git("git", ["branch", "-M", "dev"], { cwd: dir });
  repos.push(dir);
  return dir;
}

export async function cleanupAll(): Promise<void> {
  // Spawns first, and through the product's own destructive teardown wherever possible:
  // that is the only path that kills the agent, the pane, the worktree, the branch and the
  // OMP transcript together. Everything below destroys the state it needs to do that.
  await drainSpawns();
  // Servers next: a live one holds an open SQLite handle inside the state dir it is about
  // to lose, and it would keep the port for the next spec file.
  await Promise.all([...running].map((board) => board.stop()));
  // Source workspaces before the repos they point at: they are matched on path.
  await closeSourceWorkspaces();
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await pruneWorktreeParents();
}

// ---------------------------------------------------------------------------
// Spawn support. Everything below drives REAL agents in REAL worktrees, so anything that
// creates one registers it for `cleanupAll` before it can fail.
// ---------------------------------------------------------------------------

/**
 * The canned agent task. Asserting the agent's OWN output is deliberate: our side effects
 * alone cannot distinguish "prompt delivered and agent worked" from "prompt silently lost",
 * and the second has already shipped here — `agent.start` returns before the agent can
 * accept a prompt (memory/spawn.md).
 */
export const PROBE_FILE = "probe.txt";
export const PROBE_CONTENT = "ok";
export const PROBE_DESCRIPTION =
  `Create a file named ${PROBE_FILE} in the root of this worktree, whose entire content is ` +
  `the two characters: ${PROBE_CONTENT}\n` +
  "Create no other file and change nothing else, then commit.";

/** A spawn this run must tear down. Filled in as the spawn progresses, never guessed. */
type Spawn = { baseUrl: string; repoPath: string; ticketId: string; branch: string; sessionDir: string | null };

const spawns: Spawn[] = [];
/** `dirname(worktreePath)` — Herdr's per-repo folder, which it leaves behind when empty. */
const worktreeParents = new Set<string>();

/**
 * DELETE runs the product's destructive teardown (memory/teardown.md): agent stopped, pane
 * closed, worktree force-removed, branch deleted, transcript removed. Any other answer means
 * the backend is gone or the test already tore this ticket down, so fall through to Herdr.
 *
 * Serial, not `Promise.all`: the backend rejects a second operation on the same ticket with
 * `operation_in_flight`, and two teardowns in one repo would race git.
 */
async function drainSpawns(): Promise<void> {
  for (const entry of spawns.splice(0, spawns.length)) {
    const url = `${entry.baseUrl}/tickets/${encodeURIComponent(entry.ticketId)}`;
    const deleted = await fetch(url, { method: "DELETE" }).then((res) => res.ok, () => false);
    if (!deleted) await sweep(entry);
  }
}

/**
 * Last-resort teardown, straight at Herdr. Resolving by branch works whether the workspace
 * is open, was closed behind our back, or never existed, and removing the worktree takes the
 * pane and the agent's whole process tree with it (memory/teardown.md).
 */
async function sweep(entry: Spawn): Promise<void> {
  try {
    const opened = await request<{ workspace: { workspace_id: string } }>("worktree.open", {
      cwd: entry.repoPath, branch: entry.branch, focus: false,
    });
    await request("worktree.remove", { workspace_id: opened.workspace.workspace_id, force: true });
  } catch (err) {
    // `worktree_not_found` is the "already clean" signal, not a failure.
    if (!(err instanceof HerdrError) || err.code !== "worktree_not_found") {
      console.warn(`e2e cleanup: could not remove the worktree on ${entry.branch}:`, err);
    }
  }
  // The transcript lives outside the worktree and survives its removal.
  if (entry.sessionDir) await rm(entry.sessionDir, { recursive: true, force: true });
}

/**
 * `~/.herdr/worktrees/<repo>/` survives the last worktree under it, and each throwaway repo
 * is a fresh `mkdtemp` name, so it would accumulate one empty folder per e2e run. `rmdir`
 * refuses a non-empty directory, which is the safety we want: a surviving checkout has to be
 * reported, never quietly deleted.
 */
async function pruneWorktreeParents(): Promise<void> {
  for (const dir of worktreeParents) {
    if (!existsSync(dir)) continue;
    try {
      await rmdir(dir);
    } catch (err) {
      console.warn(`e2e cleanup: ${dir} is not empty — something was left behind:`, err);
    }
  }
  worktreeParents.clear();
}

type WorkspaceRow = {
  workspace_id: string;
  worktree?: { checkout_path?: string; is_linked_worktree?: boolean } | null;
};

/**
 * `worktree.create` with a `cwd` whose repo has no open workspace implicitly creates a
 * SOURCE workspace for that repo, which outlives every ticket worktree
 * (memory/reconciliation.md). Each throwaway repo is a fresh `mkdtemp` path, so without this
 * every e2e run would leave one dead workspace behind.
 *
 * `workspace.close`, never `worktree.remove`: a source workspace is not a linked worktree and
 * removal refuses it with `not_linked_worktree`. Guarded on `is_linked_worktree` and on the
 * checkout path so a ticket worktree can never be closed here by mistake.
 */
async function closeSourceWorkspaces(): Promise<void> {
  const mine = repos.splice(0, repos.length);
  if (mine.length === 0) return;
  const listed = await request<{ workspaces?: WorkspaceRow[] }>("workspace.list", {}).catch(
    (err: unknown) => {
      console.warn("e2e cleanup: workspace.list failed; source workspaces may leak:", err);
      return { workspaces: [] };
    },
  );
  for (const ws of listed.workspaces ?? []) {
    const path = ws.worktree?.checkout_path;
    if (ws.worktree?.is_linked_worktree !== false || path === undefined) continue;
    if (!mine.includes(path)) continue;
    await request("workspace.close", { workspace_id: ws.workspace_id }).catch((err: unknown) => {
      console.warn(`e2e cleanup: could not close source workspace ${ws.workspace_id}:`, err);
    });
  }
}

// --- HTTP and parsing -------------------------------------------------------

/** The single parse boundary: HTTP JSON carries no types, so it is narrowed once, here. */
export function objectFrom(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(body)}`);
  }
  return { ...body };
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`no string "${key}" in ${JSON.stringify(body)}`);
  return value;
}

export type ApiResult = { status: number; body: Record<string, unknown> };

/** One request to the board. Every endpoint answers with the same JSON envelope. */
export async function api(board: Board, method: string, path: string, data?: unknown): Promise<ApiResult> {
  const res = await fetch(`${board.baseUrl}${path}`, {
    method,
    ...(data === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
  });
  return { status: res.status, body: objectFrom(await res.json()) };
}

/** `baseBranch: "dev"` because that is the only branch `makeRepo` creates. */
export async function createProject(board: Board, id: string, repoPath: string): Promise<void> {
  const data = { id, name: `Project ${id}`, repoPath, baseBranch: "dev" };
  const res = await api(board, "POST", "/projects", data);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

export async function createTicket(board: Board, projectId: string, title: string, description: string): Promise<string> {
  const res = await api(board, "POST", "/tickets", { projectId, title, description });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return stringField(res.body, "id");
}

export async function boardRows(board: Board): Promise<Record<string, unknown>[]> {
  const res = await api(board, "GET", "/tickets");
  const tickets = res.body["tickets"];
  if (!Array.isArray(tickets)) throw new Error(`no tickets array in ${JSON.stringify(res.body)}`);
  return tickets.map(objectFrom);
}

export async function ticketRow(board: Board, ticketId: string): Promise<Record<string, unknown>> {
  const row = (await boardRows(board)).find((t) => t["id"] === ticketId);
  if (!row) throw new Error(`ticket ${ticketId} is not on the board`);
  return row;
}

/**
 * Poll the API rather than sleeping: a turn on the probe ticket is ~15s, but that is a
 * measurement, not a contract, so a fixed sleep would be either flaky or slow.
 */
export async function waitForTicket(
  board: Board,
  ticketId: string,
  what: string,
  done: (row: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = await ticketRow(board, ticketId);
    if (done(last)) return last;
    await delay(500);
  }
  throw new Error(`ticket ${ticketId} never ${what} in ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
}

// --- Spawning ---------------------------------------------------------------

/**
 * POST /tickets/:id/spawn, registered for teardown BEFORE the request goes out: a spawn that
 * fails halfway still leaves a worktree, a pane and a live agent behind.
 *
 * Returns the raw result so a caller can assert on a rejection (compare-and-swap needs the
 * 409); `spawnTicket` is the assert-it-worked wrapper.
 */
export async function postSpawn(
  board: Board,
  repoPath: string,
  ticketId: string,
): Promise<ApiResult & { elapsedMs: number }> {
  // The board reports the branch a ticket WOULD use even before its first spawn, so cleanup
  // can resolve the worktree by branch whatever happens below (memory/naming.md).
  const entry: Spawn = {
    baseUrl: board.baseUrl,
    repoPath,
    ticketId,
    branch: stringField(await ticketRow(board, ticketId), "branch"),
    sessionDir: null,
  };
  spawns.push(entry);

  const started = Date.now();
  const res = await api(board, "POST", `/tickets/${encodeURIComponent(ticketId)}/spawn`);
  const elapsedMs = Date.now() - started;

  // Read back the transcript directory: it is outside the worktree, survives its removal,
  // and its path is Herdr's to report rather than ours to derive (memory/reconciliation.md).
  const sessionDir = (await ticketRow(board, ticketId))["sessionDir"];
  if (typeof sessionDir === "string") entry.sessionDir = sessionDir;
  const worktreePath = res.body["worktreePath"];
  if (typeof worktreePath === "string") worktreeParents.add(dirname(worktreePath));
  return { ...res, elapsedMs };
}

export type Spawned = {
  ticketId: string;
  branch: string;
  agentName: string;
  worktreePath: string;
  paneId: string;
  workspaceId: string;
  elapsedMs: number;
  diagnostics: Record<string, unknown>;
};

export async function spawnTicket(board: Board, repoPath: string, ticketId: string): Promise<Spawned> {
  const res = await postSpawn(board, repoPath, ticketId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // A spawn is the slowest thing in this suite, and the readiness guard's retry counts are
  // the first thing worth knowing when one is slow or when several run at once.
  const diag = JSON.stringify(res.body["diagnostics"]);
  console.log(`[spawn] ${ticketId} took ${res.elapsedMs}ms; diagnostics=${diag}`);
  return {
    ticketId,
    branch: stringField(res.body, "branch"),
    agentName: stringField(await ticketRow(board, ticketId), "agentName"),
    // From the response, never rebuilt from the branch: Herdr owns that mapping and
    // lowercases it, so a rebuilt path names a directory that does not exist (memory/naming.md).
    worktreePath: stringField(res.body, "worktreePath"),
    paneId: stringField(res.body, "paneId"),
    workspaceId: stringField(res.body, "workspaceId"),
    elapsedMs: res.elapsedMs,
    diagnostics: objectFrom(res.body["diagnostics"]),
  };
}

/**
 * Close a pane straight at Herdr, the way a user closing the tab does. Deliberately NOT
 * `/cancel` or `DELETE`, which run the product's own teardown and take the worktree, the
 * branch and the row with them — they can never show what a bare pane closure alone does to
 * a ticket. `pane.close` emits `pane_closed` and then `workspace_closed`, never `pane_exited`
 * (memory/socket.md), so this also exercises the half of the death path a `pane.exited`-only
 * subscription would miss.
 */
export async function closePane(paneId: string): Promise<void> {
  await request("pane.close", { pane_id: paneId });
}

// --- Reading the world back -------------------------------------------------

export async function liveAgentNames(): Promise<string[]> {
  const res = await request<{ agents?: { name?: string | null }[] }>("agent.list", {});
  return (res.agents ?? []).flatMap((a) => (typeof a.name === "string" && a.name ? [a.name] : []));
}

export async function liveWorktreeBranches(repoPath: string): Promise<string[]> {
  const res = await request<{ worktrees?: { branch?: string | null }[] }>("worktree.list", { cwd: repoPath });
  return (res.worktrees ?? []).flatMap((w) => (typeof w.branch === "string" && w.branch ? [w.branch] : []));
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  // `git branch --list` exits 0 and prints nothing for a missing branch, so it is useless as
  // a predicate; `rev-parse --verify` exits non-zero.
  const ref = `refs/heads/${branch}`;
  return git("git", ["-C", repoPath, "rev-parse", "--verify", ref]).then(() => true, () => false);
}

export type StoredTicket = {
  status: string;
  branch: string | null;
  agentName: string | null;
  sessionDir: string | null;
};

const nullableText = (v: SQLOutputValue | undefined): string | null =>
  typeof v === "string" ? v : null;

/**
 * The stored row, straight out of SQLite. GET /tickets DERIVES `branch` and `agentName` when
 * the columns are null, so the API reports them either way and cannot show that teardown
 * cleared them. This is the only place that can.
 */
export function storedTicket(board: Board, ticketId: string): StoredTicket {
  const stateDir = stateDirs.get(board);
  if (stateDir === undefined) throw new Error("that board did not come from startBoard()");
  const db = new DatabaseSync(join(stateDir, "10x.db"), { readOnly: true });
  try {
    const sql = "SELECT status, branch, agent_name, session_dir FROM tickets WHERE id = ?";
    const row = db.prepare(sql).get(ticketId);
    if (row === undefined) throw new Error(`no ticket ${ticketId} in the store`);
    const status = nullableText(row["status"]);
    if (status === null) throw new Error(`ticket ${ticketId} has no status`);
    return {
      status,
      branch: nullableText(row["branch"]),
      agentName: nullableText(row["agent_name"]),
      sessionDir: nullableText(row["session_dir"]),
    };
  } finally {
    db.close();
  }
}

/**
 * Cancel and ticket-delete are destructive on five independent dials (memory/teardown.md).
 * Asserting only the worktree would pass while a branch, a live agent or an OMP transcript
 * leaked, so every dial is checked.
 */
export async function expectZeroResidue(repoPath: string, run: Spawned, sessionDir: string): Promise<void> {
  expect(existsSync(run.worktreePath), `worktree ${run.worktreePath} is still on disk`).toBe(false);
  expect(await liveWorktreeBranches(repoPath)).not.toContain(run.branch);
  expect(await branchExists(repoPath, run.branch), `branch ${run.branch} survived`).toBe(false);
  expect(await liveAgentNames()).not.toContain(run.agentName);
  expect(existsSync(sessionDir), `OMP transcript ${sessionDir} is still on disk`).toBe(false);
}
