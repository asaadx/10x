import { ALL_PROJECTS } from "@/lib/board.ts";
import type { BoardResponse, Project } from "@/types.ts";

/**
 * The board's read seam: the two GETs it renders from, and nothing else. No writes live here —
 * the write path is not wired yet, and keeping this file to reads means a bug in the redesign
 * cannot be confused with a bug in the plumbing.
 *
 * Paths are relative on purpose. `vite.config.ts` proxies `/tickets` and `/projects` to the
 * backend in dev, and in production the backend serves the built bundle itself, so the board
 * is same-origin in both and no origin ever needs to be configured.
 */

/**
 * Real data is the default, and only the exact string "true" turns fixtures on — matching the
 * `VITE_DIAGNOSTICS` precedent. Deliberate: an unset or misspelled variable in a production
 * build must serve the real board rather than silently serving `mock.ts`, because fixtures that
 * look plausible are far harder to notice than a board that fails loudly.
 */
export const MOCK_MODE = import.meta.env["VITE_MOCK_MODE"] === "true";

/**
 * A failed read throws with the status and the path in the message. Returning a partial or
 * empty shape instead would surface much later as an undefined field in a component, with
 * nothing left to point at the request that actually failed.
 */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

/**
 * `ALL_PROJECTS` is the picker's sentinel, not a project id, so it is expressed by omitting the
 * query param — which is exactly how the backend spells "every project".
 */
export function getBoard(projectId: string): Promise<BoardResponse> {
  const query = projectId === ALL_PROJECTS ? "" : `?project=${encodeURIComponent(projectId)}`;
  return getJson<BoardResponse>(`/tickets${query}`);
}

export function getProjects(): Promise<Project[]> {
  return getJson<Project[]>("/projects");
}
