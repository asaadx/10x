/**
 * Reap the dev server an agent started inside its ticket's port block.
 *
 * 10x did not spawn that process — the agent did, inside its worktree, sometime during the
 * turn. The only thing 10x knows about it going in is that the agent was told (via the system
 * prompt in runner.ts) to bind inside the ticket's reserved TCP block (memory/architecture.md,
 * the port pool). So the port block is the only handle available: find what is listening in
 * it, then use it to look the process up.
 *
 * A port alone is not proof of ownership, though — anything could be squatting on it, and
 * killing a stranger's process because it happens to share a range with this ticket would be
 * worse than leaving a dev server running. So a listener is only killed once its working
 * directory is shown to sit inside THIS ticket's worktree; anything else is reported and left
 * alone.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PortBlock } from "./ports.ts";

const run = promisify(execFile);

/** How long to give a `SIGTERM`'d process to exit on its own before escalating. */
const KILL_GRACE_MS = 500;

/** A listening socket inside a ticket's block, as reported by `ss`. */
export type Listener = { port: number; pid: number };

/**
 * Parse `ss -lptnH` output. Pure, so the fiddly half is testable without a live socket.
 *
 * The process NAME is deliberately never used: a Node listener reports as `MainThread` (the
 * worker thread that opened the socket), not `node`, so filtering by name would silently
 * ignore the exact processes this exists to find.
 */
export function parseListeners(output: string): Listener[] {
  const seen = new Set<string>();
  const listeners: Listener[] = [];
  for (const line of output.split("\n")) {
    const pidMatch = line.match(/pid=(\d+)/);
    if (!pidMatch) continue; // no pid — nothing to act on (also skips the header, if any)

    const fields = line.trim().split(/\s+/);
    // Local address is the 4th column: State Recv-Q Send-Q Local-Address:Port ...
    const localAddress = fields[3];
    if (!localAddress) continue;
    // Port is everything after the LAST colon, so `[::]:4137` and `127.0.0.1:4137` both work.
    const port = Number(localAddress.slice(localAddress.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;

    const pid = Number(pidMatch[1]);
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue; // ss can list the same socket twice
    seen.add(key);
    listeners.push({ port, pid });
  }
  return listeners;
}

/** True once `pid` no longer exists — an ESRCH on the zero-signal probe. */
async function isGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true; // ESRCH (or EPERM, which also means it's not ours to worry about further)
  }
}

/**
 * Kill whatever is listening inside `block`, but ONLY processes whose working directory is
 * inside `worktreePath`. Returns what it did; never throws — a reaper that can crash the
 * status callback would take down the ticket transition it is riding along with.
 */
export async function killDevServers(
  block: PortBlock,
  worktreePath: string,
): Promise<{ killed: number[]; skipped: number[] }> {
  const killed: number[] = [];
  const skipped: number[] = [];
  try {
    let stdout: string;
    try {
      ({ stdout } = await run("ss", ["-lptnH", `sport >= ${block.start} and sport <= ${block.end}`]));
    } catch (err) {
      console.warn(`[dev-server] "ss" failed or is unavailable; nothing reaped:`, err);
      return { killed, skipped };
    }

    const root = await realpath(worktreePath);
    const pids = new Set(parseListeners(stdout).map((l) => l.pid));

    for (const pid of pids) {
      if (pid === process.pid || pid <= 1) continue; // never ourselves, never init

      let cwd: string;
      try {
        cwd = await realpath(`/proc/${pid}/cwd`);
      } catch {
        // Gone already, or a permission error — either way not provably contained, so leave
        // it alone rather than guess.
        continue;
      }

      if (cwd !== root && !cwd.startsWith(root + sep)) {
        // Something else holding a port in our range is a collision to report, never
        // something to shoot.
        skipped.push(pid);
        console.warn(`[dev-server] pid ${pid} listens in block ${block.start}-${block.end} but cwd ${cwd} is outside worktree ${root}; not killing`);
        continue;
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch {
        killed.push(pid); // already gone — that's success, not an error
        continue;
      }
      await delay(KILL_GRACE_MS);
      if (!(await isGone(pid))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone between the check and the signal — still success
        }
      }
      killed.push(pid);
    }
  } catch (err) {
    console.warn("[dev-server] unexpected error while reaping; giving up for this run:", err);
  }
  return { killed, skipped };
}
