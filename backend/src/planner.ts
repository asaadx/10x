/**
 * The planning conversation: a second agent per ticket, for the Backlog stage.
 *
 * Deliberately NOT `runner.ts`. A planner talks to a human about what a ticket should say and
 * writes nothing but the ticket itself, so it gets **no worktree, no branch and no port slot**
 * and runs in the project's main checkout. That is the whole reason this is a separate module:
 * every expensive, destructive part of `spawn` — the worktree, the injected `.env`, the
 * readiness poll, the completion subscription that moves the ticket to In Review — is wrong
 * here, and sharing the code would mean sharing the parts that must not run.
 *
 * The two things it does share are named once and imported: the agent name
 * (`planAgentNameFor`, whose suffix is what keeps Start from adopting a planner) and the
 * prompt loader.
 *
 * The one thing it must do that looks like `runner.ts`: send an opening `agent.prompt` after
 * the start. `--append-system-prompt` installs a system prompt, it does not create a turn, so
 * an agent that is only started sits there saying nothing. What is forbidden is *waiting* on
 * that message — no `--wait`, no completion subscription, nothing that blocks on the
 * conversation — because the planner's first act is to ask the human a question and the
 * answer may be hours away. Send it and return.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrError, request } from "./herdr.ts";
import { AGENT_NAME_RE, planAgentNameFor } from "./lifecycle.ts";
import { loadPrompt } from "./prompts.ts";
import type { ChecklistItem, Playbook } from "./types.ts";

/** Same resolution as runner.ts: the prompt file must live outside any repo the agent sees. */
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), ".10x");

/** How long a fresh pane may take to become an available shell before we give up. */
const PANE_WAIT_MS = 15_000;

/**
 * The opening prompt's retry bounds, mirrored from runner.ts rather than re-tuned. An
 * `agent.prompt` sent before Herdr has registered the freshly started agent fails
 * `agent_not_ready` (memory/spawn.md), and that race is the same one for both agent kinds.
 */
const PROMPT_ATTEMPTS = 40;
const PROMPT_RETRY_MS = 250;

/**
 * What a plan run needs. `repoPath` is the project's main checkout — there is no worktree.
 *
 * The ticket's own fields are carried for the opening message, not for the system prompt.
 * `prompts/plan.md` tells the agent to skip anything already filled in and use it as context,
 * and it can only obey that if it is handed the card as it stands.
 */
export type PlanSpec = {
  ticketId: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  playbook: Playbook;
  taskBreakdown: ChecklistItem[];
  acceptanceCriteria: ChecklistItem[];
  repoPath: string;
};

export type PlanResult = {
  agentName: string;
  workspaceId: string | null;
  paneId: string | null;
  /** True when a live planner was re-focused instead of a second one being started. */
  reused: boolean;
};

type PaneInfo = { pane_id: string };
type WorkspaceCreated = { workspace: { workspace_id: string }; root_pane: PaneInfo };
type AgentRecord = { pane_id?: string; workspace_id?: string };
type AgentEnvelope = { agent?: AgentRecord };

/**
 * The ticket's planner, or undefined if there is none.
 *
 * `agent_not_found` is the one Herdr code that unambiguously means "no such agent" — the same
 * distinction `retireAgent` and the stream-reopen probe in runner.ts rely on. Any other code
 * is a real fault and must not be read as an absence, or a Herdr hiccup would silently start a
 * second planner beside a live conversation.
 */
async function livePlanner(name: string): Promise<AgentRecord | undefined> {
  try {
    const got = await request<AgentEnvelope>("agent.get", { target: name });
    return got.agent ?? {};
  } catch (err) {
    if (err instanceof HerdrError && err.code === "agent_not_found") return undefined;
    throw err;
  }
}

