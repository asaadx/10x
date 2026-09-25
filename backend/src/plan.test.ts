/**
 * Tests for Plan mode: the planner's Herdr call sequence (planner.ts), the boot sweep that
 * collects finished plan workspaces (reconcile.ts), and the `POST /tickets/:id/plan` route.
 *
 * Herdr is faked the way herdr.test.ts fakes it — a real unix socket speaking real NDJSON —
 * rather than by stubbing a module. The whole subject here IS the wire conversation: which
 * methods are called, in what order, with what params. A stubbed client would assert against
 * the stub instead of against `herdr.ts`, and the ordering claim is the one that matters
 * (a workspace created after a failed start is a leaked pane).
 *
 * The route half spawns `backend/src/server.ts` as a child, exactly as `e2e/fixtures.ts`
 * does, so the route regex and the guards are exercised for real. It binds a throwaway port,
 * never 4010 (a live board) or 4310 (the e2e suite).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// Type-only, so it erases at runtime and hoisting it above the env assignments is harmless.
import type { PlanTicket } from "./reconcile.ts";
import type { PlanSpec } from "./planner.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-plan-test-"));
const socketPath = join(dir, "herdr.sock");
const PORT = 4319;
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.HERDR_SOCKET_PATH = socketPath;

// Dynamic imports, for the same reason port-slots.test.ts and herdr.test.ts use them: both
// `DB_PATH` and `HERDR_SOCKET_PATH` are read at module load, and a static import would hoist
// above the assignments and open the real database against the real Herdr socket.
const { db, nowIso } = await import("./db.ts");
const { getTicket } = await import("./ticket-store.ts");
const { startPlanning } = await import("./planner.ts");
const { decidePlanSweep, sweepPlanWorkspaces } = await import("./reconcile.ts");
const { agentNameFor, planAgentNameFor } = await import("./lifecycle.ts");

const PROJECT_ID = "plantest";
const REPO_PATH = "/tmp/plan-test-repo";
const API_URL = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// The fake Herdr: one request per connection, NDJSON, connection closed after the reply.
// ---------------------------------------------------------------------------

type Frame = { result?: unknown; error?: { code: string; message: string } };
type Handler = (params: Record<string, unknown>) => Frame;

/** Replaced per test. A method with no handler answers `unknown_method`, never silence. */
let handlers: Record<string, Handler> = {};
/** Every request the fake received, in order. This is the assertion surface. */
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
    // Narrowed to a non-null object above; the only writer is this repo's own client.
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

/** The methods seen so far, so a test can assert the whole sequence in one line. */
const sequence = () => calls.map((c) => c.method);
const paramsOf = (method: string) => calls.find((c) => c.method === method)?.params;

function reset(next: Record<string, Handler>): void {
  calls = [];
  handlers = next;
}

/**
 * A Herdr that behaves the way a real one does across a Plan.
 *
 * Two pieces of realism, both load-bearing:
 *
 *  - The agent does not exist until `agent.start` names it, and exists from then on. That
 *    statefulness is what makes the idempotent re-focus testable at all.
 *  - **`agent.start` returns before the agent is usable** (memory/spawn.md). Its reply carries
 *    no `agent_status` and no `interactive_ready`, exactly as the real premature return does,
 *    and `agent.prompt` is REFUSED with `agent_not_ready` until the agent is ready — which is
 *    the production failure this fake exists to reproduce.
 *
 * Readiness advances with `agent.get` polls rather than with the wall clock, so a boot that
 * never polls never becomes ready. That is deliberate: it makes deleting the readiness guard a
 * hard test failure instead of a slow pass, and it needs no sleeps to be deterministic.
 */
