/**
 * Per-run spawn diagnostics.
 *
 * Deliberately NOT persisted: these describe one attempt at starting an agent and are
 * debugging output, not ticket state. Losing them on restart is correct.
 *
 * Their reason for existing is §1 — `agent.start` returns before the agent is usable, so
 * the guard retries and polls. These fields let the UI show whether that fired, which is
 * normal rather than a fault.
 */
export type Diagnostics = {
  startAttempts: number;
  paneBusyRetries: number;
  startReturnedStatus: string | null;
  startReturnedReady: boolean | null;
  startReturnedAfterMs: number | null;
  neededReadinessPoll: boolean;
  readinessPolls: number;
  readyAfterMs: number | null;
  promptAttempts: number;
  promptNotReadyRetries: number;
  /** True when spawn re-attached to an already-running agent rather than starting one. */
  reusedExistingAgent: boolean;
};

export function freshDiagnostics(): Diagnostics {
  return {
    startAttempts: 0,
    paneBusyRetries: 0,
    startReturnedStatus: null,
    startReturnedReady: null,
    startReturnedAfterMs: null,
    neededReadinessPoll: false,
    readinessPolls: 0,
    readyAfterMs: null,
    promptAttempts: 0,
    promptNotReadyRetries: 0,
    reusedExistingAgent: false,
  };
}
