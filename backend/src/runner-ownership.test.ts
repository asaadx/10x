/**
 * Regression tests for ticket-10x-38: `teardown` and `retireAgent` must resolve THIS ticket's
 * own Herdr workspace by (repoPath, branch) before trusting anything `agent.get` hands back
 * under the ticket's agent name, because that name is unique only within the whole Herdr
 * session, not per 10x backend instance (memory/naming.md). A second backend process sharing
 * the same daemon can legitimately compute the exact same agent name for an unrelated ticket of
 * its own, and `agent.get` hands back that ticket's live pane with no error at all.
 *
 * Herdr is faked the way spawn.test.ts fakes it — a real unix socket speaking real NDJSON —
 * because the subject is which methods get called at all, in particular whether `pane.close`
 * is ever sent for a workspace that is not this ticket's own.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDiagnostics } from "./diagnostics.ts";
import type { RunSpec, RunState } from "./runner.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-runner-ownership-test-"));
const socketPath = join(dir, "herdr.sock");
process.env.STATE_DIR = dir;
process.env.HERDR_SOCKET_PATH = socketPath;

// Dynamic, not static: runner.ts pulls in herdr.ts, which reads HERDR_SOCKET_PATH at module
// load — a static import would hoist above the env assignments above (see spawn.test.ts).
const { teardown, retireAgent } = await import("./runner.ts");

const repoPath = join(dir, "repo");
mkdirSync(repoPath);
execFileSync("git", ["init", "-q", repoPath], { stdio: "ignore" });

const PROJECT_ID = "ownertest";
const NUMBER = 1;
const BRANCH = `ticket/${PROJECT_ID}/${NUMBER}`;

function spec(): RunSpec {
  return {
    projectId: PROJECT_ID,
    number: NUMBER,
    title: "t",
    description: "d",
    taskBreakdown: [],
    acceptanceCriteria: [],
    repoPath,
    base: "main",
    apiUrl: "http://localhost:0",
  };
}

function state(): RunState {
  return { diagnostics: freshDiagnostics(), sessionDir: null };
}

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

const OWN_WORKTREE: Handler = () => ({
  result: {
    worktrees: [{ path: join(dir, "worktree"), branch: BRANCH, is_linked_worktree: true, is_prunable: false, open_workspace_id: "wMINE" }],
  },
});

describe("retireAgent", () => {
  test("closes the pane when agent.get resolves to this ticket's own worktree workspace", async () => {
    reset({
      "worktree.list": OWN_WORKTREE,
      "agent.get": () => ({
        result: { agent: { workspace_id: "wMINE", pane_id: "wMINE:p1", agent_session: { value: join(dir, "session/agent.json") } } },
      }),
      "pane.close": () => ({ result: {} }),
    });
    await retireAgent(spec(), state());
    assert.ok(calls.some((c) => c.method === "pane.close" && c.params["pane_id"] === "wMINE:p1"));
  });

  test("refuses to close a pane belonging to a different workspace — a Herdr agent-name collision", async () => {
    reset({
      "worktree.list": OWN_WORKTREE,
      // `agent.get` resolves the shared name to a live agent in a DIFFERENT workspace: exactly
      // what a second backend instance's own, unrelated, same-named ticket looks like from here.
      "agent.get": () => ({
        result: { agent: { workspace_id: "wOTHER", pane_id: "wOTHER:p1", agent_session: { value: join(dir, "session/other.json") } } },
      }),
      "pane.close": () => ({ result: {} }),
    });
    await retireAgent(spec(), state());
    assert.ok(!calls.some((c) => c.method === "pane.close"));
  });

  test("no worktree of our own at all: never closes, regardless of what agent.get answers", async () => {
    reset({
      "worktree.list": () => ({ result: { worktrees: [] } }),
      "agent.get": () => ({
        result: { agent: { workspace_id: "wSOMETHING", pane_id: "wSOMETHING:p1" } },
      }),
      "pane.close": () => ({ result: {} }),
    });
    await retireAgent(spec(), state());
    assert.ok(!calls.some((c) => c.method === "pane.close"));
  });
});

describe("teardown", () => {
  test("deletes the session directory only when agent.get resolves to this ticket's own worktree", async () => {
    const sessionDir = join(dir, "session-mine");
    mkdirSync(sessionDir, { recursive: true });
    reset({
      "worktree.list": OWN_WORKTREE,
      "agent.get": () => ({
        result: { agent: { workspace_id: "wMINE", agent_session: { value: join(sessionDir, "agent.json") } } },
      }),
      "worktree.open": () => ({
        result: { workspace: { workspace_id: "wMINE" }, worktree: { path: join(dir, "worktree"), branch: BRANCH } },
      }),
      "worktree.remove": () => ({ result: {} }),
    });
    const s = state();
    await teardown(spec(), s, false);
    assert.equal(existsSync(sessionDir), false); // actually removed — the confirmed-ownership path ran
    assert.equal(s.sessionDir, null);
  });

  test("leaves a mismatched agent's session directory alone — not this ticket's own", async () => {
    const otherSessionDir = join(dir, "session-other");
    mkdirSync(otherSessionDir, { recursive: true });
    reset({
      "worktree.list": OWN_WORKTREE,
      // `agent.get` resolves the shared name to a live agent in a DIFFERENT workspace — exactly
      // what a second backend instance's own, unrelated, same-named ticket looks like from here.
      "agent.get": () => ({
        result: { agent: { workspace_id: "wOTHER", agent_session: { value: join(otherSessionDir, "agent.json") } } },
      }),
      "worktree.open": () => ({
        result: { workspace: { workspace_id: "wMINE" }, worktree: { path: join(dir, "worktree"), branch: BRANCH } },
      }),
      "worktree.remove": () => ({ result: {} }),
    });
    const s = state();
    await teardown(spec(), s, false);
    // Never adopted as ours, so nothing of ours was ever set to it, and the directory itself —
    // which would belong to a completely different backend instance's real ticket — survives.
    assert.equal(existsSync(otherSessionDir), true);
    assert.equal(s.sessionDir, null);
  });
});
