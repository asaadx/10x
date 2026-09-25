/**
 * Tests for the plan-workspace sweep (memory/reconciliation.md), focused on the ticket-10x-38
 * regression: a second 10x backend instance sharing the same Herdr daemon must never close a
 * plan workspace it cannot positively confirm ownership of. `decidePlanSweep` alone cannot tell
 * "deleted" from "not my ticket list" — the single-instance guard (instance-lock.ts) is what
 * makes the destructive half of the sweep trustworthy again, so `sweepPlanWorkspaces` is
 * exercised with an injected `claim` rather than a real lock file.
 *
 * Herdr is faked the way herdr.test.ts and spawn.test.ts fake it — a real unix socket speaking
 * real NDJSON — because the subject includes which methods get called at all, not just what a
 * stubbed function returns.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceClaim } from "./instance-lock.ts";
import type { PlanTicket } from "./reconcile.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-reconcile-test-"));
const socketPath = join(dir, "herdr.sock");
process.env.HERDR_SOCKET_PATH = socketPath;

// Dynamic, not static: SOCKET_PATH is read from the env at import time (herdr.ts), and
// reconcile.ts imports herdr.ts statically — a static import here would hoist above the
// assignment above and bind the real Herdr socket (see herdr.test.ts, spawn.test.ts).
const { decidePlanSweep, sweepPlanWorkspaces } = await import("./reconcile.ts");

type Frame = { result?: unknown; error?: { code: string; message: string } };
type Handler = (params: Record<string, unknown>) => Frame;

let handlers: Record<string, Handler> = {};
let calls: { method: string; params: Record<string, unknown> }[] = [];

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

after(async () => {
  for (const s of sockets) s.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  rmSync(dir, { recursive: true, force: true });
});

function reset(next: Record<string, Handler>): void {
  calls = [];
  handlers = next;
}

const SOLE: InstanceClaim = { sole: true };
const sole = (): InstanceClaim => SOLE;
const notSole = (ownerPid: number, since: string): (() => InstanceClaim) =>
  () => ({ sole: false, ownerPid, since });

describe("decidePlanSweep", () => {
  test("a label not shaped like a plan agent name is never a candidate", () => {
    const decisions = decidePlanSweep([{ workspace_id: "w1", label: "refactor-plan" }], []);
    assert.deepEqual(decisions, []);
  });

  test("no ticket owns the label: closes it", () => {
    const decisions = decidePlanSweep(
      [{ workspace_id: "w1", label: "ticket-10x-7-plan" }],
      [],
    );
    assert.deepEqual(decisions, [
      {
        workspaceId: "w1",
        label: "ticket-10x-7-plan",
        close: true,
        reason: "no ticket owns this label — it was deleted while its planner was open",
      },
    ]);
  });

  test("the owning ticket is still in backlog: spares it", () => {
    const tickets: PlanTicket[] = [{ id: "t7", projectId: "10x", number: 7, status: "backlog" }];
    const decisions = decidePlanSweep(
      [{ workspace_id: "w1", label: "ticket-10x-7-plan" }],
      tickets,
    );
    assert.equal(decisions[0]?.close, false);
  });

  test("the owning ticket has left backlog: closes it", () => {
    const tickets: PlanTicket[] = [{ id: "t7", projectId: "10x", number: 7, status: "todo" }];
    const decisions = decidePlanSweep(
      [{ workspace_id: "w1", label: "ticket-10x-7-plan" }],
      tickets,
    );
    assert.equal(decisions[0]?.close, true);
  });
});

describe("sweepPlanWorkspaces — sole instance", () => {
  test("closes a plan workspace whose ticket no longer exists in this process's own list", async () => {
    reset({
      "workspace.list": () => ({
        result: { workspaces: [{ workspace_id: "w1", label: "ticket-10x-7-plan" }] },
      }),
      "workspace.close": () => ({ result: {} }),
    });
    const decisions = await sweepPlanWorkspaces([], sole);
    assert.equal(decisions[0]?.close, true);
    assert.ok(calls.some((c) => c.method === "workspace.close" && c.params["workspace_id"] === "w1"));
  });

  test("spares a plan workspace whose ticket is still in backlog", async () => {
    reset({
      "workspace.list": () => ({
        result: { workspaces: [{ workspace_id: "w2", label: "ticket-10x-9-plan" }] },
      }),
    });
    const tickets: PlanTicket[] = [{ id: "t9", projectId: "10x", number: 9, status: "backlog" }];
    const decisions = await sweepPlanWorkspaces(tickets, sole);
    assert.equal(decisions[0]?.close, false);
    assert.ok(!calls.some((c) => c.method === "workspace.close"));
  });
});

describe("sweepPlanWorkspaces — a second backend instance shares this Herdr daemon (ticket-10x-38)", () => {
  test("skips the sweep entirely when another instance already claims this session", async () => {
    // A live production board owns ticket-10x-7, still in Backlog with its planner open. This
    // "instance" boots with an empty, unrelated ticket list — a throwaway/test/dev backend
    // sharing the same Herdr daemon. Absent the guard, `decidePlanSweep` would read the label as
    // "no ticket owns this — it was deleted" and close a real, still-backlogged ticket's planner:
    // the exact incident recorded in memory/reconciliation.md and the ticket.
    reset({
      "workspace.list": () => ({
        result: { workspaces: [{ workspace_id: "wREAL", label: "ticket-10x-7-plan" }] },
      }),
      "workspace.close": () => ({ result: {} }),
    });

    const decisions = await sweepPlanWorkspaces([], notSole(4242, "2024-01-01T00:00:00.000Z"));

    assert.deepEqual(decisions, []);
    // Not even `workspace.list` is called — the guard aborts before any Herdr conversation, so
    // there is no window in which a slow decision could still race a close.
    assert.deepEqual(calls, []);
  });

  test("an in_progress ticket's real agent is a worktree agent, not a plan label, and is untouched either way", async () => {
    // Sanity check that the guard only ever gates the PLAN sweep: an in_progress ticket's own
    // (non-plan) agent name never matches `isPlanAgentName` and is never a candidate, sole or not.
    reset({
      "workspace.list": () => ({
        result: { workspaces: [{ workspace_id: "wREAL", label: "ticket-10x-7" }] },
      }),
    });
    const decisions = await sweepPlanWorkspaces([], sole);
    assert.deepEqual(decisions, []);
    assert.ok(!calls.some((c) => c.method === "workspace.close"));
  });
});
