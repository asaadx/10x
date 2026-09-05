/**
 * Tests for `spawn` in runner.ts: the Herdr conversation a Start actually has, and above all
 * that it boots its agent through the shared guard in `agent-boot.ts` — start, poll `agent.get`
 * until the agent is usable, THEN prompt. The runner's own additions are asserted alongside it:
 * the `Diagnostics` counters the board reads, and the silent re-attach on `agent_name_taken`.
 *
 * Herdr is faked the way plan.test.ts and herdr.test.ts fake it — a real unix socket speaking
 * real NDJSON — rather than by stubbing a module, because the subject IS the wire conversation:
 * which methods, in what order, with what params. One extra job here: `events.subscribe` is a
 * long-lived connection, so the fake answers it and keeps the socket open.
 *
 * No agent is ever started for real and nothing binds a TCP port: the port block is only ever
 * written into a file.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { freshDiagnostics } from "./diagnostics.ts";
import { blockFor } from "./ports.ts";
// Type-only, so it erases at runtime and hoisting it above the env assignments is harmless.
import type { RunSpec, RunState } from "./runner.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-spawn-test-"));
const socketPath = join(dir, "herdr.sock");
process.env.STATE_DIR = dir;
process.env.HERDR_SOCKET_PATH = socketPath;

// Dynamic, not static: runner.ts reads `STATE_DIR` and pulls in herdr.ts, which reads
// `HERDR_SOCKET_PATH`, at module load — a static import would hoist above the two assignments
// above and bind the real Herdr socket. (`ports.ts` and `diagnostics.ts` read neither.)
const { spawn } = await import("./runner.ts");

/**
 * A real git repository, because `injectPortBlock` resolves `info/exclude` with
 * `git rev-parse --git-path` rather than guessing a path, and that only answers inside a repo.
 */
const worktree = join(dir, "worktree");
mkdirSync(worktree);
execFileSync("git", ["init", "-q", worktree], { stdio: "ignore" });

const PROJECT_ID = "spawntest";
const BLOCK = blockFor(3);

// ---------------------------------------------------------------------------
// The fake Herdr: one request per connection, NDJSON, connection closed after the reply —
// except `events.subscribe`, which streams and stays open.
// ---------------------------------------------------------------------------

type Frame = { result?: unknown; error?: { code: string; message: string } };
type Handler = (params: Record<string, unknown>) => Frame;

let handlers: Record<string, Handler> = {};
let calls: { method: string; params: Record<string, unknown> }[] = [];

const NOT_FOUND: Frame = { error: { code: "agent_not_found", message: "no such agent" } };

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

    // The status stream is the one connection Herdr does not close, and runner.ts treats a
    // close as a dropped stream worth reopening — so ending it here would set the reopen
    // backoff running through every later test.
    if (method === "events.subscribe") {
      socket.write(JSON.stringify({ id: "fake", result: { type: "subscription_started" } }) + "\n");
      return;
    }

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

const sequence = () => calls.map((c) => c.method);
const paramsOf = (method: string) => calls.find((c) => c.method === method)?.params;

function reset(next: Record<string, Handler>): void {
  calls = [];
  handlers = next;
}

/**
 * A Herdr that behaves the way a real one does across a Start, including the part that broke
 * Plan: **`agent.start` returns before the agent is usable** (memory/spawn.md). Its reply
 * carries no `agent_status` and no `interactive_ready`, exactly as the real premature return
 * does, and `agent.prompt` is REFUSED with `agent_not_ready` until the agent is ready.
 *
 * Readiness advances with `agent.get` polls, not with the wall clock, so a boot that never
 * polls never becomes ready: deleting the readiness guard is a hard test failure rather than a
 * slow pass, and no test needs a sleep to be deterministic.
 */
