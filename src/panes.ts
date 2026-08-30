/**
 * Pane navigation for the UI's "steer this agent" button.
 *
 * Agents are addressed by NAME everywhere in 10x (`ticket-<project>-<n>`), never by
 * pane id: the pane id is read live from Herdr per request and can change under us —
 * `pane.move` between workspaces reissues it (node 01 §6.2). Both socket methods here
 * take the same `AgentTarget` ({ target }), so the name is the only identifier needed.
 *
 * Verified against the generated schema (herdr 0.8.2, protocol 20):
 *   agent.focus  params AgentTarget                  -> ok
 *   agent.get    params AgentTarget                  -> { type: "agent_info", agent: AgentInfo }
 *   AgentInfo requires pane_id, tab_id, workspace_id (all plain strings)
 */
import { HerdrError, request } from "./herdr.ts";

type AgentRecord = { pane_id?: string; tab_id?: string; workspace_id?: string };
type AgentEnvelope = { agent?: AgentRecord };

export type PaneLocation = { paneId: string; tabId: string; workspaceId: string };

/**
 * Focus the agent's pane in the Herdr UI, so a later `herdr attach` lands on it.
 *
 * This is the one place in 10x that deliberately steals focus — everything else passes
 * `focus: false` / `--no-focus` (node 01 §9). Moving the user's view IS the button's
 * purpose, so it is correct here and nowhere else.
 *
 * A dead or never-started agent is an ordinary UI outcome, not an exception: the button
 * is drawn from a snapshot that may already be stale, so this reports the Herdr error
 * code instead of throwing.
 */
export async function focusAgent(agentName: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await request<unknown>("agent.focus", { target: agentName });
    return { ok: true };
  } catch (err) {
    if (err instanceof HerdrError) return { ok: false, error: err.code };
    console.warn(`[${agentName}] agent.focus failed with a non-Herdr error:`, err);
    return { ok: false, error: "focus_failed" };
  }
}

/**
 * The command the user copies into a terminal on another machine. `--remote` is a global
 * flag, so it precedes the subcommand: `herdr --remote <host> agent attach <name>`.
 */
export function attachCommand(agentName: string, host?: string): string {
  const prefix = host === undefined ? "herdr" : `herdr --remote ${host}`;
  return `${prefix} agent attach ${agentName}`;
}

/**
 * Where the agent currently lives, for display. `undefined` means "no live agent" —
 * `agent.get` rejects an unknown target, and that is the normal answer for a ticket
 * whose agent has exited, so it is not surfaced as a failure.
 */
export async function paneLocation(agentName: string): Promise<PaneLocation | undefined> {
  let agent: AgentRecord | undefined;
  try {
    ({ agent } = await request<AgentEnvelope>("agent.get", { target: agentName }));
  } catch (err) {
    if (!(err instanceof HerdrError)) {
      console.warn(`[${agentName}] agent.get failed with a non-Herdr error:`, err);
    }
    return undefined;
  }

  const { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId } = agent ?? {};
  if (!paneId || !tabId || !workspaceId) return undefined;
  return { paneId, tabId, workspaceId };
}
