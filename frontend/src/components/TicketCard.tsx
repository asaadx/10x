import {
  Archive,
  Ban,
  Bot,
  Check,
  ExternalLink,
  TreePineIcon,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hash,
  MoreHorizontal,
  NotebookPen,
  Play,
  ShipWheel,
  Trash2,
  TriangleAlert,
  Undo2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DeleteTicketDialog } from "@/components/DeleteTicketDialog.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { runFailed } from "@/lib/board.ts";
import type { Ticket } from "@/types.ts";

const PR_ICON = {
  merged: GitMerge,
  closed: GitPullRequestClosed,
  open: GitPullRequest,
} as const;

const PR_TONE = {
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-red-600 dark:text-red-400",
  open: "text-emerald-600 dark:text-emerald-400",
} as const;

// Idle icon colour per identifier kind: git-derived identifiers (branch, worktree) share one
// tone so they read as a pair; the agent gets its own to stand apart from both.
const COPY_BUTTON_TONE = {
  default: "text-muted-foreground",
  git: "text-emerald-600 dark:text-emerald-400",
  agent: "text-violet-600 dark:text-violet-400",
} as const;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * How long the agent has been on this ticket.
 *
 * `startedAt` is fixture-only today: the server always sends `null` (see `BoardTicket`'s doc
 * comment in types.ts), so this timer appears on mock data and never against a live server
 * until a `started_at` write lands.
 */