function liveHerdr(
  options: {
    /** Fail this many `agent.start` calls with `agent_pane_busy` before accepting the pane. */
    paneBusyTimes?: number;
    /** Answer `agent.start` with `agent_name_taken`: the agent is already ours and alive. */
    nameTaken?: boolean;
    /**
     * How many `agent.get` polls after the start answer `agent_not_found` — the observable
     * symptom of a premature start: an unnamed omp agent running in the pane, and no agent of
     * that name for Herdr to answer about.
     */
    namelessGets?: number;
    /** How many polls after those report `agent_status: "unknown"` with no `interactive_ready`. */
    unreadyGets?: number;
  } = {},
) {
  const nameless = options.namelessGets ?? 0;
  const unready = options.unreadyGets ?? 0;
  let busyLeft = options.paneBusyTimes ?? 0;
  /** `agent.get` calls for an agent Herdr knows about. */
  let polls = 0;
  const live = new Set<string>();
  if (options.nameTaken) live.add(`ticket-${PROJECT_ID}-1`);
  /** Prompts Herdr refused because the agent was not registered yet. The guard keeps this 0. */
  const refused = { prompts: 0 };

  return {
    refused,
    handlers: {
      "worktree.open": () => ({
        error: { code: "worktree_not_found", message: "no worktree on that branch" },
      }),
      "worktree.create": () => ({
        result: {
          type: "worktree_created",
          workspace: { workspace_id: "wAA" },
          root_pane: { pane_id: "wAA:p1" },
          worktree: { path: worktree, branch: `ticket/${PROJECT_ID}/1` },
        },
      }),
      "agent.start": (p) => {
        if (busyLeft > 0) {
          busyLeft--;
          return { error: { code: "agent_pane_busy", message: "shell busy" } };
        }
        if (options.nameTaken) {
          return { error: { code: "agent_name_taken", message: "already running" } };
        }
        live.add(String(p["name"]));
        // Premature on purpose: a name, and nothing that says the agent can be used.
        return { result: { type: "agent_started", agent: { name: p["name"] } } };
      },
      "agent.get": (p) => {
        if (!live.has(String(p["target"]))) return NOT_FOUND;
        polls++;
        if (polls <= nameless) return NOT_FOUND;
        const ready = polls > nameless + unready;
        return {
          result: {
            agent: {
              // A re-attached agent lives wherever it already was, not in the pane the
              // worktree just handed us.
              pane_id: options.nameTaken ? "wOLD:p7" : "wAA:p1",
              workspace_id: options.nameTaken ? "wOLD" : "wAA",
              agent_status: ready ? "idle" : "unknown",
              agent_session: { value: join(dir, "sessions", "s1", "transcript.jsonl") },
              ...(ready ? { interactive_ready: true } : {}),
            },
          },
        };
      },
      "agent.prompt": () => {
        if (polls <= nameless + unready) {
          refused.prompts++;
          return {
            error: {
              code: "agent_not_ready",
              message: `agent ticket-${PROJECT_ID}-1 is not an active named agent`,
            },
          };
        }
        return { result: { type: "agent_prompted" } };
      },
    } satisfies Record<string, Handler>,
  };
}

const runSpec = (over: Partial<RunSpec> = {}): RunSpec => ({
  projectId: PROJECT_ID,
  number: 1,
  title: "Rate limit the API",
  description: "429 after 100 req/min",
  repoPath: worktree,
  base: "main",
  apiUrl: "http://localhost:4010",
  ...over,
});

/** Fresh per spawn, and its stream is closed afterwards so nothing outlives the test. */
const runState = (): RunState => ({ diagnostics: freshDiagnostics(), sessionDir: null });

const started: RunState[] = [];
async function start(spec: RunSpec, state: RunState) {
  started.push(state);
  return spawn(
    spec,
    BLOCK,
    state,
    () => {},
    () => {},
  );
}

