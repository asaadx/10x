/**
 * Tests for `subscribe()`'s close handling. Node emits `'close'` (not `'error'`) on a
 * graceful peer hangup, so before this handler a graceful Herdr restart fired none of
 * `subscribe()`'s registered handlers: `onEvent` went silent and nothing told the caller
 * the stream was dead (memory/herdr-omp-lifecycle.md).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket as ServerSocket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const tmpDir = mkdtempSync(join(tmpdir(), "10x-herdr-"));
const socketPath = join(tmpDir, "herdr.sock");
process.env.HERDR_SOCKET_PATH = socketPath;

// Dynamic, not static: SOCKET_PATH is read from the env at import time, so a static
// top-level import would bind the real Herdr socket path before the line above runs.
const { subscribe } = await import("./herdr.ts");

let server: Server;
const connections: ServerSocket[] = [];
{
  const { promise, resolve } = Promise.withResolvers<void>();
  server = createServer((socket) => connections.push(socket));
  server.listen(socketPath, resolve);
  await promise;
}

after(async () => {
  for (const conn of connections) conn.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("subscribe onClose", () => {
  test("a hangup from the far end fires onClose exactly once", { timeout: 2000 }, async () => {
    let closeCount = 0;
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    server.once("connection", (socket) => socket.once("data", () => socket.end()));

    const { close } = subscribe([{ type: "pane.exited" }], () => {}, () => {
      closeCount++;
      resolveClosed();
    });

    await closed;
    // Socket 'close' is a one-time lifecycle event and cannot fire twice, so counting at
    // the awaited signal is sufficient — no extra settling wait needed.
    assert.equal(closeCount, 1);
    close();
  });

  test("a caller-initiated close() does not fire onClose", { timeout: 2000 }, async () => {
    let closeCount = 0;
    const { promise: accepted, resolve: resolveAccepted } = Promise.withResolvers<ServerSocket>();
    server.once("connection", (socket) => resolveAccepted(socket));

    const { close } = subscribe([{ type: "pane.exited" }], () => {}, () => closeCount++);

    const connected = await accepted;
    close();
    // Asserting an absence has no event to await — the one deliberate exception to
    // awaiting a signal instead of sleeping. This guards the regression that matters:
    // without the closedByUs flag, teardown would trigger a pointless reopen.
    await sleep(200);
    assert.equal(closeCount, 0);
    connected.destroy();
  });

  test("events still arrive before the close", { timeout: 2000 }, async () => {
    let eventName: string | undefined;
    let eventData: unknown;
    let closedAfterEvent = false;
    const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();

    server.once("connection", (socket) =>
      socket.once("data", () => {
        socket.write(
          JSON.stringify({ event: "pane.agent_status_changed", data: { agent_status: "working" } }) + "\n",
        );
        socket.end();
      }),
    );

    subscribe(
      [{ type: "pane.agent_status_changed", pane_id: "p1" }],
      (event, data) => {
        eventName = event;
        eventData = data;
      },
      () => {
        closedAfterEvent = eventName !== undefined;
        resolveDone();
      },
    );

    await done;
    assert.equal(eventName, "pane.agent_status_changed");
    assert.deepEqual(eventData, { agent_status: "working" });
    assert.equal(closedAfterEvent, true);
  });
});