function RunTimer({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The duration carries itself — an icon beside it is redundant on a line that also has to
  // hold a truncated description.
  return (
    <span
      title="How long the agent has been on this ticket"
      className="text-[11px] text-muted-foreground tabular-nums"
    >
      {formatElapsed(now - new Date(since).getTime())}
    </span>
  );
}

/**
 * Click-to-copy for the identifiers a ticket is handled by.
 *
 * The branch and the worktree path are pure functions of the ticket id — Herdr derives the
 * directory from the branch and the branch is `ticket/<project>/<number>` (memory/naming.md) —
 * so rendering either as text would be the id again in a longer font. They are values you paste
 * into a terminal, never values you read, which is exactly what a copy affordance is for. Both
 * are still spelled out in full when the card is expanded.
 *
 * Every glyph sits in its own `size-4` box and the label runs at `leading-4`, so all three share
 * one 16px line box instead of each being centred against whatever happens to sit beside it.
 */
function CopyButton({
  value,
  label,
  icon: Icon,
  tone = "default",
  children,
}: {
  value: string;
  label: string;
  icon: LucideIcon;
  tone?: "default" | "git" | "agent";
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // A card unmounts on every poll that changes it, and a pending timer would then set state on
  // a dead component.
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      title={`${label} — click to copy`}
      aria-label={`Copy ${label.toLowerCase()}`}
      className={`inline-flex min-w-0 shrink items-center gap-1 rounded-sm ${COPY_BUTTON_TONE[tone]} transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none`}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {copied ? (
          // text-foreground rather than emerald: an emerald check on an already-emerald git
          // icon would be invisible, so the confirmation needs a colour every tone contrasts with.
          <Check aria-hidden className="size-3 text-foreground" />
        ) : (
          <Icon aria-hidden className="size-3" />
        )}
      </span>
      {children}
    </button>
  );
}

function PullRequestLine({ ticket }: { ticket: Ticket }) {
  const Icon = ticket.prState ? PR_ICON[ticket.prState] : null;
  if (!ticket.prUrl || !Icon) return null;

  return (
    <a
      href={ticket.prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-[11px] underline-offset-2 hover:underline"
    >
      <Icon aria-hidden className={`size-3.5 ${PR_TONE[ticket.prState!]}`} />
      <span className="font-mono">PR #{ticket.prNumber}</span>
      {ticket.prAdditions !== null && ticket.prDeletions !== null && (
        <span className="font-mono">
          <span className="text-emerald-600 dark:text-emerald-400">+{ticket.prAdditions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">&minus;{ticket.prDeletions}</span>
        </span>
      )}
    </a>
  );
}

type PreviewState = "idle" | "starting" | "live" | "stopping";

/**
 * One branch per status and never an `else`. Plan is scoped to `backlog`, Start to `todo`,
 * Steer and Cancel to `in_progress`, Accept and Reject to `in_review`, and the server answers
 * 409 from anywhere else — so an `else` would put a button on a card whose status cannot take
 * it. Done is terminal and its only run action is Archive; its pull request fills the rest of the row.
 *
 * Variants carry the consequence: the forward move is primary, a reversible move is outline,
 * and only the one that destroys something is destructive. Everything that is not a state
 * transition — Delete worktree, Edit, Delete — lives in the expanded region, which is
 * also what keeps this row inside the width of a five-column card.
 */
function RunActions({
  ticket,
  onCancel,
  previewState,
  onTogglePreview,
}: {
  ticket: Ticket;
  onCancel: () => void;
  previewState: PreviewState;
  onTogglePreview: () => void;
}) {
  if (ticket.status === "backlog") {
    return (
      <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" title="Talks the idea through with a planning agent until it is ready to start.">
        <NotebookPen aria-hidden className="size-3" />
        Plan
      </Button>
    );
  }
  if (ticket.status === "todo") {
    return (
      <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" title="Spawns the agent in its own worktree, branch and port block.">
        <Play aria-hidden className="size-3" />
        Start
      </Button>
    );
  }
  if (ticket.status === "in_progress") {
    return (
      <>
        {/*
          Always offered, so every card in a column carries the same actions. Wiring it has to
          handle the two agents that will not take a prompt: Herdr reports no status once the
          pane is gone, and it refuses a blocked agent outright — `agent.prompt` answers
          `agent_blocked` and sends nothing (memory/agent-status.md). A blocked agent is
          answered in Herdr itself.
        */}
        <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" title="Sends another instruction to the running agent without interrupting it.">
          <ShipWheel aria-hidden className="size-3" />
          Steer
        </Button>
        <Button size="sm" variant="destructive" className="h-7 gap-1 px-2 text-[11px]" title="Discards the attempt: deletes the branch and worktree." onClick={onCancel}>
          <Ban aria-hidden className="size-3" />
          Cancel
        </Button>
      </>
    );
  }
  if (ticket.status === "in_review") {
    return (
      <>
        <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" title="Pushes the branch, opens a pull request, and retires the agent.">
          <Check aria-hidden className="size-3" />
          Accept
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]" title="Sends feedback back to the agent, which keeps working. Nothing is destroyed.">
          <Undo2 aria-hidden className="size-3" />
          Reject
        </Button>
        {/*
          MUST become conditional on the project's run config — command, port count and path
          to open — before this is wired: a backend-only project has no meaningful preview,
          and the recorded decision is that it HIDES rather than fails
          (memory/parking-lot.md). It binds the ticket's own port block, which is why a
          ticket in review still holds one. All three In Review buttons run at this tighter
          size so a labelled Preview still fits a five-column card. The lifecycle below is a
          local timer, so nothing is actually started or killed yet.
        */}
        <Button
          size="sm"
          variant={previewState === "live" || previewState === "stopping" ? "default" : "outline"}
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={previewState === "starting" || previewState === "stopping"}
          title={
            previewState === "live"
              ? "Stop the preview server."
              : previewState === "idle"
                ? "Preview — opens the agent's dev server on this ticket's port block."
                : undefined
          }
          onClick={onTogglePreview}
        >
          {previewState === "starting" || previewState === "stopping" ? (
            <Spinner aria-hidden className="size-3" />
          ) : previewState === "live" ? (
            <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
          ) : (
            <ExternalLink aria-hidden className="size-3" />
          )}
          {previewState === "starting"
            ? "Starting..."
            : previewState === "live"
              ? "Live"
              : previewState === "stopping"
                ? "Teardown..."
                : "Preview"}
        </Button>
      </>
    );
  }
  if (ticket.status === "done") {
    // Done is terminal, its pull request is already linked from the description row, and
    // reclaiming the worktree lives in the overflow menu — so the single action here is
    // Archive, which is UI ahead of the `archived` flag that does not exist yet
    // (memory/parking-lot.md).
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-[11px]"
        title="Hides the ticket from the board. Nothing is deleted."
      >
        <Archive aria-hidden className="size-3" />
        Archive
      </Button>
    );
  }
  return null;
}

/**
 * Every card is the same height, whatever state its ticket is in: an identity row, a one-line
 * title, a one-line description slot that is reserved even when empty, and one row that holds
 * the run actions plus whatever that ticket's state is worth saying — a live timer, a pull
 * request, a dead run. Everything else — the full description, derived fields, diagnostics,
 * Save/Delete — lives in `TicketSheet`, opened via the title or the overflow menu.
 *
 * The top right holds the overflow menu and nothing else.
 */
export function TicketCard({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const failed = runFailed(ticket);
  const running = ticket.status === "in_progress" && !failed;
  // Herdr refuses a prompt to a blocked agent — `agent.prompt` answers `agent_blocked` and sends
  // nothing (memory/agent-status.md) — so the ticket cannot move until a human answers in Herdr.
  // The elapsed time is noise next to that, so this replaces it rather than joining it.
  const blocked = ticket.agentStatus === "blocked";
  // A branch name and an agent name are formulas over the project slug and ticket number
  // (memory/naming.md), so every ticket has them as strings whether or not anything was ever
  // spawned. Only a run makes them real, and these two fields are what report one.
  const dispatched = ticket.sessionDir !== null || ticket.hasWorktree;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmWorktree, setConfirmWorktree] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState>("idle");
  const previewTimer = useRef<number | undefined>(undefined);

  // A card unmounts on every poll that changes it, and a pending timer would then set state on
  // a dead component.
  useEffect(() => () => clearTimeout(previewTimer.current), []);

  const handleTogglePreview = () => {
    // A click mid-transition must do nothing: the button is also disabled in these states, so
    // together they rule out a double-click queuing a second timer or leaving a stale one.
    if (previewState === "starting" || previewState === "stopping") return;
    if (previewState === "idle") {
      setPreviewState("starting");
      previewTimer.current = window.setTimeout(() => setPreviewState("live"), 2000);
    } else {
      setPreviewState("stopping");
      previewTimer.current = window.setTimeout(() => setPreviewState("idle"), 2000);
    }
  };

  return (
    <>
      {/* `article` named by its ticket id is the card's only accessible handle, and the e2e
          suite locates every card this way. A redesign may move or restyle anything inside;
          this must not move with it. */}
      <article
        aria-label={ticket.id}
        data-died={failed || undefined}
        onClick={(e) => {
          // Every interactive child already has its own job; only bare card surface opens the sheet.
          if ((e.target as HTMLElement).closest("button, a, input, select, [role='menu']")) return;
          onOpen();
        }}
        className="group cursor-pointer rounded-md border bg-card p-3 text-card-foreground shadow-xs transition-colors data-[died]:border-destructive/60"
      >
        {/* `h-5` keeps this row a fixed 20px whatever it contains, which is half of what makes
            every card the same height. */}
        <div className="flex h-5 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <CopyButton value={ticket.id} label={`Ticket id ${ticket.id}`} icon={Hash} />
            {dispatched && ticket.branch && (
              <CopyButton value={ticket.branch} label={`Branch ${ticket.branch}`} icon={GitBranch} tone="git" />
            )}
            {ticket.worktreePath && (
              <CopyButton
                value={ticket.worktreePath}
                label={`Worktree ${ticket.worktreePath}`}
                icon={TreePineIcon}
                tone="git"
              />
            )}
            {/* Gated on agentStatus, not agentName: the name is a formula and exists whether or
                not an agent does, so only agentStatus proves Herdr currently has one
                (memory/naming.md). */}
            {ticket.agentStatus !== null && (
              <CopyButton value={ticket.agentName} label={`Agent ${ticket.agentName}`} icon={Bot} tone="agent" />
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Ticket actions"
                className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <MoreHorizontal aria-hidden className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpen}>Open</DropdownMenuItem>
              {/*
                Not column-scoped: Accept keeps the worktree and the branch, so a worktree can
                exist on a ticket in any column, and manual removal is the only thing that
                reclaims one (memory/teardown.md).
              */}
              {ticket.hasWorktree && (
                <DropdownMenuItem onSelect={() => setConfirmWorktree(true)}>
                  <TreePineIcon aria-hidden />
                  Delete worktree
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <h3 className="mt-2 text-sm leading-snug font-medium">
          <button
            type="button"
            onClick={onOpen}
            title={ticket.title}
            className="block w-full truncate text-left hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none underline-offset-2"
          >
            {ticket.title}
          </button>
        </h3>

        {/*
          Description and state share one reserved 16px line. Putting the timer, the pull request and a
          dead run here rather than in the action row keeps state away from the buttons and costs no
          height, because this line renders even when the description is empty — which is what keeps
          every card the same height.
        */}
        <div className="mt-1 flex h-4 items-center gap-2">
          {/* the line is reserved whether or not there is text, so an empty description fills it with a dimmed "n/a" rather than leaving a gap that reads as a rendering fault */}
          <p
            className={`min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground${ticket.description ? "" : " italic opacity-70"}`}
            title={ticket.description || undefined}
          >
            {ticket.description || "n/a"}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <PullRequestLine ticket={ticket} />
            {blocked ? (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
                title="The agent is waiting on a question or approval. Answer it in Herdr."
              >
                <TriangleAlert aria-hidden className="size-3" />
                blocked
              </span>
            ) : (
              running && ticket.startedAt !== null && <RunTimer since={ticket.startedAt} />
            )}
            {failed && (
              <span className="inline-flex items-center gap-1 text-[11px] text-destructive" title="The pane exited before the agent finished.">
                <Unplug aria-hidden className="size-3" />
                died
              </span>
            )}
          </div>
        </div>

        {/* Experiment: stretch run-action buttons to fill the row. `h-7` holds the row open on a
            Done card, which is terminal and has no run action. */}
        <div className="mt-3 flex h-7 items-center gap-1.5 [&>*]:min-w-0 [&>*]:flex-1">
          <RunActions
            ticket={ticket}
            onCancel={() => setConfirmCancel(true)}
            previewState={previewState}
            onTogglePreview={handleTogglePreview}
          />
        </div>
      </article>
      <AlertDialog open={confirmWorktree} onOpenChange={setConfirmWorktree}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              Stops the running agent and closes its pane, force-removes the worktree directory and deletes the
              transcript. The branch and its commits are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => setConfirmWorktree(false)}
            >
              Delete worktree
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this attempt?</AlertDialogTitle>
            <AlertDialogDescription>
              Stops the agent and closes its pane, force-removes the worktree, deletes the branch and the
              transcript. Everything the agent did is discarded and the ticket returns to To Do. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => setConfirmCancel(false)}
            >
              Discard attempt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DeleteTicketDialog ticket={ticket} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </>
  );
}
