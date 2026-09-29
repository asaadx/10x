/**
 * Local Preview of a ticket's pushed branch (docs/prototype-cloud.md, "Preview").
 *
 * The agent works in the cloud, so the only way to click through its change on this machine
 * is to fetch the branch it pushed and run it here. A Preview is: the branch fetched into a
 * detached worktree under `$STATE_DIR/previews/<ticketId>`, a `.env` carrying the ticket's
 * port block, and — only when the project configures a `devCommand` — that command running
 * in its own process group.
 *
 * State is in memory, on purpose. A Preview is a convenience that is cheap to recreate, and a
 * process handle cannot outlive this process anyway; server.ts releases every port slot and
 * sweeps the preview directory at boot, so a crash leaves nothing that a restart would trust.
 *
 * The port block itself is reserved by the caller (db.ts `reservePortSlot`), because the pool
 * is shared state in the database and this module stays free of it.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { excludeFromGit } from "./git.ts";
import { ENV_FILE, envFileFor, type PortBlock } from "./ports.ts";
import type { Preview } from "./types.ts";

const run = promisify(execFile);

type Running = {
  ticketId: string;
  repoPath: string;
  path: string;
  port: number;
  command: string;
  child: ChildProcess | null;
  /** Resolves when the dev command's shell exits — the "is it still running" signal. */
  exited: Promise<void>;
};

const previews = new Map<string, Running>();

export const previewsDir = (stateDir: string): string => join(stateDir, "previews");

/**
 * The ref the branch is fetched into. A per-ticket ref, not `FETCH_HEAD`: FETCH_HEAD is one
 * file per clone, so two Previews of the same project started together would race on it and
 * one could check out the other's branch.
 */
const previewRef = (ticketId: string): string => `refs/10x/preview/${ticketId}`;

/**
 * `branch` is agent-written (the agent records the branch it actually pushed), so it is
 * untrusted input headed for git's argv. A leading `-` would be read as an option; anything
 * outside a conservative ref alphabet is refused before git ever sees it.
 */
export function isSafeBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes("..") && !branch.endsWith(".lock");
}

/**
 * Secrets the board holds that a dev server has no business seeing. The code being previewed
 * was written by an agent and has not been reviewed yet — handing it the GitHub token or the
 * shared database's credentials would let an unreviewed branch act as the board.
 */
const WITHHELD_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TENX_DB_TOKEN", "TENX_DB_URL"];

function childEnv(block: PortBlock): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of WITHHELD_ENV) delete env[key];
  env.PORT = String(block.start);
  env.PORT_RANGE_START = String(block.start);
  env.PORT_RANGE_END = String(block.end);
  return env;
}

const isAlive = (r: Running): boolean =>
  r.child !== null && r.child.exitCode === null && r.child.signalCode === null;

const toPreview = (r: Running): Preview => ({
  path: r.path,
  port: r.port,
  url: `http://localhost:${r.port}`,
  command: r.command,
  running: isAlive(r),
});

/** The Preview a board read reports for a ticket, or null. */
export function previewFor(ticketId: string): Preview | null {
  const r = previews.get(ticketId);
  return r ? toPreview(r) : null;
}

export function hasPreview(ticketId: string): boolean {
  return previews.has(ticketId);
}

/**
 * Signal the whole process group — `sh -c` usually forks the real server rather than exec'ing
 * it, so the shell's pid alone would leave the listener running on the ticket's port. TERM
 * first so a dev server can shut down cleanly; KILL afterwards regardless, because the group
 * outlives its leader and the leader's exit says nothing about the grandchildren.
 */
async function killGroup(r: Running): Promise<void> {
  const pid = r.child?.pid;
  if (pid === undefined) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // ESRCH: nothing left in the group. That is the goal, not an error.
    }
  };
  signal("SIGTERM");
  await Promise.race([r.exited, delay(3000)]);
  signal("SIGKILL");
}

async function removeCheckout(repoPath: string, path: string): Promise<void> {
  await run("git", ["-C", repoPath, "worktree", "remove", "--force", path]).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
  // Drops the registration of a checkout whose directory is already gone (a crash, a manual
  // rm), which would otherwise make the next `worktree add` at this path refuse.
  await run("git", ["-C", repoPath, "worktree", "prune"]).catch(() => undefined);
}

