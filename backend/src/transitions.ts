/**
 * The ticket state machine, written down once.
 *
 * Every status move in the product is one row of `TRANSITIONS`, and the row records the thing
 * that is easy to get wrong: whether the move is a *pure status write* or whether it belongs to
 * a route because it has side effects outside the row. `POST /tickets/:id/status` validates
 * against this table, so a caller cannot write `in_progress` straight onto a ticket and leave
 * the board showing a running card with no cloud session behind it.
 * The table answers "is this move legal?"; `claimTicket` in db.ts still answers "did I win it?"
 * — this module decides nothing about concurrency.
 *
 * It imports nothing, for the reason `types.ts` imports nothing: `db.ts` opens SQLite at module
 * load, so a shared vocabulary has to stay inert enough for a test — or one day the frontend —
 * to read it without dragging a database in. The price is that `TransitionStatus` restates the
 * `Status` union; `transitions.test.ts` holds a compile-time assertion that the two are equal,
 * so the restatement cannot drift.
 */

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;

export type TransitionStatus = (typeof STATUSES)[number];

/** The request-body guard: JSON gives no guarantees, and an unknown status is a 400, not a default. */
export const isTransitionStatus = (value: unknown): value is TransitionStatus =>
  STATUSES.some((status) => status === value);

export type Transition = {
  from: TransitionStatus;
  to: TransitionStatus;
  /**
   * `null` for a pure status write — the row changes and nothing else, so `/status` may make
   * the move itself. Otherwise the name of whatever owns the move, which is what a refusal
   * quotes back: the caller's mistake is using the wrong door, so the error has to name the
   * right one.
   */
  owner: string | null;
  /** What the owner does beyond writing the status, or why there is nothing to do. */
  effect: string;
};

/**
 * Backlog → To Do → In Progress → In Review → Done (memory/operations.md). The two moves
 * between Backlog and To Do are the only ones a human makes by hand with nothing attached:
 * a plan is accepted, or a ticket is sent back to be re-planned.
 */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: "backlog",
    to: "todo",
    owner: null,
    effect: "a raw idea has a plan and is ready to start; nothing outside the row changes",
  },
  {
    from: "todo",
    to: "backlog",
    owner: null,
    effect: "sent back to be re-planned; nothing outside the row changes",
  },
  {
    from: "todo",
    to: "in_progress",
    owner: "POST /tickets/:id/spawn",
    effect: "starts the ticket's cloud session with its opening message",
  },
  {
    from: "in_progress",
    to: "todo",
    owner: "POST /tickets/:id/cancel",
    effect: "tells the session to stop, clears the session fields and stops any Preview",
  },
  {
    from: "in_progress",
    to: "in_review",
    owner: "the agent poller",
    effect:
      "fires by itself once the agent reports agent_state = done; no click means 'the agent " +
      "finished', so there is nothing for a caller to ask for here",
  },
  {
    from: "in_review",
    to: "done",
    owner: "POST /tickets/:id/accept",
    effect: "marks the agent's draft PR ready for review, or opens one from its branch",
  },
  {
    from: "in_review",
    to: "in_progress",
    owner: "POST /tickets/:id/reject",
    effect: "sends the reason into the same cloud session and clears the completion mark",
  },
];

/** The legal-move lookup. `undefined` means the pair is not in the machine at all. */
export const transitionFor = (
  from: TransitionStatus,
  to: TransitionStatus,
): Transition | undefined => TRANSITIONS.find((t) => t.from === from && t.to === to);

/** Legal *and* nothing but a status write — the only kind `/status` may perform. */
export const isPureStatusWrite = (from: TransitionStatus, to: TransitionStatus): boolean =>
  transitionFor(from, to)?.owner === null;

/**
 * Two different mistakes, kept apart on purpose. `illegal_transition` means the machine has no
 * such edge and no route will ever accept it; `transition_has_side_effects` means the move is
 * real but this is the wrong door, and `owner` names the door to use instead.
 */
export type StatusMovePlan =
  | { ok: true; transition: Transition }
  | {
      ok: false;
      error: "illegal_transition" | "transition_has_side_effects";
      message: string;
      owner?: string;
    };

export function planStatusMove(from: TransitionStatus, to: TransitionStatus): StatusMovePlan {
  const transition = transitionFor(from, to);
  if (!transition) {
    return {
      ok: false,
      error: "illegal_transition",
      message: `${from} → ${to} is not a move this board makes`,
    };
  }
  if (transition.owner !== null) {
    return {
      ok: false,
      error: "transition_has_side_effects",
      message: `${from} → ${to} belongs to ${transition.owner}, which ${transition.effect}`,
      owner: transition.owner,
    };
  }
  return { ok: true, transition };
}