after(async () => {
  for (const state of started) {
    state.stream?.close();
    state.stream = undefined;
  }
  for (const socket of sockets) socket.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("spawn", () => {
  test("subscribes, starts, waits for readiness, then sends the ticket", async () => {
    const fake = liveHerdr();
    reset(fake.handlers);
    const state = runState();

    const result = await start(runSpec(), state);

    // The order IS the contract: the subscription before the start (or the first `working`
    // transition is missed), and an `agent.get` between the start and the prompt, because
    // `agent.start` returns before the agent can be used.
    assert.deepEqual(sequence(), [
      "worktree.open",
      "worktree.create",
      "events.subscribe",
      "agent.start",
      "agent.get",
      "agent.prompt",
    ]);
    assert.deepEqual(result, {
      workspaceId: "wAA",
      paneId: "wAA:p1",
      worktreePath: worktree,
      branch: "ticket/spawntest/1",
    });

    const opening = paramsOf("agent.prompt") as { target: string; text: string };
    assert.equal(opening.target, "ticket-spawntest-1");
    assert.equal(opening.text, "TICKET SPAWNTEST-1: Rate limit the API\n\n429 after 100 req/min");
    assert.equal(fake.refused.prompts, 0);

    // The port block reaches the worktree, and the session directory the teardown needs is
    // taken off the agent record rather than derived.
    assert.match(readFileSync(join(worktree, ".env"), "utf8"), /^PORT=4130$/m);
    assert.equal(state.sessionDir, join(dir, "sessions", "s1"));

    // What the board shows about the race. `neededReadinessPoll` is the whole point: the
    // start returned a record that was not ready.
    assert.equal(state.diagnostics.startAttempts, 1);
    assert.equal(state.diagnostics.paneBusyRetries, 0);
    assert.equal(state.diagnostics.startReturnedReady, null);
    assert.equal(state.diagnostics.neededReadinessPoll, true);
    assert.equal(state.diagnostics.readinessPolls, 1);
    assert.equal(state.diagnostics.promptAttempts, 1);
    assert.equal(state.diagnostics.promptNotReadyRetries, 0);
    assert.equal(state.diagnostics.reusedExistingAgent, false);
    assert.ok((state.diagnostics.readyAfterMs ?? -1) >= 0);
  });

  test("an agent.start that returns before the agent is gettable still lands the ticket", async () => {
    // THE REGRESSION, from the other caller's side. Plan hit it in production —
    // `500 agent_not_ready: agent ticket-10x-4-plan is not an active named agent`, with an
    // unnamed omp agent running in the pane and `agent.get <name>` answering
    // `agent_not_found` — because it had no readiness poll. Start shares the poll now, so
    // this run must survive the same window from either button.
    const fake = liveHerdr({ namelessGets: 4, unreadyGets: 2 });
    reset(fake.handlers);
    const state = runState();

    await start(runSpec(), state);

    const afterStart = sequence().slice(sequence().indexOf("agent.start"));
    assert.deepEqual(afterStart, [
      "agent.start",
      ...Array<string>(7).fill("agent.get"),
      "agent.prompt",
    ]);
    assert.equal(fake.refused.prompts, 0);
    assert.equal(state.diagnostics.readinessPolls, 7);
    assert.equal(state.diagnostics.neededReadinessPoll, true);
    assert.equal(state.diagnostics.promptAttempts, 1);
  });

  test("the ticket is never sent before the readiness poll says ready", async () => {
    // Same guarantee as the fake sees it: this Herdr refuses any `agent.prompt` that arrives
    // while the agent is still `unknown`, and counts it. Deleting the poll from
    // `agent-boot.ts` fails this test — the `agent_not_ready` retry on the prompt is a last
    // line of defence, not the guard, and it cannot tell "not registered yet" from "never".
    const fake = liveHerdr({ unreadyGets: 3 });
    reset(fake.handlers);
    const state = runState();

    await start(runSpec(), state);

    assert.equal(fake.refused.prompts, 0);
    assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1);
    assert.ok(sequence().lastIndexOf("agent.get") < sequence().indexOf("agent.prompt"));
  });

  test("agent_pane_busy is retried, and counted", async () => {
    // A freshly created pane whose shell has not reached its interactive prompt: 2 of 6
    // measured trials (memory/spawn.md), so this is the common case, not padding.
    const fake = liveHerdr({ paneBusyTimes: 1 });
    reset(fake.handlers);
    const state = runState();

    await start(runSpec(), state);

    assert.equal(state.diagnostics.startAttempts, 2);
    assert.equal(state.diagnostics.paneBusyRetries, 1);
    assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1);
    assert.equal(fake.refused.prompts, 0);
  });

  test("agent_name_taken re-attaches to our own agent, waits for it, and sends nothing", async () => {
    // A 10x restart leaves Herdr's panes and agents running while our in-memory store resets,
    // so the name being taken means the agent for this ticket is already working on it.
    // Re-prompting would make it redo work it may already have done.
    const fake = liveHerdr({ nameTaken: true, unreadyGets: 1 });
    reset(fake.handlers);
    const state = runState();

    const result = await start(runSpec(), state);

    assert.deepEqual(sequence().filter((m) => m === "agent.prompt"), []);
    assert.equal(state.diagnostics.reusedExistingAgent, true);
    // The re-attach is not exempt from the guard: the adopted agent was `unknown` on the
    // first look, so it was polled until it was not.
    assert.equal(state.diagnostics.readinessPolls, 1);
    assert.equal(state.diagnostics.neededReadinessPoll, true);

    // A re-attached agent can be in a different pane than the worktree's, and the status
    // subscription has to follow it there or the ticket never leaves In Progress.
    assert.equal(result.paneId, "wOLD:p7");

    // `subscribe()` connects without being awaited — the caller gets a `close()` handle, not a
    // promise — so the re-subscription frame lands a tick after `spawn` returns.
    const deadline = Date.now() + 2_000;
    while (sequence().filter((m) => m === "events.subscribe").length < 2) {
      assert.ok(Date.now() < deadline, "the second events.subscribe never arrived");
      await delay(10);
    }
    // Cast to a named const: the only writer of this frame is `subscribe()` in herdr.ts.
    const watched = calls.filter((c) => c.method === "events.subscribe").at(-1)?.params as
      | { subscriptions: { pane_id?: string }[] }
      | undefined;
    assert.equal(watched?.subscriptions[0]?.pane_id, "wOLD:p7");
  });
});
