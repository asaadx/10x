import { useEffect, useMemo, useState } from "react";

import { BoardToolbar } from "@/components/BoardToolbar.tsx";
import { Column } from "@/components/Column.tsx";
import { NavBar } from "@/components/NavBar.tsx";
import { TicketSheet } from "@/components/TicketSheet.tsx";
import { ALL_PROJECTS, matchesProject, ticketsForColumn } from "@/lib/board.ts";
import { initialSteerMode, storeSteerMode, type SteerMode } from "@/lib/steer-mode.ts";
import { applyTheme, initialTheme, type Theme } from "@/lib/theme.ts";
import { useBoard } from "@/lib/use-board.ts";
import { COLUMNS, type SortOrder, type Ticket } from "@/types.ts";

/**
 * Read path only: the board renders live data from `useBoard`, and no button does anything
 * yet. The write path is still unwired and is the next step — deliberately separate, so a bug
 * in the redesign cannot be confused with a bug in the plumbing.
 */
export function App() {
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  const [steerMode, setSteerMode] = useState<SteerMode>(() => initialSteerMode());
  // Seeded from the sentinel, not from a project: projects arrive asynchronously and the list
  // may legitimately be empty, so this is the only value that is valid before the first read.
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<SortOrder>("newest");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTicket, setSheetTicket] = useState<Ticket | null>(null);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => storeSteerMode(steerMode), [steerMode]);

  const { tickets, projects, error } = useBoard(projectId);

  // The backend already filters when a project is selected; this also covers the sentinel and
  // the tick between a picker change and its first response.
  const visible = useMemo(() => tickets.filter((t) => matchesProject(t, projectId)), [tickets, projectId]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <NavBar
        projects={projects}
        projectId={projectId}
        onProjectChange={setProjectId}
        steerMode={steerMode}
        onSteerModeChange={setSteerMode}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
      <BoardToolbar query={query} onQueryChange={setQuery} order={order} onOrderChange={setOrder} />

      {/*
        An unreachable backend must not read as an empty-but-healthy board. One line, in flow
        above the columns rather than as an overlay, because the last good data is still shown
        underneath it and stays usable while the poll retries every second.
      */}
      {error !== null && (
        <p className="shrink-0 truncate px-3 pb-1 text-xs text-destructive" role="status" title={error}>
          Board data is stale — {error}
        </p>
      )}

      {/*
        Capped and centred so columns stop stretching on a wide monitor.

        `grid-rows-[minmax(0,1fr)]` is load-bearing, not decoration: a grid's implicit row is
        `auto`, so without it the row sizes to its tallest column, the columns grow past the
        viewport and the PAGE scrolls instead of each column scrolling inside itself. `min-h-0`
        does the same job one level up, letting the grid shrink below its content.
      */}
      <main className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 grid-cols-5 grid-rows-[minmax(0,1fr)] gap-3 p-3">
        {COLUMNS.map(({ status, label }) => (
          <Column
            key={status}
            status={status}
            label={label}
            steerMode={steerMode}
            tickets={ticketsForColumn(visible, status, query, order)}
            onNewTicket={
              status === "backlog" || status === "todo"
                ? () => {
                    setSheetTicket(null);
                    setSheetOpen(true);
                  }
                : undefined
            }
            onOpenTicket={(ticket) => {
              setSheetTicket(ticket);
              setSheetOpen(true);
            }}
          />
        ))}
      </main>

      {/* `key` re-seeds the form's local state when a different ticket is opened. */}
      <TicketSheet
        key={sheetTicket?.id ?? "new"}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={projectId === ALL_PROJECTS ? "" : projectId}
        ticket={sheetTicket}
      />
    </div>
  );
}
