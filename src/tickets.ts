/**
 * In-memory ticket store for the test harness.
 *
 * Status is the lock (memory/herdr-omp-lifecycle.md §9): claim with a
 * compare-and-swap before doing any slow work, and reject rather than queue.
 * In a single-threaded event loop a check followed by an assignment with no
 * `await` between them cannot be interleaved, so `claim` is atomic as written.
 */

export type Status = "backlog" | "in_progress";

/** Everything the UI needs to see whether the fresh-pane race fired (§1). */
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
};

export type Ticket = {
  project: string;
  number: number;
  title: string;
  body: string;
  base: string;
  status: Status;
  /** Last agent status seen on the event stream, or a lifecycle marker. */
  agentStatus: string | null;
  /** Set when the agent finishes a turn. There is no In Review column yet (§7). */
  finished: boolean;
  /**
   * OMP transcript directory for the current run, captured from agent.start.
   * Lives on the ticket, NOT in Diagnostics, because Diagnostics is reset on every
   * spawn and teardown still needs this. Refreshed from the live agent at teardown.
   */
  sessionDir: string | null;
  error: string | null;
  branch: string | null;
  worktreePath: string | null;
  paneId: string | null;
  workspaceId: string | null;
  diagnostics: Diagnostics;
  stream?: { close: () => void };
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
  };
}

const PROJECT = "target";

export const tickets: Ticket[] = [
  {
    project: PROJECT,
    number: 1,
    title: "Add a multiply helper",
    body: "Add an exported `multiply(a: number, b: number): number` to src/index.ts that returns a * b. Then commit.",
    base: "main",
    status: "backlog",
    agentStatus: null,
    finished: false,
    sessionDir: null,
    error: null,
    branch: null,
    worktreePath: null,
    paneId: null,
    workspaceId: null,
    diagnostics: freshDiagnostics(),
  },
  {
    project: PROJECT,
    number: 2,
    title: "Add a divide helper",
    body: "Add an exported `divide(a: number, b: number): number` to src/index.ts that returns a / b and throws on a zero divisor. Then commit.",
    base: "main",
    status: "backlog",
    agentStatus: null,
    finished: false,
    sessionDir: null,
    error: null,
    branch: null,
    worktreePath: null,
    paneId: null,
    workspaceId: null,
    diagnostics: freshDiagnostics(),
  },
];

export const findTicket = (id: string) =>
  tickets.find((t) => `${t.project}-${t.number}` === id);

/**
 * Atomic claim. Returns true if this caller won the transition.
 *
 * There is deliberately no `await` between the check and the assignment — that
 * is what makes it a lock. A second request (double-click, retry, double-drag)
 * sees the new status and loses.
 */
export function claim(ticket: Ticket, from: Status, to: Status): boolean {
  if (ticket.status !== from) return false;
  ticket.status = to;
  return true;
}