/**
 * Stop a ticket's Preview: kill the dev server's group, remove the checkout, drop the ref.
 * Resolves whether or not one was running, so every teardown path can call it. `repoPath`
 * lets a caller clean a checkout this process never started (the boot sweep has none).
 */
export async function stopPreview(ticketId: string, stateDir: string, repoPath?: string): Promise<boolean> {
  const r = previews.get(ticketId);
  const path = join(previewsDir(stateDir), ticketId);
  // The common case — a ticket that was never previewed — costs no git subprocess at all:
  // ticket and project delete call this for every id they touch.
  if (!r && !existsSync(path)) return false;
  previews.delete(ticketId);
  if (r) await killGroup(r);
  const repo = r?.repoPath ?? repoPath;
  if (repo) {
    await removeCheckout(repo, path);
    await run("git", ["-C", repo, "update-ref", "-d", previewRef(ticketId)]).catch(() => undefined);
  } else {
    await rm(path, { recursive: true, force: true });
  }
  return r !== undefined;
}

/**
 * Boot-time cleanup: nothing in `previews/` can belong to a running Preview, because Previews
 * live in memory and this process has just started. Remove the directory, then have each clone
 * forget the checkouts it had registered there, or the next `worktree add` at the same path is
 * refused as "already registered".
 */
export async function sweepPreviews(stateDir: string, repoPaths: string[]): Promise<void> {
  const root = previewsDir(stateDir);
  if (!existsSync(root)) return;
  await rm(root, { recursive: true, force: true });
  for (const repo of repoPaths) {
    await run("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined);
  }
}

/** Every running Preview, for shutdown. */
export async function stopAllPreviews(stateDir: string): Promise<void> {
  await Promise.all([...previews.keys()].map((id) => stopPreview(id, stateDir)));
}

export type PreviewSpec = {
  ticketId: string;
  repoPath: string;
  branch: string;
  devCommand: string;
  block: PortBlock;
  stateDir: string;
};

/**
 * Check the branch out fresh and (re)start the dev command. Replaces any Preview the ticket
 * already has — "Preview again" after the agent pushed a fix must show the fix, not the tree
 * the first click fetched.
 */
export async function startPreview(spec: PreviewSpec): Promise<Preview> {
  const { ticketId, repoPath, branch, devCommand, block, stateDir } = spec;
  if (!isSafeBranch(branch)) throw new Error(`refusing to preview an unsafe branch name: ${JSON.stringify(branch)}`);

  await stopPreview(ticketId, stateDir, repoPath);

  const root = previewsDir(stateDir);
  const path = join(root, ticketId);
  await mkdir(root, { recursive: true });

  // `+` forces the ref: an agent that force-pushed after a Reject must not wedge the Preview.
  await run("git", ["-C", repoPath, "fetch", "--quiet", "origin", `+refs/heads/${branch}:${previewRef(ticketId)}`]);
  await run("git", ["-C", repoPath, "worktree", "add", "--quiet", "--detach", path, previewRef(ticketId)]);

  await writeFile(join(path, ENV_FILE), envFileFor(block, ticketId), "utf8");
  await excludeFromGit(path, ENV_FILE);

  let child: ChildProcess | null = null;
  const exit = Promise.withResolvers<void>();
  if (devCommand.trim() === "") {
    exit.resolve();
  } else {
    // Output goes to a file beside the checkout, not the board's own stdout: a chatty dev
    // server would bury the board's log, and a file survives for reading after a crash.
    const log = openSync(join(root, `${ticketId}.log`), "a");
    try {
      child = spawn("sh", ["-c", devCommand], {
        cwd: path,
        env: childEnv(block),
        // Its own process group, so Stop can signal the whole tree (see killGroup), and so a
        // Ctrl-C aimed at the board does not also land here uncontrolled.
        detached: true,
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    child.on("exit", () => exit.resolve());
    child.on("error", (err) => {
      console.warn(`[${ticketId}] preview command failed to start:`, err);
      exit.resolve();
    });
    // The board must be able to exit while a Preview runs; shutdown kills it explicitly.
    child.unref();
  }

  const record: Running = { ticketId, repoPath, path, port: block.start, command: devCommand, child, exited: exit.promise };
  previews.set(ticketId, record);
  return toPreview(record);
}
