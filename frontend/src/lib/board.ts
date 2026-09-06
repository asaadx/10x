import { PRIORITIES } from "@/types.ts";
import type { SortOrder, Status, Ticket } from "@/types.ts";

/**
 * Board derivations. Pure, no DOM, no fetch — the same seam the old frontend kept between
 * `state.js` and `render.js`, and worth keeping: these are the only rules that decide what a
 * column contains, so they are the only part worth testing in isolation.
 */

/**
 * Sentinel for the project picker's "All projects" entry. Not a project id: no project may be
 * called this, which is guaranteed because a project id is a slug and this contains a colon.
 */
export const ALL_PROJECTS = "all:projects";

export function matchesProject(ticket: Ticket, projectId: string): boolean {
  return projectId === ALL_PROJECTS || ticket.projectId === projectId;
}

/**
 * Case-insensitive substring across title, description and id.
 *
 * Id is included because a ticket id is the handle everything else in the system uses — a
 * branch, a PR title, a terminal — so arriving with `10x-4` in hand and finding nothing would
 * be the obvious failure. Placeholder field set; see docs/ui-redesign.md.
 */
export function matchesSearch(ticket: Ticket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    ticket.title.toLowerCase().includes(q) ||
    ticket.description.toLowerCase().includes(q) ||
    ticket.id.toLowerCase().includes(q)
  );
}

/** Position in `PRIORITIES` is the rank: low < medium < high, the same order the stars count. */
const priorityRank = (ticket: Ticket): number => PRIORITIES.indexOf(ticket.priority);

/**
 * Sorts by creation or by priority, never by position: nothing persists card order, so there
 * is no stored ordering to respect and no reorder to implement. `direction` is generic across
 * both keys — "desc" is always the highest value first, whether that value is a timestamp or
 * a priority rank — so this is the one place either key's comparison lives.
 */
export function sortTickets(tickets: Ticket[], order: SortOrder): Ticket[] {
  return [...tickets].sort((a, b) => {
    const cmp =
      order.key === "date" ? a.createdAt.localeCompare(b.createdAt) : priorityRank(a) - priorityRank(b);
    return order.direction === "desc" ? -cmp : cmp;
  });
}

export function ticketsForColumn(
  tickets: Ticket[],
  status: Status,
  query: string,
  order: SortOrder,
): Ticket[] {
  return sortTickets(
    tickets.filter((t) => t.status === status && matchesSearch(t, query)),
    order,
  );
}

/**
 * One spinner for the whole column, not one per card: the question the header answers is
 * "is anything running", and a count would only restate the badges already on the cards.
 */
export function columnIsWorking(tickets: Ticket[]): boolean {
  return tickets.some((t) => t.agentStatus === "working");
}

/** A run that died without ever finishing. `died` alone does not mean failure. */
export function runFailed(ticket: Ticket): boolean {
  return ticket.died && !ticket.finished;
}
