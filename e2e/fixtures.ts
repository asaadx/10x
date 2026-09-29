/**
 * E2E fixtures: a backend on a throwaway state dir, throwaway git repos with a local upstream,
 * and the helpers the lifecycle specs share. Everything created here is registered for
 * `cleanupAll()`, which every spec calls from `afterAll` so a failed run leaves nothing behind.
 *
 * No agent is ever real here. The board runs with `CLOUD_DRIVER=fake`, and `FAKE_AGENT_MS`
 * makes the fake play the agent's half of the protocol — `working`, then `done` plus the branch
 * it "pushed" — through the same database the board reads (backend/src/cloud.ts). That is the
 * whole loop the product depends on, Backlog to Review, with no network and no money spent.
 */
import { expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const git = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * 4310 avoids two ranges that are already spoken for: the real board runs on 4010, and
 * 4100-4199 is the Preview port pool (memory/architecture.md).
 */
const PORT = 4310;

const READY_TIMEOUT_MS = 15_000;

/**
 * How long the fake agent takes per step (`working` at 1x, `done` at 2x). Long enough that a
 * spec can see the card In Progress, short enough that reaching review costs about a second.
 */
export const FAKE_AGENT_MS = 600;

/**
 * Previews bind a port block from here rather than the default 4100 pool, so a real board
 * running beside the suite cannot collide with it.
 */
export const PREVIEW_PORT_BASE = 4700;

export type Board = { baseUrl: string; stop(): Promise<void> };

/** Temp dirs and live servers this run owns, drained by `cleanupAll`. */
const tempDirs: string[] = [];
const running = new Set<Board>();

/** Where each board keeps its SQLite file, for the fixtures that seed or read it directly. */
const stateDirs = new WeakMap<Board, string>();

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function startBoard(): Promise<Board> {
  return boardOn(await tempDir("10x-e2e-state-"));
}

/** A new backend on the SAME state dir and database — which is what a restart is. */
export async function restartBoard(board: Board): Promise<Board> {
  const stateDir = stateDirs.get(board);
  if (stateDir === undefined) throw new Error("that board did not come from startBoard()");
  await board.stop();
  return boardOn(stateDir);
}

async function boardOn(stateDir: string): Promise<Board> {
  const child = spawn(process.execPath, ["backend/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_DIR: stateDir,
      DB_PATH: join(stateDir, "10x.db"),
      // Explicit, because the repo-root `.env` never overrides a variable already set: these
      // are what keep the suite off the real CLI, the real database and the real GitHub.
      CLOUD_DRIVER: "fake",
      FAKE_AGENT_MS: String(FAKE_AGENT_MS),
      AGENT_POLL_MS: "200",
      TURSO_DATABASE_URL: "",
      GITHUB_TOKEN: "",
      PORT_BLOCK_BASE: String(PREVIEW_PORT_BASE),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so `stop()` can signal the whole tree.
    detached: true,
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn `node backend/src/server.ts`");

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
          // Negative pid: the group, not just the leader. The server stops its own Previews
          // on SIGTERM (they run in process groups of their own).
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

/**
 * A local clone on `dev` with a bare-repo `origin` beside it — a real upstream with no
 * network. Preview fetches the agent's branch from `origin`, so a spec that wants something
 * to preview pushes a branch there (`pushAgentBranch`), exactly as a cloud agent would.
 */
export async function makeRepo(): Promise<string> {
  const dir = await tempDir("10x-e2e-repo-");
  await git("git", ["init", "-q"], { cwd: dir });
  // Local, because CI has no global git identity and the initial commit below needs one.
  await git("git", ["config", "user.email", "e2e@10x.invalid"], { cwd: dir });
  await git("git", ["config", "user.name", "10x e2e"], { cwd: dir });
  await git("git", ["commit", "-q", "--allow-empty", "-m", "chore: initial commit"], { cwd: dir });
  await git("git", ["branch", "-M", "dev"], { cwd: dir });
  const origin = `${dir}.git`;
  tempDirs.push(origin);
  await git("git", ["init", "-q", "--bare", origin], { cwd: dir });
  await git("git", ["remote", "add", "origin", origin], { cwd: dir });
  await git("git", ["push", "-q", "origin", "dev"], { cwd: dir });
  return dir;
}

/**
 * What a cloud agent does last before reporting `done`: push its branch to the upstream. The
 * clone itself is left on `dev` — the branch exists only on `origin`, which is the situation
 * Preview has to handle.
 */
export async function pushAgentBranch(repoPath: string, branch: string, file: string, content: string): Promise<void> {
  const work = await tempDir("10x-e2e-agent-");
  await git("git", ["clone", "-q", `${repoPath}.git`, work]);
  await git("git", ["config", "user.email", "agent@10x.invalid"], { cwd: work });
  await git("git", ["config", "user.name", "fake agent"], { cwd: work });
  await git("git", ["checkout", "-q", "-b", branch, "origin/dev"], { cwd: work });
  await writeFile(join(work, file), content, "utf8");
  await git("git", ["add", file], { cwd: work });
  await git("git", ["commit", "-q", "-m", "agent work"], { cwd: work });
  await git("git", ["push", "-q", "origin", branch], { cwd: work });
}

export async function cleanupAll(): Promise<void> {
  // Servers first: a live one holds an open SQLite handle inside the state dir it is about
  // to lose, runs Previews out of it, and would keep the port for the next spec file.
  await Promise.all([...running].map((board) => board.stop()));
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
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

/**
 * Seeded straight into the board's SQLite, not through `POST /projects`.
 *
 * Creating a project over HTTP makes 10x clone a GitHub repo itself, which would put network —
 * and a token — on the critical path of every e2e run. So the row is written directly, already
 * `ready`, pointing at the local fixture. The HTTP contract this bypasses is covered by
 * `backend/src/project-routes.test.ts` against a faked GitHub.
 *
 * `baseBranch: "dev"` because that is the only branch `makeRepo` creates.
 */
export async function createProject(board: Board, id: string, repoPath: string, devCommand = ""): Promise<void> {
  const stateDir = stateDirs.get(board);
  if (stateDir === undefined) throw new Error("that board did not come from startBoard()");
  const db = new DatabaseSync(join(stateDir, "10x.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, name, description, owner, repo, repo_path, base_branch,
                             provision_state, provision_error, dev_command, created_at, updated_at)
       VALUES (?, ?, '', 'e2e', ?, ?, 'dev', 'ready', '', ?, ?, ?)`,
    ).run(id, `Project ${id}`, id, repoPath, devCommand, now, now);
  } finally {
    db.close();
  }
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

/** Poll the API rather than sleeping: the fake agent's timing is a setting, not a contract. */
export async function waitForTicket(
  board: Board,
  ticketId: string,
  what: string,
  done: (row: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = await ticketRow(board, ticketId);
    if (done(last)) return last;
    await delay(200);
  }
  throw new Error(`ticket ${ticketId} never ${what} in ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
}

// --- Spawning ---------------------------------------------------------------

/**
 * Promote to To Do, then POST /tickets/:id/spawn. Start is a `todo → in_progress` move, and
 * `POST /tickets` lands a ticket in Backlog. The promotion is best-effort and unasserted so a
 * caller can test a refused spawn on a ticket already past To Do.
 */
export async function postSpawn(board: Board, ticketId: string): Promise<ApiResult> {
  await api(board, "POST", `/tickets/${encodeURIComponent(ticketId)}/status`, { to: "todo" });
  return api(board, "POST", `/tickets/${encodeURIComponent(ticketId)}/spawn`);
}

export type Spawned = { ticketId: string; sessionId: string; sessionUrl: string };

export async function spawnTicket(board: Board, ticketId: string): Promise<Spawned> {
  const res = await postSpawn(board, ticketId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    ticketId,
    sessionId: stringField(res.body, "sessionId"),
    sessionUrl: stringField(res.body, "sessionUrl"),
  };
}

export type StoredTicket = {
  status: string;
  branch: string | null;
  sessionId: string | null;
  agentState: string | null;
};

const nullableText = (v: SQLOutputValue | undefined): string | null =>
  typeof v === "string" ? v : null;

/** The stored row, straight out of SQLite — what the API reports, without trusting the API. */
export function storedTicket(board: Board, ticketId: string): StoredTicket {
  const stateDir = stateDirs.get(board);
  if (stateDir === undefined) throw new Error("that board did not come from startBoard()");
  const db = new DatabaseSync(join(stateDir, "10x.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT status, branch, session_id, agent_state FROM tickets WHERE id = ?").get(ticketId);
    if (row === undefined) throw new Error(`no ticket ${ticketId} in the store`);
    const status = nullableText(row["status"]);
    if (status === null) throw new Error(`ticket ${ticketId} has no status`);
    return {
      status,
      branch: nullableText(row["branch"]),
      sessionId: nullableText(row["session_id"]),
      agentState: nullableText(row["agent_state"]),
    };
  } finally {
    db.close();
  }
}
