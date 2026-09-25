/**
 * Advisory single-instance guard for the plan-workspace sweep (memory/reconciliation.md).
 *
 * Herdr agent and workspace names are unique only within the WHOLE Herdr session, never per 10x
 * backend process (memory/naming.md): `ticket-<project>-<number>[-plan]` is a pure function of a
 * project slug and a ticket number, with nothing in it that distinguishes which backend deployment
 * computed it. A second `backend/src/server.ts` process sharing the same Herdr daemon — a smoke
 * test, a throwaway dev boot, an accidental second start — can therefore compute the exact plan
 * label of a ticket its own `listTickets()` has never heard of. Its own boot sweep then reads that
 * absence as "deleted while its planner was open" and closes a workspace it does not own.
 *
 * There is no way to tell the two cases apart from inside `decidePlanSweep` alone: "not in my
 * ticket list" means "deleted" for a lone backend and "not mine to know about" for a second one,
 * and the label carries no information about which. So the guard sits one level up: before the
 * sweep runs its destructive half at all, confirm this process is the only one claiming to be the
 * sweeper for this Herdr session. If it is not, `sweepPlanWorkspaces` (reconcile.ts) skips the
 * whole sweep rather than guess — the same "abstain rather than destroy on a guess" rule that
 * governs every other carve-out in reconciliation.md.
 *
 * This is deliberately advisory, not a real mutex: a PID file colocated with the Herdr socket —
 * the one resource every backend instance sharing a daemon actually shares, regardless of how
 * each one's own STATE_DIR/DB_PATH is configured. `process.kill(pid, 0)`'s ESRCH is the standard
 * "is this pid alive" probe; it never actually signals the process.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SOCKET_PATH } from "./herdr.ts";

export const INSTANCE_LOCK_PATH =
  process.env.HERDR_INSTANCE_LOCK_PATH ?? join(dirname(SOCKET_PATH), "10x.instance.lock");

type LockRecord = { pid: number; startedAt: string };

function isLockRecord(value: unknown): value is LockRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).pid === "number" &&
    typeof (value as Record<string, unknown>).startedAt === "string"
  );
}

/** `process.kill(pid, 0)` signals nothing; it only probes whether `pid` still exists. */
function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(lockPath: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    return isLockRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export type InstanceClaim =
  | { sole: true }
  | { sole: false; ownerPid: number; since: string };

/**
 * Claim (or reclaim) sole-sweeper status for this Herdr session.
 *
 * `lockPath` defaults to `INSTANCE_LOCK_PATH` and exists as a parameter only so a test can point
 * it at a throwaway file instead of the real one beside the Herdr socket.
 *
 * A live PID already in the lock file that is not this process's own means somebody else is
 * already the sweeper — `sole: false`. Anything else (no file, an unparsable one, or a PID that
 * is no longer alive, e.g. a crashed prior boot) is free to claim, including re-claiming across
 * repeated calls from the same process. A lock this process cannot read or write at all (a
 * read-only filesystem, a missing directory it cannot create) degrades to `sole: true` with a
 * warning rather than disabling the sweep forever: the guard is an added safety net, not the
 * only one, and the pre-existing single-instance behaviour is not worse than before this existed.
 */
export function claimSoleInstance(lockPath: string = INSTANCE_LOCK_PATH): InstanceClaim {
  const existing = readLock(lockPath);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    return { sole: false, ownerPid: existing.pid, since: existing.startedAt };
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockRecord),
    );
  } catch (err) {
    console.warn(
      `instance-lock: could not write ${lockPath}; proceeding without the ` +
        `second-instance guard for this boot:`,
      err,
    );
  }
  return { sole: true };
}
