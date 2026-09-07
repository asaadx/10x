import { IconBrandGithub } from "@tabler/icons-react";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BoardToolbar } from "@/components/BoardToolbar.tsx";
import { Column } from "@/components/Column.tsx";
import { NavBar } from "@/components/NavBar.tsx";
import { TicketSheet } from "@/components/TicketSheet.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { provisionProject } from "@/lib/api.ts";
import { ALL_PROJECTS, matchesProject, ticketsForColumn } from "@/lib/board.ts";
import { initialSteerMode, storeSteerMode, type SteerMode } from "@/lib/steer-mode.ts";
import { useTheme } from "@/lib/theme.ts";
import { useBoard } from "@/lib/use-board.ts";
import { COLUMNS, type Project, type ProvisionState, type SortOrder, type Status, type Ticket } from "@/types.ts";

/**
 * The selected project's provisioning state, in flow above the columns exactly like the
 * stale-data line and for the same reason: the board underneath stays usable. That is the
 * whole promise of downloading in the background — a backlog can be written while it runs.
 *
 * `pending` and `cloning` share one line. The difference between queued and running is 10x's
 * own bookkeeping, and neither changes what the user can do next.
 *
 * Re-link is deliberately absent from the failed banner: it repoints a project at a different
 * repo, which needs the dialog's lookup to say what it is repointing at.
 *
 * Anything OTHER than the four known states — most likely a backend that predates this field
 * and sends no `provisionState` at all — renders nothing. Failing open is the only safe
 * direction here: the server is the authority on whether a spawn is allowed and refuses with
 * 409 regardless, whereas inventing a blocking state from a missing field claims a download
 * that is not running and leaves a perfectly good project looking broken with no way out.
 */