/**
 * `agent.start` against a pane whose shell has not reached its interactive prompt yet fails
 * with `agent_pane_busy` — nondeterministically, in 2 of 6 measured trials on a freshly
 * created pane (memory/spawn.md), which is exactly what `workspace.create` hands us. So the
 * retry is not defensive padding; without it Plan fails about a third of the time.
 *
 * Every other code is a real fault (bad name, missing pane, agent kind not installed) and
 * surfaces immediately: a fatal error retried is just a slower error.
 *
 * runner.ts's readiness poll is still NOT mirrored, but the reason has changed now that this
 * module prompts. That poll exists to keep `agent.prompt` off an agent reporting `unknown`;
 * here the same race is absorbed where it actually surfaces, by the `agent_not_ready` retry in
 * `promptPlanAgent`, on runner.ts's own bounds. A planner has no completion subscription to
 * arm before its first turn, so knowing the moment it became ready buys nothing else.
 */
async function startPlanAgent(name: string, paneId: string, promptFile: string): Promise<void> {
  const deadline = Date.now() + PANE_WAIT_MS;
  let backoff = 250;
  for (;;) {
    try {
      await request("agent.start", {
        name,
        kind: "omp",
        pane_id: paneId,
        timeout_ms: 60_000,
        args: ["--append-system-prompt", promptFile, "--auto-approve"],
      });
      return;
    } catch (err) {
      if (!(err instanceof HerdrError) || err.code !== "agent_pane_busy") throw err;
      if (Date.now() + backoff > deadline) {
        throw new HerdrError(
          "agent_pane_busy",
          `pane ${paneId} never became an available shell within ${PANE_WAIT_MS}ms`,
        );
      }
      await delay(backoff);
      backoff = Math.min(backoff * 2, 2_000);
    }
  }
}

/**
 * The opening message: the card as it stands, and nothing else.
 *
 * Everything about how to behave lives in `prompts/plan.md` — duplicating any of it here would
 * make two places to change. This is context plus a go signal. Empty fields are named as empty
 * rather than omitted, so a ticket created with only a title sends the agent straight to the
 * description instead of asking about one it can see is blank.
 */
function openingMessage(spec: PlanSpec): string {
  // An empty list joins to "", so the `|| "(empty)"` below names it rather than leaving a
  // heading with nothing under it.
  const checked = (item: ChecklistItem) => `- [${item.done ? "x" : " "}] ${item.text}`;

  return [
    `TICKET ${spec.projectId.toUpperCase()}-${spec.number}: ${spec.title}`,
    "",
    "Description:",
    spec.description.trim() || "(empty)",
    "",
    `Playbook: ${spec.playbook}`,
    "",
    "Task breakdown:",
    spec.taskBreakdown.map(checked).join("\n") || "(empty)",
    "",
    "Acceptance criteria:",
    spec.acceptanceCriteria.map(checked).join("\n") || "(empty)",
    "",
    "That is the whole ticket. Start the conversation.",
  ].join("\n");
}

/**
 * Send the opening turn, and return the moment Herdr has taken it.
 *
 * `agent_not_ready` from `agent.prompt` means the agent is not registered yet — the fresh-pane
 * race (memory/gotchas.md), expected immediately after `agent.start` and never a reason to
 * fail the Plan. Same 40 attempts at 250ms the implementation path uses. Every other code is a
 * real fault and surfaces at once.
 */
async function promptPlanAgent(name: string, text: string): Promise<void> {
  for (let attempt = 1; attempt <= PROMPT_ATTEMPTS; attempt++) {
    try {
      await request("agent.prompt", { target: name, text });
      return;
    } catch (err) {
      const notReady = err instanceof HerdrError && err.code === "agent_not_ready";
      if (!notReady || attempt === PROMPT_ATTEMPTS) throw err;
      await delay(PROMPT_RETRY_MS);
    }
  }
}

/**
 * Start (or re-join) the planning conversation for one ticket, and leave the user looking at
 * it. The caller owns the status guard: Plan is the Backlog conversation and never writes a
 * status of its own.
 *
 * Idempotent by design. A second click must resume the existing conversation, not start a
 * rival one or destroy its context — and because Herdr keeps panes and agents alive across a
 * restart of this process, "existing" includes a planner from before the last boot.
 */
