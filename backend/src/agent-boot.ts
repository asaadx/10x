/**
 * Booting an agent so that it is actually usable: the one path Start and Plan both go through.
 *
 * THE WARNING THIS MODULE EXISTS FOR (memory/spawn.md, memory/gotchas.md): the raw
 * `agent.start` socket method returns BEFORE the agent is usable, and the `herdr` CLI is what
 * does the waiting (strace shows agent.start x2 then agent.get x24). **A socket client that
 * trusts the return value loses the prompt.** What that looks like from outside is an omp agent
 * running in the pane while `agent.get <name>` answers `agent_not_found`, and an
 * `agent.prompt` that fails `agent_not_ready`: the process is alive, the NAME is not registered
 * yet, and the opening turn never lands.
 *
 * So the readiness poll sits between the start and the prompt inside `bootAgent`, and there is
 * no flag, argument or overload that turns it off. Plan once shipped without it, on the
 * argument that the `agent_not_ready` retry on the prompt absorbed the same race, and that
 * argument is wrong twice: the retry gives up after PROMPT_ATTEMPTS * PROMPT_RETRY_MS (10s)
 * where the poll waits READY_WAIT_MS (60s), and a prompt is only ever an attempt to use the
 * agent, never a wait for it — it cannot distinguish "not registered yet" from "never will be".
 * It cost a production 500 (`agent_not_ready: agent ticket-10x-4-plan is not an active named
 * agent`) on a plainly working Herdr. Retrying the wrong question is not waiting for the right
 * one.
 *
 * What stays with the caller: which pane, which `agent.start` args, what the opening turn says,
 * and everything around the boot — worktrees, port blocks, status subscriptions, workspaces.
 */
import { setTimeout as delay } from "node:timers/promises";
import { freshDiagnostics } from "./diagnostics.ts";
import { HerdrError, request } from "./herdr.ts";
import { isAgentReady } from "./lifecycle.ts";
import type { Diagnostics } from "./types.ts";

/** How long a fresh pane may take to become an available shell before we give up. */
const PANE_WAIT_MS = 15_000;
/** How long the agent may take to become interactive after start. Normally ~3s. */
const READY_WAIT_MS = 60_000;
/** Readiness cadence. 125ms is what the herdr CLI itself polls `agent.get` at. */
const READY_POLL_MS = 125;
/** Opening-prompt bounds. `agent_not_ready` here is the tail of the same race, not a fault. */
const PROMPT_ATTEMPTS = 40;
const PROMPT_RETRY_MS = 250;

/** As much of Herdr's agent record as 10x reads. Every field is optional on a premature start. */
export type AgentRecord = {
  name?: string;
  agent_status?: string;
  interactive_ready?: boolean;
  agent_session?: { value?: string };
  pane_id?: string;
  workspace_id?: string;
};

export type AgentEnvelope = { agent?: AgentRecord };

/**
 * The agent to boot, and where to record what the race did.
 *
 * `diagnostics` is the caller's live `Diagnostics` object, mutated as the boot proceeds so the
 * board can show a retry while it is still happening and keep the counters of a boot that
 * failed. Omit it — Plan has none and is not made to invent one — and the counters go to a
 * throwaway record instead of being conditionally skipped at every increment.
 */
export type AgentTarget = {
  name: string;
  paneId: string;
  diagnostics?: Diagnostics;
};

export type BootSpec = AgentTarget & {
  /** `agent.start` args: the system prompt file and approval mode are the caller's business. */
  args: string[];
  /**
   * The opening turn. Not optional: `--append-system-prompt` configures an agent without
   * starting one, so an agent that is started and never prompted sits there mute
   * (memory/spawn.md).
   */
  prompt: string;
};

export type BootedAgent = {
  /** The record from the poll that saw the agent ready. */
  record: AgentRecord;
  /** Where the agent actually lives — for a re-attached agent, not necessarily `paneId`. */
  paneId: string;
};

/**
 * `agent.start`, wait until the agent is genuinely usable, then send the opening turn.
 *
 * `agent_name_taken` is deliberately NOT handled here: only the caller knows what an existing
 * agent of that name means to it. Start re-attaches to its own agent (`reattachAgent`); Plan
 * has already looked for a live planner before creating anything, so for Plan the code is a
 * real fault that must roll the workspace back.
 */
export async function bootAgent(spec: BootSpec): Promise<BootedAgent> {
  const diag = spec.diagnostics ?? freshDiagnostics();
  const since = Date.now();

  const started = await startAgent(spec, diag, since);
  const record = await waitUntilReady(spec.name, started, diag, since);
  await promptAgent(spec.name, spec.prompt, diag);

  return { record, paneId: record.pane_id ?? spec.paneId };
}

/**
 * Adopt an agent that already holds this name: wait until it is usable and send it NOTHING.
 *
 * The readiness wait is not optional here either — an adopted agent may be mid-turn, and the
 * caller is about to use the record (its session directory, its pane) either way.
 */
export async function reattachAgent(target: AgentTarget): Promise<BootedAgent> {
  const diag = target.diagnostics ?? freshDiagnostics();
  const since = Date.now();
  diag.reusedExistingAgent = true;

  const existing = await request<AgentEnvelope>("agent.get", { target: target.name });
  recordStartReturn(diag, existing.agent, since);
  const record = await waitUntilReady(target.name, existing.agent, diag, since);

  return { record, paneId: record.pane_id ?? target.paneId };
}

