import { useEffect, useMemo, useState } from "react";

import { Column } from "@/components/Column.tsx";
import { TicketSheet } from "@/components/TicketSheet.tsx";
import { TopBar } from "@/components/TopBar.tsx";
import { ALL_PROJECTS, matchesProject, ticketsForColumn } from "@/lib/board.ts";
import { applyTheme, initialTheme, type Theme } from "@/lib/theme.ts";
import { MOCK_PROJECTS, MOCK_TICKETS } from "@/mock.ts";
import { COLUMNS, type SortOrder, type Ticket } from "@/types.ts";

/**
 * UI-only phase: everything renders from `mock.ts` and no button does anything yet. Wiring is
 * the next step and replaces the two mock imports with the poll — deliberately separate, so a
 * bug in the redesign cannot be confused with a bug in the plumbing.
 */
export function App() {
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  const [projectId, setProjectId] = useState(MOCK_PROJECTS[0]!.id);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<SortOrder>("newest");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTicket, setSheetTicket] = useState<Ticket | null>(null);

  useEffect(() => applyTheme(theme), [theme]);

  const visible = useMemo(() => MOCK_TICKETS.filter((t) => matchesProject(t, projectId)), [projectId]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TopBar
        projects={MOCK_PROJECTS}
        projectId={projectId}
        onProjectChange={setProjectId}
        query={query}
        onQueryChange={setQuery}
        order={order}
        onOrderChange={setOrder}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

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
        projects={MOCK_PROJECTS}
        defaultProjectId={projectId === ALL_PROJECTS ? "" : projectId}
        ticket={sheetTicket}
      />
    </div>
  );
}
