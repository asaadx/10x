/**
 * Tests for the advisory single-instance guard (memory/reconciliation.md). Each test points
 * `claimSoleInstance` at its own throwaway lock file, so tests never share one with each other
 * or with a real Herdr session.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSoleInstance } from "./instance-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-instance-lock-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function freshLockPath(): string {
  counter += 1;
  return join(dir, `lock-${counter}.json`);
}

function readWrittenPid(path: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") {
    return parsed.pid;
  }
  throw new Error(`lock file at ${path} does not look like a lock record`);
}

describe("claimSoleInstance", () => {
  test("no lock file yet: claims sole and writes one", () => {
    const path = freshLockPath();
    assert.deepEqual(claimSoleInstance(path), { sole: true });
    assert.equal(readWrittenPid(path), process.pid);
  });

  test("re-claiming from the same process is always sole — a pid cannot collide with itself", () => {
    const path = freshLockPath();
    assert.deepEqual(claimSoleInstance(path), { sole: true });
    assert.deepEqual(claimSoleInstance(path), { sole: true });
  });

  test("a stale pid (process no longer running) is reclaimed, not treated as a live owner", () => {
    const path = freshLockPath();
    // A pid too large to be a real process on this host, standing in for "whoever wrote this
    // lock is long gone" without racing a real short-lived child's exit.
    const deadPid = 2 ** 30;
    writeFileSync(path, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));
    assert.deepEqual(claimSoleInstance(path), { sole: true });
    assert.equal(readWrittenPid(path), process.pid);
  });

  test("a live pid belonging to another process is NOT sole — the real second-instance case", async () => {
    const path = freshLockPath();
    const child = spawnChild(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      const ownerPid = child.pid;
      assert.ok(ownerPid !== undefined);
      writeFileSync(path, JSON.stringify({ pid: ownerPid, startedAt: "2020-01-01T00:00:00.000Z" }));

      const claim = claimSoleInstance(path);
      assert.deepEqual(claim, { sole: false, ownerPid, since: "2020-01-01T00:00:00.000Z" });
      // A non-sole claim must never overwrite the winner's lock.
      assert.equal(readWrittenPid(path), ownerPid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("once the owning process exits, the next claim reclaims sole status", async () => {
    const path = freshLockPath();
    const child = spawnChild(process.execPath, ["-e", "process.exit(0)"]);
    const exitedPid = await new Promise<number>((resolve, reject) => {
      child.once("exit", () => resolve(child.pid ?? -1));
      child.once("error", reject);
    });
    writeFileSync(path, JSON.stringify({ pid: exitedPid, startedAt: new Date().toISOString() }));
    assert.deepEqual(claimSoleInstance(path), { sole: true });
  });

  test("an unparsable lock file is treated as absent, not as a live owner", () => {
    const path = freshLockPath();
    writeFileSync(path, "not json");
    assert.deepEqual(claimSoleInstance(path), { sole: true });
  });
});