/** What `agent.start` (or the `agent.get` standing in for it) handed back, for the board. */
function recordStartReturn(diag: Diagnostics, record: AgentRecord | undefined, since: number) {
  diag.startReturnedStatus = record?.agent_status ?? null;
  diag.startReturnedReady = record?.interactive_ready ?? null;
  diag.startReturnedAfterMs = Date.now() - since;
}

/**
 * Phase 1 — get `agent.start` to accept the pane at all.
 *
 * `agent_pane_busy` is the ONLY transient failure: it means the pane's shell has not reached
 * its interactive prompt yet, which is nondeterministically the state a freshly created pane
 * is in — 2 of 6 measured trials (memory/spawn.md), so without this retry a boot off a fresh
 * pane fails about a third of the time. Every other error is a real fault (bad name, missing
 * pane, agent kind not installed) and must surface immediately: a fatal error retried is just
 * a slower error.
 *
 * Bound by a deadline, not an attempt count, and back off so a slow shell does not get
 * hammered: 250ms doubling to a 2s ceiling.
 */
async function startAgent(
  spec: BootSpec,
  diag: Diagnostics,
  since: number,
): Promise<AgentRecord | undefined> {
  const deadline = Date.now() + PANE_WAIT_MS;
  let backoff = 250;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request<AgentEnvelope>("agent.start", {
        name: spec.name,
        kind: "omp",
        pane_id: spec.paneId,
        timeout_ms: 60_000,
        args: spec.args,
      });
      diag.startAttempts = attempt;
      recordStartReturn(diag, res.agent, since);
      return res.agent;
    } catch (err) {
      const transient = err instanceof HerdrError && err.code === "agent_pane_busy";
      if (!transient) {
        diag.startAttempts = attempt;
        throw err; // e.g. agent_pane_not_found, agent_name_taken, invalid_agent_name
      }
      if (Date.now() + backoff > deadline) {
        diag.startAttempts = attempt;
        throw new HerdrError(
          "agent_pane_busy",
          `pane ${spec.paneId} never became an available shell within ${PANE_WAIT_MS}ms ` +
            `(${diag.paneBusyRetries} retries)`,
        );
      }
      diag.paneBusyRetries++;
      await delay(backoff);
      backoff = Math.min(backoff * 2, 2_000);
    }
  }
}

/**
 * Phase 2 — the readiness guard. `agent.start` returning is NOT readiness, so poll `agent.get`
 * until the record itself reports ready. Normally ~3s.
 *
 * `idle` and `done` are the SAME underlying ready state (memory/agent-status.md): `done` just
 * means it settled while the tab was unseen. Accepting only `idle` hangs for the full timeout
 * on any agent that finished a turn unobserved — which is every re-attached agent.
 */
async function waitUntilReady(
  name: string,
  started: AgentRecord | undefined,
  diag: Diagnostics,
  since: number,
): Promise<AgentRecord> {
  let record = started;
  diag.neededReadinessPoll = !isAgentReady(record);

  const deadline = Date.now() + READY_WAIT_MS;
  while (!isAgentReady(record)) {
    if (Date.now() > deadline) {
      throw new HerdrError(
        "agent_not_ready",
        `agent ${name} never became interactive within ${READY_WAIT_MS}ms ` +
          `(last status: ${record?.agent_status ?? "unknown"})`,
      );
    }
    await delay(READY_POLL_MS);
    diag.readinessPolls++;
    try {
      const got = await request<AgentEnvelope>("agent.get", { target: name });
      record = got.agent;
    } catch (err) {
      // `agent_not_found` here is the normal case, not an anomaly: the agent is running in the
      // pane and Herdr has not registered its name yet. Only worth a word if it persists.
      if (diag.readinessPolls % 20 === 0) {
        console.warn(`[${name}] agent.get still failing after ${diag.readinessPolls} polls:`, err);
      }
    }
  }

  // The loop only exits once isAgentReady passed, so a record exists — but express that for
  // the type system rather than asserting it.
  if (!record) throw new HerdrError("agent_not_ready", `agent ${name} disappeared while starting`);

  diag.readyAfterMs = Date.now() - since;
  return record;
}

/**
 * Phase 3 — the opening turn.
 *
 * `agent_not_ready` from `agent.prompt` is the tail of the same registration race
 * (memory/gotchas.md) and never a reason to fail the boot. It is the LAST line of defence,
 * not the guard: see this module's header for why the poll above is what actually prevents
 * the lost prompt. Every other code is a real fault and surfaces at once.
 */
async function promptAgent(name: string, text: string, diag: Diagnostics): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await request("agent.prompt", { target: name, text });
      diag.promptAttempts = attempt;
      return;
    } catch (err) {
      const notReady = err instanceof HerdrError && err.code === "agent_not_ready";
      if (!notReady || attempt === PROMPT_ATTEMPTS) throw err;
      diag.promptNotReadyRetries++;
      await delay(PROMPT_RETRY_MS);
    }
  }
}