function liveHerdr(
  options: {
    startFails?: { code: string; message: string };
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
  const started = new Set<string>();
  /** `agent.get` calls for an agent that has been started. */
  let polls = 0;
  /** Prompts Herdr refused because the agent was not registered yet. The guard keeps this 0. */
  const refused = { prompts: 0 };

  return {
    started,
    refused,
    handlers: {
      "agent.get": (p) => {
        if (!started.has(String(p["target"]))) return NOT_FOUND;
        polls++;
        if (polls <= nameless) return NOT_FOUND;
        const ready = polls > nameless + unready;
        return {
          result: {
            agent: {
              pane_id: "wZZ:p1",
              workspace_id: "wZZ",
              agent_status: ready ? "idle" : "unknown",
              ...(ready ? { interactive_ready: true } : {}),
            },
          },
        };
      },
      "workspace.create": () => ({
        result: {
          type: "workspace_created",
          workspace: { workspace_id: "wZZ" },
          root_pane: { pane_id: "wZZ:p1" },
        },
      }),
      "agent.start": (p) => {
        if (options.startFails) return { error: options.startFails };
        started.add(String(p["name"]));
        // Premature on purpose: a name, and nothing that says the agent can be used.
        return { result: { type: "agent_started", agent: { name: p["name"] } } };
      },
      "agent.prompt": () => {
        if (polls <= nameless + unready) {
          refused.prompts++;
          return {
            error: {
              code: "agent_not_ready",
              message: "agent ticket-plantest-1-plan is not an active named agent",
            },
          };
        }
        return { result: { type: "agent_prompted" } };
      },
      "agent.focus": () => ({ result: { type: "ok" } }),
      "workspace.close": () => ({ result: { type: "ok" } }),
    } satisfies Record<string, Handler>,
  };
}

// ---------------------------------------------------------------------------
// The store. Seeded directly, bypassing every code path under test (port-slots.test.ts).
// ---------------------------------------------------------------------------

const ANCIENT = "2020-01-01T00:00:00.000Z";
// `owner`/`repo` and `provision_state: 'ready'` are stated rather than left to default: the
// startup backfill reads a project's GitHub identity from its repo's `origin`, and this
// fixture repo has no remote, so an unstated row would migrate to `failed` and every route
// below would answer `project_not_provisioned` instead of what it is meant to test.
db.prepare(
  `INSERT INTO projects (id, name, owner, repo, repo_path, base_branch, provision_state, created_at, updated_at)
   VALUES (?, ?, 'acme', 'plan-test', ?, ?, 'ready', ?, ?)`,
).run(PROJECT_ID, "Plan Test", REPO_PATH, "main", nowIso(), nowIso());

function seed(id: string, number: number, status = "backlog"): string {
  db.prepare(
    "INSERT INTO tickets (id, project_id, number, title, description, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, PROJECT_ID, number, `ticket ${id}`, "", status, ANCIENT, ANCIENT);
  return id;
}

const storedSlot = (id: string) =>
  db.prepare("SELECT port_slot FROM tickets WHERE id = ?").get(id)?.["port_slot"] ?? null;
const storedStatus = (id: string) =>
  db.prepare("SELECT status FROM tickets WHERE id = ?").get(id)?.["status"] ?? null;

const planTicket = (id: string, number: number, status: PlanTicket["status"]): PlanTicket => ({
  id,
  projectId: PROJECT_ID,
  number,
  status,
});

/**
 * A `PlanSpec` for a card in the state Plan is usually clicked on: a title and nothing else.
 * The opening message is built from these, so the empty fields are the interesting default.
 */
const planSpec = (ticketId: string, number: number, over: Partial<PlanSpec> = {}): PlanSpec => ({
  ticketId,
  projectId: PROJECT_ID,
  number,
  title: `ticket ${ticketId}`,
  description: "",
  playbook: "Fullstack",
  taskBreakdown: [],
  acceptanceCriteria: [],
  repoPath: REPO_PATH,
  ...over,
});

// ---------------------------------------------------------------------------
// The server child, for the route tests.
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: dir,
    DB_PATH: join(dir, "10x.db"),
    HERDR_SOCKET_PATH: socketPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (c: unknown) => {
  serverLog += String(c);
});
child.stderr.on("data", (c: unknown) => {
  serverLog += String(c);
});

// Boot talks to the fake (reconciliation, the plan sweep), so it needs answers before the
// first probe rather than after the first test sets its own.
reset({
  "workspace.list": () => ({ result: { type: "workspace_list", workspaces: [] } }),
  "agent.list": () => ({ result: { type: "agent_list", agents: [] } }),
  "worktree.list": () => ({ result: { type: "worktree_list", worktrees: [] } }),
});

{
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${API_URL}/projects`).then((r) => r.text());
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`server never came up: ${serverLog}\n${err}`);
      await delay(100);
    }
  }
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

after(async () => {
  child.kill("SIGTERM");
  for (const socket of sockets) socket.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("startPlanning", () => {
  test("starts a workspace, starts the agent, prompts it, then focuses", async () => {
    const fake = liveHerdr();
    reset(fake.handlers);

    const result = await startPlanning(planSpec("t-seq", 1), API_URL);

    // The order IS the contract, and the `agent.get` between the start and the prompt is the
    // load-bearing part: `agent.start` returns before the agent is usable, so the boot polls
    // until Herdr answers ready and only then speaks. The agent must also be prompted before
    // the user is moved, because `--append-system-prompt` configures an agent without
    // starting a turn — focus-then-prompt lands the human in a silent pane, and prompt-less
    // lands them in one that never speaks at all.
    assert.deepEqual(sequence(), [
      "agent.get",
      "workspace.create",
      "agent.start",
      "agent.get",
      "agent.prompt",
      "agent.focus",
    ]);
    assert.deepEqual(result, {
      agentName: "ticket-plantest-1-plan",
      workspaceId: "wZZ",
      paneId: "wZZ:p1",
      reused: false,
    });

    // No worktree, no branch, and the pane comes off the create response rather than a
    // second `pane.list` round trip (`workspace_created` carries a full `root_pane`).
    assert.deepEqual(paramsOf("workspace.create"), {
      cwd: REPO_PATH,
      label: "ticket-plantest-1-plan",
      focus: false,
    });

    const promptFile = join(dir, "prompts", "plantest-1-plan.md");
    assert.deepEqual(paramsOf("agent.start"), {
      name: "ticket-plantest-1-plan",
      kind: "omp",
      pane_id: "wZZ:p1",
      timeout_ms: 60_000,
      args: ["--append-system-prompt", promptFile, "--auto-approve"],
    });

    // The prompt is what makes the planner able to write the ticket at all, so an
    // unsubstituted marker is a silently useless run.
    const prompt = await readFile(promptFile, "utf8");
    assert.match(prompt, new RegExp(`PATCH ${API_URL}/tickets/t-seq`));
    assert.doesNotMatch(prompt, /\{\{/);

    // Exactly one opening turn, carrying the card as it stands. `prompts/plan.md` tells the
    // agent to skip anything already filled in, which it can only do having been shown the
    // fields — and an empty description must read as empty, not as a question to ask.
    assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1);
    const opening = paramsOf("agent.prompt") as { target: string; text: string };
    assert.equal(opening.target, "ticket-plantest-1-plan");
    assert.match(opening.text, /^TICKET PLANTEST-1: ticket t-seq$/m);
    assert.match(opening.text, /Description:\n\(empty\)$/m);
  });

  test("the opening message carries the whole card, not just the title", async () => {
    const fake = liveHerdr();
    reset(fake.handlers);

    await startPlanning(
      planSpec("t-full", 6, {
        title: "Rate limit the API",
        description: "429 after 100 req/min",
        playbook: "Backend",
        taskBreakdown: [{ text: "pick a bucket", done: true }],
        acceptanceCriteria: [{ text: "101st request is refused", done: false }],
      }),
      API_URL,
    );

    const { text } = paramsOf("agent.prompt") as { text: string };
    assert.match(text, /^TICKET PLANTEST-6: Rate limit the API$/m);
    assert.match(text, /Description:\n429 after 100 req\/min$/m);
    assert.match(text, /^Playbook: Backend$/m);
    assert.match(text, /^Task breakdown:\n- \[x\] pick a bucket$/m);
    assert.match(text, /^Acceptance criteria:\n- \[ \] 101st request is refused$/m);
  });

  test("a second Plan re-focuses the live planner instead of starting a rival", async () => {
    const fake = liveHerdr();
    reset(fake.handlers);
    const spec = planSpec("t-again", 2);

    await startPlanning(spec, API_URL);
    calls = [];

    const again = await startPlanning(spec, API_URL);

    // Nothing created and nothing restarted, and above all nothing prompted: re-prompting
    // would restart the conversation mid-flight, and a planner waiting on a human is
    // `blocked`, which `agent.prompt` refuses outright.
    assert.deepEqual(sequence(), ["agent.get", "agent.focus"]);
    assert.deepEqual(again, {
      agentName: "ticket-plantest-2-plan",
      workspaceId: "wZZ",
      paneId: "wZZ:p1",
      reused: true,
    });
  });

  test("a Herdr fault while looking for the planner is not read as 'no planner'", async () => {
    // Only `agent_not_found` means absent. A timeout treated as absence would start a second
    // planner beside a live conversation.
    reset({
      "agent.get": () => ({ error: { code: "agent_pane_not_found", message: "boom" } }),
    });

    await assert.rejects(
      startPlanning(planSpec("t-fault", 3), API_URL),
      /agent_pane_not_found/,
    );
    assert.deepEqual(sequence(), ["agent.get"]);
  });

  test("a failed agent.start closes the workspace instead of leaking a pane", async () => {
    const fake = liveHerdr({ startFails: { code: "agent_kind_not_installed", message: "no omp" } });
    reset(fake.handlers);

    await assert.rejects(
      startPlanning(planSpec("t-fail", 4), API_URL),
      /agent_kind_not_installed/,
    );

    assert.deepEqual(sequence(), [
      "agent.get",
      "workspace.create",
      "agent.start",
      "workspace.close",
    ]);
    assert.deepEqual(paramsOf("workspace.close"), { workspace_id: "wZZ" });
  });

  test("agent_pane_busy is retried — a fresh pane's shell is not ready yet", async () => {
    // Measured at 2 of 6 trials on a freshly created pane (memory/spawn.md), so without the
    // retry Plan fails about a third of the time.
    const fake = liveHerdr();
    let attempts = 0;
    reset({
      ...fake.handlers,
      "agent.start": (p) => {
        attempts++;
        if (attempts === 1) return { error: { code: "agent_pane_busy", message: "shell busy" } };
        return fake.handlers["agent.start"](p);
      },
    });

    const result = await startPlanning(planSpec("t-busy", 5), API_URL);
    assert.equal(result.reused, false);
    assert.equal(attempts, 2);
    assert.deepEqual(sequence(), [
      "agent.get",
      "workspace.create",
      "agent.start",
      "agent.start",
      "agent.get",
      "agent.prompt",
      "agent.focus",
    ]);
  });

  test("agent_not_ready on the opening prompt is retried, not surfaced as a failed Plan", async () => {
    // `agent.start` returns before Herdr has registered the agent (memory/spawn.md), so the
    // first prompt after a start routinely lands too early. Same bounds as runner.ts: 40
    // attempts at 250ms.
    const fake = liveHerdr();
    let attempts = 0;
    reset({
      ...fake.handlers,
      "agent.prompt": () => {
        attempts++;
        if (attempts <= 2) return { error: { code: "agent_not_ready", message: "not yet" } };
        return fake.handlers["agent.prompt"]();
      },
    });

    const result = await startPlanning(planSpec("t-notready", 7), API_URL);

    assert.equal(result.reused, false);
    assert.equal(attempts, 3);
    // The Plan succeeds and the user is still focused into it.
    assert.equal(sequence().at(-1), "agent.focus");
  });

  test("an opening prompt that really fails closes the workspace", async () => {
    // A planner that started but never got its first turn is mute for good: the re-focus path
    // deliberately does not prompt, so every later click would land on a dead agent.
    const fake = liveHerdr();
    reset({
      ...fake.handlers,
      "agent.prompt": () => ({ error: { code: "agent_pane_not_found", message: "gone" } }),
    });

    await assert.rejects(startPlanning(planSpec("t-mute", 8), API_URL), /agent_pane_not_found/);

    assert.deepEqual(sequence(), [
      "agent.get",
      "workspace.create",
      "agent.start",
      "agent.get",
      "agent.prompt",
      "workspace.close",
    ]);
  });

  test("an agent.start that returns before the agent is gettable still lands its prompt", async () => {
    // THE REGRESSION. Plan shipped without the readiness poll and this is what the user got:
    // `500 agent_not_ready: agent ticket-10x-4-plan is not an active named agent`, with an
    // unnamed omp agent running in the pane and `agent.get <name>` answering
    // `agent_not_found`. The start had returned; the NAME had not registered.
    const fake = liveHerdr({ namelessGets: 4, unreadyGets: 2 });
    reset(fake.handlers);

    const result = await startPlanning(planSpec("t-late", 9), API_URL);

    assert.equal(result.reused, false);
    // Polled through the whole nameless window and then through `unknown`, and only spoke
    // after that: seven gets, then one prompt that was never refused.
    const after = sequence().slice(sequence().indexOf("agent.start"));
    assert.deepEqual(after, [
      "agent.start",
      ...Array<string>(7).fill("agent.get"),
      "agent.prompt",
      "agent.focus",
    ]);
    assert.equal(fake.refused.prompts, 0);
  });

  test("the opening turn is never sent before the readiness poll says ready", async () => {
    // Same guarantee stated as the fake sees it: this Herdr refuses any `agent.prompt` that
    // arrives while the agent is still `unknown`, and counts it. Deleting the poll from
    // `agent-boot.ts` fails this test — the prompt retry is a last line of defence, not the
    // guard, and it cannot tell "not registered yet" from "never will be".
    const fake = liveHerdr({ unreadyGets: 3 });
    reset(fake.handlers);

    await startPlanning(planSpec("t-order", 10), API_URL);

    assert.equal(fake.refused.prompts, 0);
    assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1);
    // Every readiness poll precedes the only prompt.
    assert.ok(sequence().lastIndexOf("agent.get") < sequence().indexOf("agent.prompt"));
  });
});

describe("decidePlanSweep", () => {
  const workspace = (id: string, label: string | null) => ({ workspace_id: id, label });
  const label = planAgentNameFor(PROJECT_ID, 9);

  test("spares a backlog ticket's planner — the user may be mid-conversation", () => {
    // Herdr keeps panes and agents alive across a restart of this process, so a plan
    // workspace surviving a boot is the NORMAL state of an ongoing conversation.
    const decisions = decidePlanSweep(
      [workspace("w1", label)],
      [planTicket("t-9", 9, "backlog")],
    );
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.close, false);
    assert.match(decisions[0]?.reason ?? "", /still in backlog/);
  });

  test("closes a planner whose ticket has left backlog", () => {
    for (const status of ["todo", "in_progress", "in_review", "done"] as const) {
      const decisions = decidePlanSweep(
        [workspace("w1", label)],
        [planTicket("t-9", 9, status)],
      );
      assert.deepEqual(
        decisions.map((d) => [d.workspaceId, d.close]),
        [["w1", true]],
        `status ${status}`,
      );
    }
  });

  test("closes a planner whose ticket is gone", () => {
    const decisions = decidePlanSweep([workspace("w1", label)], []);
    assert.equal(decisions[0]?.close, true);
    assert.match(decisions[0]?.reason ?? "", /no ticket owns/);
  });

  test("a workspace we did not label is never a candidate", () => {
    // Not "spared": outside the set the sweep will even consider, the same structural
    // ownership test findOrphans applies to a branch namespace.
    const decisions = decidePlanSweep(
      [
        workspace("w1", "10x"),
        workspace("w2", "refactor-plan"),
        workspace("w3", "ticket-plantest-9"),
        workspace("w4", null),
      ],
      [],
    );
    assert.deepEqual(decisions, []);
  });
});

describe("sweepPlanWorkspaces", () => {
  test("closes only the workspaces it decided to close", async () => {
    seed("t-sweep-live", 20, "backlog");
    seed("t-sweep-done", 21, "done");
    reset({
      "workspace.list": () => ({
        result: {
          type: "workspace_list",
          workspaces: [
            { workspace_id: "wLIVE", label: planAgentNameFor(PROJECT_ID, 20) },
            { workspace_id: "wDONE", label: planAgentNameFor(PROJECT_ID, 21) },
            { workspace_id: "wGONE", label: planAgentNameFor(PROJECT_ID, 22) },
            { workspace_id: "wMINE", label: "10x" },
          ],
        },
      }),
      "workspace.close": () => ({ result: { type: "ok" } }),
    });

    const decisions = await sweepPlanWorkspaces([
      planTicket("t-sweep-live", 20, "backlog"),
      planTicket("t-sweep-done", 21, "done"),
    ]);

    assert.deepEqual(
      decisions.map((d) => [d.workspaceId, d.close]),
      [
        ["wLIVE", false],
        ["wDONE", true],
        ["wGONE", true],
      ],
    );
    assert.deepEqual(
      calls.filter((c) => c.method === "workspace.close").map((c) => c.params["workspace_id"]),
      ["wDONE", "wGONE"],
    );
  });

  test("a Herdr that is down does not stop the boot", async () => {
    reset({});
    assert.deepEqual(await sweepPlanWorkspaces([]), []);
  });
});

describe("POST /tickets/:id/plan", () => {
  test("a non-backlog ticket is refused, and nothing is started", async () => {
    const id = seed("route-todo", 30, "todo");
    const fake = liveHerdr();
    reset(fake.handlers);

    const res = await api("POST", `/tickets/${id}/plan`);
    assert.equal(res.status, 409);
    assert.equal(res.body["error"], "not_in_backlog");
    assert.equal(res.body["status"], "todo");
    assert.deepEqual(sequence(), []);
  });

  test("a backlog ticket gets a planner, and keeps its status and no port slot", async () => {
    const id = seed("route-plan", 31, "backlog");
    const fake = liveHerdr();
    reset(fake.handlers);

    const res = await api("POST", `/tickets/${id}/plan`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      ok: true,
      agentName: "ticket-plantest-31-plan",
      workspaceId: "wZZ",
      paneId: "wZZ:p1",
      reused: false,
    });

    // Plan never promotes: a human clicks the button that does. And a planner starts no dev
    // server, so spending a tenth of the port pool on a conversation would be pure loss.
    assert.equal(storedStatus(id), "backlog");
    assert.equal(storedSlot(id), null);
    // No worktree anywhere in the sequence — the planner runs in the main checkout.
    assert.deepEqual(sequence().filter((m) => m.startsWith("worktree.")), []);

    // The route is where the ticket's fields come from, so this is what catches a PlanSpec
    // that compiles but hands the planner an empty card.
    const opening = paramsOf("agent.prompt") as { target: string; text: string };
    assert.equal(opening.target, "ticket-plantest-31-plan");
    assert.match(opening.text, /^TICKET PLANTEST-31: ticket route-plan$/m);
    assert.match(opening.text, /^Playbook: Fullstack$/m);
  });

  test("clicking Plan twice re-focuses instead of creating a second workspace", async () => {
    const id = seed("route-twice", 32, "backlog");
    const fake = liveHerdr();
    reset(fake.handlers);

    assert.equal((await api("POST", `/tickets/${id}/plan`)).status, 200);
    const second = await api("POST", `/tickets/${id}/plan`);

    assert.equal(second.status, 200);
    assert.equal(second.body["reused"], true);
    assert.equal(sequence().filter((m) => m === "workspace.create").length, 1);
    assert.equal(sequence().filter((m) => m === "agent.start").length, 1);
    // Re-prompting a live planner would restart its conversation, and it is very likely
    // `blocked` on a question anyway — which `agent.prompt` refuses outright.
    assert.equal(sequence().filter((m) => m === "agent.prompt").length, 1);
  });

  test("a Herdr failure is a 500 that says what broke, and leaves the ticket alone", async () => {
    const id = seed("route-broken", 33, "backlog");
    const fake = liveHerdr({ startFails: { code: "agent_kind_not_installed", message: "no omp" } });
    reset(fake.handlers);

    const res = await api("POST", `/tickets/${id}/plan`);
    assert.equal(res.status, 500);
    assert.match(String(res.body["error"]), /agent_kind_not_installed/);
    assert.equal(storedStatus(id), "backlog");
    assert.equal(storedSlot(id), null);
    // The pane it half-created is closed rather than left for the next boot to find.
    assert.deepEqual(paramsOf("workspace.close"), { workspace_id: "wZZ" });
  });

  test("plan on a ticket that does not exist is a 404, not a started agent", async () => {
    reset({});
    const res = await api("POST", "/tickets/nope/plan");
    assert.equal(res.status, 404);
    assert.equal(res.body["error"], "no_such_ticket");
  });
});

describe("a live planner on the board", () => {
  /** `agent.list` reporting one live planner, plus the empty worktree reads `board()` does. */
  function boardHerdr(agentName: string) {
    return {
      "agent.list": () => ({
        result: {
          type: "agent_list",
          agents: [
            {
              name: agentName,
              agent_status: "working",
              pane_id: "wZZ:p1",
              workspace_id: "wZZ",
            },
          ],
        },
      }),
      "worktree.list": () => ({ result: { type: "worktree_list", worktrees: [] } }),
      "agent.focus": () => ({ result: { type: "ok" } }),
    } satisfies Record<string, Handler>;
  }

  test("a backlog ticket reports its planner through the ordinary agent fields", async () => {
    // The planner's name differs from the implementation agent's by design, so a board that
    // joined only on `agentNameFor` reported null for the whole planning run: no agent chip
    // and no column spinner, with a live conversation sitting in Herdr.
    const id = seed("board-planning", 34, "backlog");
    reset(boardHerdr(planAgentNameFor(PROJECT_ID, 34)));

    const res = await api("GET", "/tickets?project=" + PROJECT_ID);
    const ticket = (res.body["tickets"] as Record<string, unknown>[]).find((t) => t["id"] === id);

    assert.equal(ticket?.["agentName"], "ticket-plantest-34-plan");
    assert.equal(ticket?.["agentStatus"], "working");
    assert.equal(ticket?.["paneId"], "wZZ:p1");
    assert.equal(ticket?.["workspaceId"], "wZZ");
    // No new status vocabulary, and no worktree: a planner has neither.
    assert.equal(ticket?.["status"], "backlog");
    assert.equal(ticket?.["hasWorktree"], false);
  });

  test("a promoted ticket does not inherit its stale planner's status", async () => {
    // The sweep only runs at boot, so a planner can outlive the promotion. Reporting it would
    // show work happening on a card nobody has started.
    const id = seed("board-promoted", 35, "todo");
    reset(boardHerdr(planAgentNameFor(PROJECT_ID, 35)));

    const res = await api("GET", "/tickets?project=" + PROJECT_ID);
    const ticket = (res.body["tickets"] as Record<string, unknown>[]).find((t) => t["id"] === id);

    assert.equal(ticket?.["agentName"], "ticket-plantest-35");
    assert.equal(ticket?.["agentStatus"], null);
  });

  test("Focus on a backlog card targets the planner, not a nonexistent run", async () => {
    const id = seed("board-focus", 36, "backlog");
    reset(boardHerdr(planAgentNameFor(PROJECT_ID, 36)));

    const res = await api("POST", `/tickets/${id}/focus`);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(paramsOf("agent.focus"), { target: "ticket-plantest-36-plan" });
  });
});

describe("DELETE /tickets/:id on a backlog ticket", () => {
  // Regression coverage for the bug this describe block exists to pin: teardown() used to
  // resolve the agent name with the bare `agentNameFor` unconditionally, so deleting a
  // backlog ticket asked Herdr about a name that was never assigned (`agent_not_found`),
  // logged a misleading "agent is gone" warning, and never touched the real, live planner —
  // orphaning its workspace until the next boot's plan sweep (memory/reconciliation.md).

  test("closes the live planner's workspace, not a nonexistent bare-named one", async () => {
    const id = seed("delete-with-planner", 40, "backlog");
    const planName = planAgentNameFor(PROJECT_ID, 40);

    // Actually start a live planner first, exactly as a user clicking Plan would.
    const plan = liveHerdr();
    reset(plan.handlers);
    assert.equal((await api("POST", `/tickets/${id}/plan`)).status, 200);

    const logBefore = serverLog.length;
    reset({
      "agent.get": () => ({
        result: { agent: { pane_id: "wZZ:p1", workspace_id: "wZZ", agent_status: "working" } },
      }),
      "workspace.close": () => ({ result: { type: "ok" } }),
    });

    const res = await api("DELETE", `/tickets/${id}`);
    assert.equal(res.status, 200);

    // Asked about the PLANNER's name, found it live, and closed its workspace — no worktree
    // conversation at all, because a backlog ticket never has one.
    assert.deepEqual(sequence(), ["agent.get", "workspace.close"]);
    assert.equal(paramsOf("agent.get")?.["target"], planName);
    assert.equal(paramsOf("workspace.close")?.["workspace_id"], "wZZ");
    assert.equal(getTicket(id), undefined);
    assert.ok(!serverLog.slice(logBefore).includes("no session directory known and agent is gone"));
  });

  test("a ticket whose planner never ran deletes quietly: no warning, no worktree lookup", async () => {
    const id = seed("delete-no-planner", 41, "backlog");
    const planName = planAgentNameFor(PROJECT_ID, 41);

    const logBefore = serverLog.length;
    reset({ "agent.get": () => NOT_FOUND });

    const res = await api("DELETE", `/tickets/${id}`);
    assert.equal(res.status, 200);

    // Asked about the PLANNER's name (not the bare implementation name, which a backlog
    // ticket can never have run) and stopped there once told it does not exist.
    assert.deepEqual(sequence(), ["agent.get"]);
    assert.equal(paramsOf("agent.get")?.["target"], planName);
    assert.equal(getTicket(id), undefined);
    // `agent_not_found` for a ticket whose real agent never ran is the expected, common case
    // — not a fault worth a warning.
    assert.ok(!serverLog.slice(logBefore).includes("no session directory known and agent is gone"));
  });

  test("a ticket that has left backlog still tears down the real implementation agent, unchanged", async () => {
    const id = seed("delete-todo", 42, "todo");
    const bareName = agentNameFor(PROJECT_ID, 42);

    reset({
      "agent.get": () => NOT_FOUND,
      "worktree.open": () => ({ error: { code: "worktree_not_found", message: "no such worktree" } }),
    });

    const res = await api("DELETE", `/tickets/${id}`);
    assert.equal(res.status, 200);

    // Still the bare name once a ticket has left backlog — no regression from the status-aware
    // resolution added for the planner case above.
    assert.deepEqual(sequence(), ["agent.get", "worktree.open"]);
    assert.equal(paramsOf("agent.get")?.["target"], bareName);
    assert.equal(getTicket(id), undefined);
  });
});
