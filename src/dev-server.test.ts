/**
 * Tests for the dev-server reaper. Parsing is pinned against a real captured `ss` line
 * (see the module doc in dev-server.ts); killing is exercised against real child processes,
 * because the containment check is the whole point and a mock cwd would not prove it works.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parseListeners, killDevServers } from "./dev-server.ts";
import type { PortBlock } from "./ports.ts";

describe("parseListeners", () => {
  // Captured verbatim on this host with a listener on 4137.
  const CAPTURED = 'LISTEN 0      511    127.0.0.1:4137 0.0.0.0:* users:(("MainThread",pid=768072,fd=22))';

  test("extracts port and pid from a real captured line", () => {
    assert.deepEqual(parseListeners(CAPTURED), [{ port: 4137, pid: 768072 }]);
  });

  test("a MainThread process name does not prevent a match", () => {
    // MainThread, not `node` — a Node listener reports this way, so filtering by name
    // would silently miss every one of them.
    const [listener] = parseListeners(CAPTURED);
    assert.equal(listener?.pid, 768072);
  });

  test("a line without pid= yields nothing", () => {
    assert.deepEqual(parseListeners('LISTEN 0 511 127.0.0.1:4137 0.0.0.0:*'), []);
  });

  test("empty input yields []", () => {
    assert.deepEqual(parseListeners(""), []);
  });

  test("a stray header line yields nothing", () => {
    assert.deepEqual(parseListeners("State Recv-Q Send-Q Local Address:Port Peer Address:Port"), []);
  });

  test("an IPv6 wildcard line parses", () => {
    const line = 'LISTEN 0 511 [::]:4137 [::]:* users:(("MainThread",pid=999,fd=22))';
    assert.deepEqual(parseListeners(line), [{ port: 4137, pid: 999 }]);
  });

  test("identical port+pid pairs are de-duplicated", () => {
    const line = [CAPTURED, CAPTURED].join("\n");
    assert.deepEqual(parseListeners(line), [{ port: 4137, pid: 768072 }]);
  });

  // Both fixes came out of review. A shared listening socket (SO_REUSEPORT, a clustered dev
  // server) lists every worker on one line, and taking only the first leaves the port held.
  test("every pid on a shared-socket line is returned, not just the first", () => {
    const line = 'LISTEN 0 511 127.0.0.1:4137 0.0.0.0:* users:(("node",pid=100,fd=20),("node",pid=101,fd=21))';
    assert.deepEqual(parseListeners(line), [
      { port: 4137, pid: 100 },
      { port: 4137, pid: 101 },
    ]);
  });

  // `Number("")` is 0 and `Number.isInteger(0)` is true, so an `isInteger`-only guard would
  // have accepted a malformed address as port 0.
  test("an address ending in a bare colon is rejected, not read as port 0", () => {
    const line = 'LISTEN 0 511 127.0.0.1: 0.0.0.0:* users:(("x",pid=9,fd=3))';
    assert.deepEqual(parseListeners(line), []);
  });
});

describe("killDevServers", () => {
  // Well outside the 4100-4199 pool and outside 4010/4310 (board / e2e harness), per the brief.
  const PORT = 4900;
  const BLOCK: PortBlock = { slot: 0, start: 4900, end: 4909 };

  const dirs: string[] = [];
  const children: ChildProcess[] = [];

  const tmpDir = (): string => mkdtempSync(join(tmpdir(), "dev-server-test-"));

  /** Spawns a real Node listener on `port` with `cwd`, and waits until it actually accepts. */
  async function spawnListener(port: number, cwd: string): Promise<ChildProcess> {
    const script = `require("net").createServer().listen(${port}, "127.0.0.1");`;
    const child = spawn(process.execPath, ["-e", script], { cwd, stdio: "ignore" });
    children.push(child);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const connected = await new Promise<boolean>((resolve) => {
        const sock = connect(port, "127.0.0.1");
        sock.once("connect", () => {
          sock.destroy();
          resolve(true);
        });
        sock.once("error", () => resolve(false));
      });
      if (connected) return child;
      await delay(50);
    }
    throw new Error(`listener on port ${port} never came up`);
  }

  after(() => {
    for (const child of children) {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  test("kills a listener whose cwd is inside the worktree", { timeout: 15_000 }, async () => {
    const worktree = tmpDir();
    dirs.push(worktree);
    const child = await spawnListener(PORT, worktree);
    assert.ok(child.pid);

    const result = await killDevServers(BLOCK, worktree);
    assert.ok(result.killed.includes(child.pid!), `expected ${child.pid} in killed, got ${JSON.stringify(result)}`);

    // Really gone, not just reported as killed.
    const deadline = Date.now() + 3000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(child.pid!, 0);
      } catch {
        gone = true;
        break;
      }
      await delay(50);
    }
    assert.ok(gone, `pid ${child.pid} is still alive after killDevServers`);
  });

  test("the safety test: a listener outside the worktree is skipped, not killed", { timeout: 15_000 }, async () => {
    const worktree = tmpDir();
    const elsewhere = tmpDir();
    dirs.push(worktree, elsewhere);
    const port = PORT + 1;
    const child = await spawnListener(port, elsewhere);
    assert.ok(child.pid);

    const result = await killDevServers({ slot: 0, start: port, end: port }, worktree);
    assert.ok(result.skipped.includes(child.pid!), `expected ${child.pid} in skipped, got ${JSON.stringify(result)}`);
    assert.ok(!result.killed.includes(child.pid!), `pid ${child.pid} must not be in killed`);

    // Still alive — the whole point of the containment check.
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  });
});
