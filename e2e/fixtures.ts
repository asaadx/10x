/**
 * E2E fixtures: a backend on a throwaway state dir, throwaway git repos, and the Herdr
 * preflight. Everything created here is registered for `cleanupAll()`, which every spec
 * calls from `afterAll` so a failed run leaves nothing behind.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const git = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * 4310 avoids two ranges that are already spoken for: the real board runs on 4010, and 41xx
 * is reserved for per-ticket dev servers (memory/parking-lot.md).
 */
const PORT = 4310;

const READY_TIMEOUT_MS = 15_000;

export type Board = { baseUrl: string; stop(): Promise<void> };

/** Temp dirs and live servers this run owns, drained by `cleanupAll`. */
const tempDirs: string[] = [];
const running = new Set<Board>();

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
  const stateDir = await tempDir("10x-e2e-state-");
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
  return dir;
}

export async function cleanupAll(): Promise<void> {
  // Servers first: a live one holds an open SQLite handle inside the state dir it is about
  // to lose, and it would keep the port for the next spec file.
  await Promise.all([...running].map((board) => board.stop()));
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