export async function startPlanning(spec: PlanSpec, apiUrl: string): Promise<PlanResult> {
  const name = planAgentNameFor(spec.projectId, spec.number);
  // The slug regex is laxer than Herdr's agent-name regex once the `-plan` suffix is added
  // (memory/naming.md), and a name Herdr refuses would otherwise fail only after the
  // workspace existed. Say which name and why instead.
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `plan agent name "${name}" is ${name.length} chars; Herdr allows 32 — ` +
        "the project slug is too long to carry the -plan suffix",
    );
  }

  const existing = await livePlanner(name);
  if (existing) {
    // Focus only — never a second prompt. This mirrors runner.ts's re-attach guard: the
    // conversation is already under way, and re-prompting would restart it mid-flight and
    // discard the context the human has spent the last ten minutes supplying. `agent.prompt`
    // would usually refuse anyway, because an agent waiting on a human question is `blocked`
    // and a blocked agent is refused with `agent_blocked` (memory/agent-status.md).
    await request("agent.focus", { target: name });
    return {
      agentName: name,
      workspaceId: existing.workspace_id ?? null,
      paneId: existing.pane_id ?? null,
      reused: true,
    };
  }

  // Written before anything is created in Herdr: a bad prompt file (a renamed marker, an
  // unwritable state dir) then fails with nothing to clean up. `prompts/plan.md` tells the
  // agent to PATCH the ticket, so both markers are load-bearing — `renderPrompt` throws if
  // either is left unsubstituted rather than shipping a prompt the agent cannot act on.
  const promptFile = join(STATE_DIR, "prompts", `${spec.projectId}-${spec.number}-plan.md`);
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, await loadPrompt("plan", { apiUrl, ticketId: spec.ticketId }), "utf8");

  // `workspace.create`, not `worktree.create`: the planner reads and discusses the codebase
  // the human is working in, and a worktree would be an empty branch nobody ever commits to.
  // The label is the plan agent name because it is the ONLY handle the boot sweep has
  // (memory/naming.md) — with no branch, nothing else identifies this workspace as ours.
  //
  // `root_pane.pane_id` comes straight off the response, exactly as runner.ts takes it from
  // `worktree.create`: the `workspace_created` result wraps `workspace`, `tab` and a full
  // `root_pane: PaneInfo` (verified live, memory/spawn.md). No `pane.list` round trip.
  const created = await request<WorkspaceCreated>("workspace.create", {
    cwd: spec.repoPath,
    label: name,
    focus: false,
  });
  const workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;

  try {
    await startPlanAgent(name, paneId, promptFile);
    await promptPlanAgent(name, openingMessage(spec));
  } catch (err) {
    // A failed Plan must not leave a pane behind: the sweep that would collect it only runs
    // at boot, and until then the user is looking at an empty workspace that a retry cannot
    // reuse. The opening prompt sits inside this guard for a second reason — a planner that
    // started but never got its first turn is mute, and the re-focus path above deliberately
    // does not prompt, so leaving it alive would make every later click land on a dead agent.
    // Reported and swallowed — the failure that got us here is the error worth returning.
    await request("workspace.close", { workspace_id: workspaceId }).catch((closeErr: unknown) =>
      console.warn(
        `[${name}] plan start failed and workspace ${workspaceId} could not be closed:`,
        closeErr,
      ),
    );
    throw err;
  }

  // Focus last, and only once the agent has been given something to do. The point of the
  // button is that the user lands in a live conversation; focusing first would drop them into
  // a pane that looks dead for as long as the prompt takes to land. This is the second place
  // in 10x that deliberately steals focus (see panes.ts), and for the same reason.
  await request("agent.focus", { target: name });

  return { agentName: name, workspaceId, paneId, reused: false };
}
