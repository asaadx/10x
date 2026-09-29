import { useCallback, useEffect, useRef, useState } from "react";

import { getBoard, getProjects, MOCK_MODE, mockProjects } from "@/lib/api.ts";
import { MOCK_TICKETS } from "@/mock.ts";
import type { Project, Ticket } from "@/types.ts";

/**
 * The board's live read. One hook owns the poll so no component has to know a request exists.
 */

export type Board = {
  tickets: Ticket[];
  projects: Project[];
  /** Last read failure, or null. Never clears the data it accompanies. */
  error: string | null;
};

/**
 * One second, matching the previous vanilla frontend and what `e2e/board.spec.ts` still waits
 * on. The board read is a pure database read (the agents write their state into the shared
 * database), so the poll is cheap; SSE remains parked as `## Push board updates with SSE instead
 * of polling` in `memory/parking-lot.md`.
 */
const POLL_MS = 1000;

/**
 * Fixture tickets are static, but the projects are not: the dialog writes to `mockProjects`, so
 * mock mode reads through that store rather than the module-level array a newly added project
 * would never appear in.
 */
const mockBoard = (): Board => ({
  tickets: MOCK_TICKETS,
  projects: mockProjects.list(),
  error: null,
});

/**
 * `refresh` is how a write gets its own result on screen: a mutation awaits its POST and then
 * asks for the board immediately, instead of leaving the card up to a whole poll interval
 * behind the state it just changed.
 */
export function useBoard(projectId: string): Board & { refresh: () => void } {
  const [board, setBoard] = useState<Board>(() =>
    MOCK_MODE ? mockBoard() : { tickets: [], projects: [], error: null },
  );
  // Written by the effect below and read by `refresh`, so a manual refresh runs the effect's
  // OWN poll — the current project's, sharing its in-flight guard — rather than a second
  // request that would race it. A no-op until the first effect run, which is also what makes
  // the mock board's `refresh` inert with nothing to special-case.
  const poll = useRef<(manual: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    // Nothing to poll for and no timer started: a mock write announces itself, so the store's
    // own notification is the whole update path.
    if (MOCK_MODE) return mockProjects.subscribe(() => setBoard(mockBoard()));

    // Guards every resolution below: a response that lands after unmount, or after the project
    // picker moved on, must not overwrite the board that replaced it.
    let current = true;

    // Scoped to this effect run, not held across them: the timer is what could pile requests
    // up, and a picker change replaces the timer. A request left in flight by the previous
    // selection is already ignored by `current`, and must not also stall the new selection's
    // first read behind a response nobody will use.
    let inFlight = false;

    // A manual refresh that arrived while a request was already running, to be served the
    // moment that one lands. One bit, not a queue: two refreshes waiting on the same response
    // want the same single re-read.
    let queued = false;

    /**
     * `manual` is the whole difference between the two callers. A timer tick that lands on a
     * request still running is DROPPED: `GET /tickets` is a round trip to the hosted database,
     * so overlapping polls would stack requests for no extra freshness. A refresh asked for by a write is instead QUEUED and run as soon
     * as the current request lands, because dropping it would put the write's own result up to
     * a full second away, which is the wait it exists to remove. Either way exactly one
     * request is ever in flight, which is the guarantee the guard is here for.
     */
    const run = async (manual: boolean) => {
      if (inFlight) {
        if (manual) queued = true;
        return;
      }
      inFlight = true;
      try {
        const [response, projects] = await Promise.all([getBoard(projectId), getProjects()]);
        if (!current) return;
        setBoard({ tickets: response.tickets, projects, error: null });
      } catch (cause) {
        if (!current) return;
        // Keep the last good data and hang the error off it. A backend restart mid-poll is a
        // one-second blip, and blanking every card for it would be the worse lie.
        setBoard((previous) => ({
          ...previous,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      } finally {
        inFlight = false;
      }
      if (queued && current) {
        queued = false;
        await run(false);
      }
    };

    poll.current = run;
    void run(false);
    const timer = setInterval(() => void run(false), POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId]);

  const refresh = useCallback(() => void poll.current(true), []);
  return { ...board, refresh };
}