function ProvisionBanner({ project, onRetried }: { project: Project; onRetried: () => void }) {
  const [retrying, setRetrying] = useState(false);
  // A retry that never reached the server leaves `provisionError` reading exactly as it did
  // before the click, so the failure has to be shown from here or Retry looks like a dead button.
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await provisionProject(project.id);
      onRetried();
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  };

  if (project.provisionState !== "pending" && project.provisionState !== "cloning" && project.provisionState !== "failed") {
    return null;
  }

  if (project.provisionState === "failed") {
    return (
      <div className="mx-auto w-full max-w-[1600px] shrink-0 px-3 pt-1" role="status">
        <div className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-destructive">{project.name} is not usable yet.</span>{" "}
            <span className="text-muted-foreground">{retryError ?? project.provisionError}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 gap-1 px-2 text-[11px]"
            disabled={retrying}
            title="Downloads the repo again. Nothing on GitHub is touched."
            onClick={() => void retry()}
          >
            {retrying && <Spinner aria-hidden className="size-3" />}
            {retrying ? "Retrying..." : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  // `owner/repo` rather than the name, because the point of this line is which repo is being
  // downloaded. Falls back to the project's own name if identity is somehow absent, so this can
  // never render a bare "/".
  const repo = project.owner && project.repo ? `${project.owner}/${project.repo}` : project.name;

  return (
    <div className="mx-auto w-full max-w-[1600px] shrink-0 px-3 pt-1" role="status">
      <div className="flex items-center gap-2.5 rounded-md border bg-muted/40 px-3 py-2 text-xs">
        <Spinner aria-hidden className="size-3.5 shrink-0 text-blue-500" />
        <span className="min-w-0">
          Downloading <span className="font-mono">{repo}</span> — you can write tickets now; Start
          becomes available when it finishes.
        </span>
      </div>
    </div>
  );
}

/**
 * The write path is wired only as far as Plan mode needs: the composer creates, and a card's
 * Plan, To Do and Backlog buttons act. Start, Cancel, Accept, Reject and the two deletes are
 * still inert on purpose — each has a route, none has a caller — so a button that does
 * nothing is a missing handler rather than a broken one.
 */
export function App() {
  const { theme, toggleTheme } = useTheme();
  const [steerMode, setSteerMode] = useState<SteerMode>(() => initialSteerMode());
  // Seeded from the sentinel, not from a project: projects arrive asynchronously and the list
  // may legitimately be empty, so this is the only value that is valid before the first read.
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS);
  const [query, setQuery] = useState("");
  // Date, newest first, is the sort the board has always defaulted to.
  const [order, setOrder] = useState<SortOrder>({ key: "date", direction: "desc" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTicket, setSheetTicket] = useState<Ticket | null>(null);
  // Which column's New ticket button opened the composer. A ticket is always CREATED in
  // `backlog` — `INSERT_TICKET` hardcodes it, because a new ticket is a raw idea — so this is
  // what lets the To Do footer's button do what it looks like it does instead of dropping the
  // card in a different column.
  const [createInto, setCreateInto] = useState<Status>("backlog");
  // The failed card action the sheet is currently showing, handed over by the card that opened
  // it — the card is where the write is dispatched from, and the sheet is the only surface with
  // room for the message. A snapshot taken at open, which cannot go stale because the sheet is
  // modal: nothing on the board can be clicked, so no action can fail, while it is up.
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => storeSteerMode(steerMode), [steerMode]);

  const { tickets, projects, error, refresh } = useBoard(projectId);

  // The backend already filters when a project is selected; this also covers the sentinel and
  // the tick between a picker change and its first response.
  const visible = useMemo(() => tickets.filter((t) => matchesProject(t, projectId)), [tickets, projectId]);

  const selected = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  // Spawning against a project whose repo is not on disk answers 409 `project_not_provisioned`,
  // so the card must not offer Plan or Start. The state travels, not a boolean: a card has to
  // say *why* the button is dead, and "still downloading" and "the clone failed" are different
  // sentences. Keyed by project id rather than read off the selected project, because
  // `All projects` puts cards from several projects side by side and only some lose the button.
  const projectStates = useMemo<Record<string, ProvisionState>>(
    () => Object.fromEntries(projects.map((p) => [p.id, p.provisionState] as const)),
    [projects],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <NavBar
        projects={projects}
        projectId={projectId}
        onProjectChange={setProjectId}
        steerMode={steerMode}
        onSteerModeChange={setSteerMode}
        theme={theme}
        onThemeToggle={toggleTheme}
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

      {/* Keyed by project, so a retry failure belongs to the project it was clicked on and
          cannot follow the picker onto another one. */}
      {selected !== null && <ProvisionBanner key={selected.id} project={selected} onRetried={refresh} />}

      {projects.length === 0 ? (
        /*
          A fresh install is otherwise five empty columns and no way forward. No button here:
          the add button lives beside the picker in the NavBar, and a second entry point would
          be a second thing to keep in step with it.
        */
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <div className="mx-auto mb-4 inline-flex size-11 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
              <IconBrandGithub aria-hidden className="size-5" />
            </div>
            <h2 className="text-base font-semibold tracking-tight">Add your first project</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Paste a GitHub repo into <span className="font-medium text-foreground">+</span> beside the project
              picker — 10x downloads its own copy, works out the main branch, and is ready for tickets.
            </p>
          </div>
        </main>
      ) : (
        /*
          Capped and centred so columns stop stretching on a wide monitor.

          `grid-rows-[minmax(0,1fr)]` is load-bearing, not decoration: a grid's implicit row is
          `auto`, so without it the row sizes to its tallest column, the columns grow past the
          viewport and the PAGE scrolls instead of each column scrolling inside itself. `min-h-0`
          does the same job one level up, letting the grid shrink below its content.
        */
        <main className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 grid-cols-5 grid-rows-[minmax(0,1fr)] gap-3 p-3">
          {COLUMNS.map(({ status, label }) => (
            <Column
              key={status}
              status={status}
              label={label}
              steerMode={steerMode}
              tickets={ticketsForColumn(visible, status, query, order)}
              projectStates={projectStates}
              onNewTicket={
                status === "backlog" || status === "todo"
                  ? () => {
                      setSheetTicket(null);
                      setSheetError(null);
                      setCreateInto(status);
                      setSheetOpen(true);
                    }
                  : undefined
              }
              onOpenTicket={(ticket, actionError) => {
                setSheetTicket(ticket);
                setSheetError(actionError);
                setSheetOpen(true);
              }}
              onTicketChanged={refresh}
            />
          ))}
        </main>
      )}

      {/* `key` re-seeds the form's local state when a different ticket is opened. */}
      <TicketSheet
        key={sheetTicket?.id ?? "new"}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={projectId === ALL_PROJECTS ? "" : projectId}
        ticket={sheetTicket}
        createInto={createInto}
        actionError={sheetError}
        onCreated={refresh}
        onSaved={refresh}
      />
    </div>
  );
}
