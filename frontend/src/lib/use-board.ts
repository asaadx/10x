import { useEffect, useState } from "react";

import { getBoard, getProjects, MOCK_MODE } from "@/lib/api.ts";
import { MOCK_PROJECTS, MOCK_TICKETS } from "@/mock.ts";
import type { Orphan, Project, Ticket } from "@/types.ts";

/**
 * The board's live read. One hook owns the poll so no component has to know a request exists.
 */

export type Board = {
  tickets: Ticket[];
  projects: Project[];
  unowned: Orphan[];
  /** Last read failure, or null. Never clears the data it accompanies. */
  error: string | null;
};

/**
 * One second, matching the previous vanilla frontend and what `e2e/board.spec.ts` still waits
 * on. Polling is the placeholder, not the design: the backend already holds a long-lived Herdr
 * subscription and knows the moment anything changes, so the intended replacement is
 * `## Push board updates with SSE instead of polling` in `memory/parking-lot.md`.
 */
const POLL_MS = 1000;

const MOCK_BOARD: Board = {
  tickets: MOCK_TICKETS,
  projects: MOCK_PROJECTS,
  // The fixtures have no orphaned worktrees; the reconciler is what produces these.
  unowned: [],
  error: null,
};

export function useBoard(projectId: string): Board {
  const [board, setBoard] = useState<Board>({ tickets: [], projects: [], unowned: [], error: null });

  useEffect(() => {
    // Fixtures are static, so there is nothing to poll for and no timer is started.
    if (MOCK_MODE) return;

    // Guards every resolution below: a response that lands after unmount, or after the project
    // picker moved on, must not overwrite the board that replaced it.
    let current = true;

    // Scoped to this effect run, not held across them: the timer is what could pile requests
    // up, and a picker change replaces the timer. A request left in flight by the previous
    // selection is already ignored by `current`, and must not also stall the new selection's
    // first read behind a response nobody will use.
    let inFlight = false;

    const poll = async () => {
      // Skip the tick instead of queueing behind the one still running. `GET /tickets` does
      // real Herdr work per call — an `agent.list` plus a `worktree.list` per repo — so
      // overlapping polls multiply that load for no extra freshness.
      if (inFlight) return;
      inFlight = true;
      try {
        const [response, projects] = await Promise.all([getBoard(projectId), getProjects()]);
        if (!current) return;
        setBoard({ tickets: response.tickets, projects, unowned: response.unowned, error: null });
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
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId]);

  return MOCK_MODE ? MOCK_BOARD : board;
}
