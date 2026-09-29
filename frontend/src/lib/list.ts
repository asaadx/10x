import { matchesSearch } from "@/lib/board.ts";
import { COLUMNS, PLAYBOOKS, PRIORITIES } from "@/types.ts";
import type { Playbook, Priority, SortDirection, Status, Ticket } from "@/types.ts";

/**
 * `/list` derivations. Pure like `board.ts` — no DOM, no fetch — except for the two
 * `localStorage` helpers at the bottom, which are the page's persistence seam and swallow every
 * storage failure (private mode, quota, a blocked origin) rather than take the page down.
 */

export type ListSortKey = "id" | "title" | "status" | "priority" | "playbook" | "checklist" | "pr" | "updated";

/** `null` is the default composite order: status, then priority desc, then updated desc. */
export type ListSort = { key: ListSortKey; direction: SortDirection } | null;

export type ListFilters = {
  query: string;
  /** Empty means every status — the same as ticking all five. */
  statuses: Status[];
  /** Empty string means any. */
  playbook: Playbook | "";
  priority: Priority | "";
};

export const EMPTY_FILTERS: ListFilters = { query: "", statuses: [], playbook: "", priority: "" };

export const STATUS_LABEL: Record<Status, string> = Object.fromEntries(
  COLUMNS.map(({ status, label }) => [status, label]),
) as Record<Status, string>;

const statusRank = (t: Ticket): number => COLUMNS.findIndex((c) => c.status === t.status);
const priorityRank = (t: Ticket): number => PRIORITIES.indexOf(t.priority);

/** Ticked and total items of the task breakdown — the plan the agent works through. */
export function checklistProgress(ticket: Ticket): { done: number; total: number } {
  return {
    done: ticket.taskBreakdown.filter((item) => item.done).length,
    total: ticket.taskBreakdown.length,
  };
}

export function filterTickets(tickets: Ticket[], filters: ListFilters): Ticket[] {
  return tickets.filter(
    (t) =>
      matchesSearch(t, filters.query) &&
      (filters.statuses.length === 0 || filters.statuses.includes(t.status)) &&
      (filters.playbook === "" || t.playbook === filters.playbook) &&
      (filters.priority === "" || t.priority === filters.priority),
  );
}

export function hasActiveFilters(filters: ListFilters): boolean {
  return (
    filters.query.trim() !== "" || filters.statuses.length > 0 || filters.playbook !== "" || filters.priority !== ""
  );
}

/** Default order, and every explicit sort's tie-breaker, so equal keys never shuffle on a poll. */
function defaultCompare(a: Ticket, b: Ticket): number {
  return (
    statusRank(a) - statusRank(b) ||
    priorityRank(b) - priorityRank(a) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Ascending comparison per column. A ticket with no checklist sorts below 0% and one with no PR
 * below every numbered PR, so "nothing there" gathers at one end instead of interleaving.
 */
function compareBy(key: ListSortKey, a: Ticket, b: Ticket): number {
  switch (key) {
    case "id":
      return a.projectId.localeCompare(b.projectId) || a.number - b.number;
    case "title":
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    case "status":
      return statusRank(a) - statusRank(b);
    case "priority":
      return priorityRank(a) - priorityRank(b);
    case "playbook":
      return PLAYBOOKS.indexOf(a.playbook) - PLAYBOOKS.indexOf(b.playbook);
    case "checklist": {
      const ratio = (t: Ticket) => {
        const { done, total } = checklistProgress(t);
        return total === 0 ? -1 : done / total;
      };
      return ratio(a) - ratio(b) || checklistProgress(a).total - checklistProgress(b).total;
    }
    case "pr": {
      const rank = (t: Ticket) => (t.prNumber ?? (t.prUrl ? 0 : -1));
      return rank(a) - rank(b);
    }
    case "updated":
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}

export function sortListTickets(tickets: Ticket[], sort: ListSort): Ticket[] {
  return [...tickets].sort((a, b) => {
    if (sort === null) return defaultCompare(a, b);
    const cmp = compareBy(sort.key, a, b);
    return (sort.direction === "desc" ? -cmp : cmp) || defaultCompare(a, b);
  });
}

/**
 * What the first click on a header means: text and identity read A→Z, while ranks and times
 * are most useful highest/newest first.
 */
export const FIRST_DIRECTION: Record<ListSortKey, SortDirection> = {
  id: "asc",
  title: "asc",
  status: "asc",
  playbook: "asc",
  priority: "desc",
  checklist: "desc",
  pr: "desc",
  updated: "desc",
};

/** Header click cycle: first direction → the other → back to the default order. */
export function nextSort(current: ListSort, key: ListSortKey): ListSort {
  if (current === null || current.key !== key) return { key, direction: FIRST_DIRECTION[key] };
  if (current.direction === FIRST_DIRECTION[key]) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return null;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const KEY = "10x.list";

const SORT_KEYS: readonly ListSortKey[] = ["id", "title", "status", "priority", "playbook", "checklist", "pr", "updated"];
const STATUSES: readonly Status[] = COLUMNS.map((c) => c.status);

/**
 * Every field is validated on the way in: storage outlives the code that wrote it, so a
 * playbook renamed since, or a hand-edited value, falls back to its default rather than
 * filtering the list down to nothing with no visible reason.
 */
export function loadListPrefs(): { sort: ListSort; filters: ListFilters } {
  const fallback = { sort: null, filters: EMPTY_FILTERS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const { sort, filters } = parsed as { sort?: unknown; filters?: Partial<Record<keyof ListFilters, unknown>> };

    let validSort: ListSort = null;
    if (typeof sort === "object" && sort !== null) {
      const { key, direction } = sort as { key?: unknown; direction?: unknown };
      if (
        SORT_KEYS.includes(key as ListSortKey) &&
        (direction === "asc" || direction === "desc")
      ) {
        validSort = { key: key as ListSortKey, direction };
      }
    }

    const f = filters ?? {};
    return {
      sort: validSort,
      filters: {
        query: typeof f.query === "string" ? f.query : "",
        statuses: Array.isArray(f.statuses)
          ? STATUSES.filter((s) => (f.statuses as unknown[]).includes(s))
          : [],
        playbook: PLAYBOOKS.includes(f.playbook as Playbook) ? (f.playbook as Playbook) : "",
        priority: PRIORITIES.includes(f.priority as Priority) ? (f.priority as Priority) : "",
      },
    };
  } catch {
    return fallback;
  }
}

export function storeListPrefs(prefs: { sort: ListSort; filters: ListFilters }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the page keeps working, it just forgets on reload.
  }
}
