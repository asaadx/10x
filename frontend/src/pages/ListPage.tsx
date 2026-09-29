import { ArrowDown, ArrowUp, ChevronDown, ChevronsUpDown, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PR_ICON, PR_TONE, PriorityBadge } from "@/components/TicketCard.tsx";
import { TicketSheet } from "@/components/TicketSheet.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ALL_PROJECTS, matchesProject } from "@/lib/board.ts";
import {
  checklistProgress,
  EMPTY_FILTERS,
  filterTickets,
  hasActiveFilters,
  loadListPrefs,
  nextSort,
  relativeTime,
  sortListTickets,
  STATUS_LABEL,
  storeListPrefs,
  type ListFilters,
  type ListSort,
  type ListSortKey,
} from "@/lib/list.ts";
import { cn } from "@/lib/utils.ts";
import { COLUMNS, PLAYBOOKS, PRIORITIES, type Playbook, type Priority, type Project, type Status, type Ticket } from "@/types.ts";

type Props = {
  projectId: string;
  tickets: Ticket[];
  projects: Project[];
  error: string | null;
  refresh: () => void;
};

/** One dot colour per status, so a long list can be scanned by colour before reading. */
const STATUS_DOT: Record<Status, string> = {
  backlog: "bg-zinc-400 dark:bg-zinc-500",
  todo: "bg-sky-500",
  in_progress: "bg-amber-500",
  in_review: "bg-violet-500",
  done: "bg-emerald-500",
};

const HEADERS: Array<{ key: ListSortKey; label: string; className: string }> = [
  { key: "id", label: "ID", className: "w-28" },
  { key: "title", label: "Title", className: "min-w-64" },
  { key: "status", label: "Status", className: "w-32" },
  { key: "priority", label: "Priority", className: "w-24" },
  { key: "playbook", label: "Playbook", className: "w-28" },
  { key: "checklist", label: "Checklist", className: "w-28" },
  { key: "pr", label: "PR", className: "w-24" },
  { key: "updated", label: "Updated", className: "w-28" },
];

/** Re-renders once a minute so "3m ago" does not freeze in mock mode, where nothing polls. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Keys typed into a field, or inside an open menu, belong to that control, not to the list. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [role='menu'], [role='dialog']") !== null
  );
}

function StatusFilter({ value, onChange }: { value: Status[]; onChange: (next: Status[]) => void }) {
  const summary =
    value.length === 0
      ? "All statuses"
      : value.length === 1
        ? STATUS_LABEL[value[0]!]
        : `${value.length} statuses`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label={`Status filter: ${summary}`}>
          {summary}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {COLUMNS.map(({ status, label }) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={value.includes(status)}
            // Keep the menu open so several statuses can be ticked in one visit.
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(checked) =>
              // Rebuilt in COLUMNS order so the stored value never depends on click order.
              onChange(
                COLUMNS.map((c) => c.status).filter((s) => (s === status ? checked === true : value.includes(s))),
              )
            }
          >
            <span aria-hidden className={cn("size-2 rounded-full", STATUS_DOT[status])} />
            {label}
          </DropdownMenuCheckboxItem>
        ))}
        {value.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={false} onCheckedChange={() => onChange([])}>
              Show all
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortHeader({
  column,
  sort,
  onSort,
}: {
  column: (typeof HEADERS)[number];
  sort: ListSort;
  onSort: (key: ListSortKey) => void;
}) {
  const active = sort?.key === column.key;
  const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "sticky top-0 z-10 border-b bg-background px-2 py-0 text-left text-xs font-medium text-muted-foreground",
        column.className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={cn(
          "-mx-1 inline-flex h-8 items-center gap-1 rounded-sm px-1 transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          active && "text-foreground",
        )}
      >
        {column.label}
        <Icon aria-hidden className={cn("size-3", !active && "opacity-40")} />
      </button>
    </th>
  );
}

function Checklist({ ticket }: { ticket: Ticket }) {
  const { done, total } = checklistProgress(ticket);
  if (total === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="flex items-center gap-2" title={`${done} of ${total} tasks done`}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", done === total ? "bg-emerald-500" : "bg-primary/70")}
          style={{ width: `${(done / total) * 100}%` }}
        />
      </span>
      <span className="font-mono tabular-nums">
        {done}/{total}
      </span>
    </span>
  );
}

function PullRequest({ ticket }: { ticket: Ticket }) {
  const { prUrl, prState, prNumber } = ticket;
  if (!prUrl) return <span className="text-muted-foreground/60">—</span>;
  const Icon = prState === null ? null : PR_ICON[prState];
  return (
    <a
      href={prUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={prState === null ? "Pull request" : `Pull request — ${prState}`}
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {Icon !== null && <Icon aria-hidden className={cn("size-3.5", PR_TONE[prState!])} />}
      <span className="font-mono">{prNumber === null ? "PR" : `#${prNumber}`}</span>
      {prState !== null && <span className="sr-only">{prState}</span>}
    </a>
  );
}

/**
 * `/list` — the board's tickets as one dense, sortable, filterable table, for when a project
 * has outgrown five columns of cards. Same data as the board: `tickets`/`projects` come from
 * the shell's single `useBoard` poll and the NavBar's project picker scopes it, so there is no
 * second fetch path to drift. A row opens the same `TicketSheet` a card does.
 *
 * Sort and filters persist in `localStorage` (`lib/list.ts`), so returning to the list lands on
 * the view that was left.
 */
