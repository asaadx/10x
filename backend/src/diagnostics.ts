/**
 * The fresh-diagnostics constructor. The `Diagnostics` shape itself lives in types.ts, since
 * it crosses the wire and the frontend needs it; this module owns only its zero value.
 */
import type { Diagnostics } from "./types.ts";

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