export function ListPage({ projectId, tickets, projects, error, refresh }: Props) {
  const [prefs] = useState(loadListPrefs);
  const [sort, setSort] = useState<ListSort>(prefs.sort);
  const [filters, setFilters] = useState<ListFilters>(prefs.filters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTicket, setSheetTicket] = useState<Ticket | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const now = useNow(60_000);

  useEffect(() => storeListPrefs({ sort, filters }), [sort, filters]);

  // Archived tickets never reach the board read, so "same as the board" needs no extra rule.
  const scoped = useMemo(() => tickets.filter((t) => matchesProject(t, projectId)), [tickets, projectId]);
  const rows = useMemo(() => sortListTickets(filterTickets(scoped, filters), sort), [scoped, filters, sort]);

  const patch = (next: Partial<ListFilters>) => setFilters((f) => ({ ...f, ...next }));

  const open = useCallback((ticket: Ticket) => {
    setSelectedId(ticket.id);
    setSheetTicket(ticket);
    setSheetOpen(true);
  }, []);

  // Keep the keyboard cursor on screen as it moves.
  useEffect(() => {
    if (selectedId === null) return;
    bodyRef.current
      ?.querySelector(`[data-ticket-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheetOpen || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isTypingTarget(e.target) || rows.length === 0) return;
      const index = rows.findIndex((t) => t.id === selectedId);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedId(rows[Math.min(index + 1, rows.length - 1)]!.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedId(rows[Math.max(index - 1, 0)]!.id);
      } else if (e.key === "Enter" && index !== -1) {
        // A focused button or link already owns Enter.
        if (e.target instanceof HTMLElement && e.target.closest("button, a")) return;
        e.preventDefault();
        open(rows[index]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selectedId, sheetOpen, open]);

  const filtered = hasActiveFilters(filters);

  return (
    <>
      <div role="toolbar" aria-label="List controls" className="shrink-0 border-b">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-2 px-4 py-2.5">
          <div className="relative w-full min-w-40 sm:w-auto sm:max-w-sm sm:flex-1">
            <Search aria-hidden className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search tickets"
              placeholder="Search title, description or id  ( / )"
              value={filters.query}
              onChange={(e) => patch({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
              className="h-8 pl-7"
            />
          </div>

          <StatusFilter value={filters.statuses} onChange={(statuses) => patch({ statuses })} />

          <NativeSelect
            aria-label="Playbook filter"
            value={filters.playbook}
            onChange={(e) => patch({ playbook: e.target.value as Playbook | "" })}
            className="w-36"
          >
            <NativeSelectOption value="">All playbooks</NativeSelectOption>
            {PLAYBOOKS.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          <NativeSelect
            aria-label="Priority filter"
            value={filters.priority}
            onChange={(e) => patch({ priority: e.target.value as Priority | "" })}
            className="w-36"
          >
            <NativeSelectOption value="">All priorities</NativeSelectOption>
            {[...PRIORITIES].reverse().map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          {filtered && (
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={() => setFilters(EMPTY_FILTERS)}>
              <X aria-hidden className="size-3.5" />
              Clear
            </Button>
          )}

          <p className="ml-auto text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
            {rows.length} of {scoped.length} tickets
            {sort !== null && (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setSort(null)}
                >
                  default order
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      {error !== null && (
        <p className="shrink-0 truncate px-3 py-1 text-xs text-destructive" role="status" title={error}>
          Board data is stale — {error}
        </p>
      )}

      {/*
        The table scrolls on both axes inside this box, never the page: `min-h-0` lets the flex
        child shrink below its content (the same trap as the board grid), and the header cells
        are `sticky top-0` against this scroller. The inner min width is what makes a narrow
        viewport scroll sideways here rather than squash every column.
      */}
      <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-4 pt-2 pb-3">
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full min-w-[960px] border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                {HEADERS.map((column) => (
                  <SortHeader
                    key={column.key}
                    column={column}
                    sort={sort}
                    onSort={(key) => setSort((s) => nextSort(s, key))}
                  />
                ))}
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {rows.map((ticket) => {
                const selected = ticket.id === selectedId;
                return (
                  <tr
                    key={ticket.id}
                    data-ticket-id={ticket.id}
                    aria-selected={selected}
                    onClick={() => open(ticket)}
                    className={cn(
                      "group h-9 cursor-pointer transition-colors hover:bg-muted/50 [&>td]:border-b [&>td]:border-border/60",
                      selected && "bg-accent hover:bg-accent [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-primary)]",
                    )}
                  >
                    <td className="px-2 font-mono whitespace-nowrap text-muted-foreground">{ticket.id}</td>
                    <td className="max-w-0 px-2">
                      <span className="block truncate font-medium text-foreground" title={ticket.title}>
                        {ticket.title || <span className="text-muted-foreground italic">Untitled</span>}
                      </span>
                    </td>
                    <td className="px-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className={cn("size-2 rounded-full", STATUS_DOT[ticket.status])} />
                        {STATUS_LABEL[ticket.status]}
                      </span>
                    </td>
                    <td className="px-2">
                      <PriorityBadge priority={ticket.priority} />
                    </td>
                    <td className="px-2 whitespace-nowrap text-muted-foreground">{ticket.playbook}</td>
                    <td className="px-2 whitespace-nowrap">
                      <Checklist ticket={ticket} />
                    </td>
                    <td className="px-2 whitespace-nowrap">
                      <PullRequest ticket={ticket} />
                    </td>
                    <td
                      className="px-2 whitespace-nowrap text-muted-foreground tabular-nums"
                      title={new Date(ticket.updatedAt).toLocaleString()}
                    >
                      {relativeTime(ticket.updatedAt, now)}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={HEADERS.length} className="px-2 py-12 text-center text-sm text-muted-foreground">
                    {scoped.length === 0 ? (
                      "No tickets in this project yet."
                    ) : (
                      <>
                        No tickets match these filters.{" "}
                        <button
                          type="button"
                          className="text-foreground underline underline-offset-2"
                          onClick={() => setFilters(EMPTY_FILTERS)}
                        >
                          Clear filters
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="hidden shrink-0 pt-1.5 text-[11px] text-muted-foreground sm:block">
          <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> or arrows to move ·{" "}
          <kbd className="font-mono">Enter</kbd> to open · <kbd className="font-mono">/</kbd> to search · click a
          header to sort
        </p>
      </main>

      {/* Same sheet, same props as the board's card-open path; `key` re-seeds it per ticket. */}
      <TicketSheet
        key={sheetTicket?.id ?? "new"}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={projectId === ALL_PROJECTS ? "" : projectId}
        ticket={sheetTicket}
        createInto="backlog"
        actionError={null}
        onCreated={refresh}
        onSaved={refresh}
      />
    </>
  );
}
