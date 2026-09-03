import { IconChristmasTreeFilled } from "@tabler/icons-react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Ban,
  Bot,
  Check,
  ExternalLink,
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
import { acceptTicket, moveTicket, spawnAgent, startPlanning } from "@/lib/api.ts";
import { runFailed } from "@/lib/board.ts";
import { REMOTE_TARGET, remoteCommand, type SteerMode } from "@/lib/steer-mode.ts";
import type { Status, Ticket } from "@/types.ts";

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
  // lucide-react and @tabler/icons-react export incompatible component types, so this only
  // names the props CopyButton actually passes through, which both packages satisfy structurally.
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
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

/**
 * A stored `prUrl` means the pull request exists; `prState` is only what a webhook has since
 * told us about it. Gating the whole line on the state suppressed a real, clickable link for
 * want of a decoration, so the link renders on the url alone and each decoration renders on
 * its own evidence.
 *
 * No icon is guessed when the state is unknown: `null` means "no webhook has reported this",
 * which is not the same as `open`, and drawing the open icon would be inventing a fact. Same
 * for the ±LOC pair, which needs both halves, and for the number — "PR #" with nothing after
 * it reads as a rendering fault rather than as a missing field.
 */
function PullRequestLine({ ticket }: { ticket: Ticket }) {
  const { prUrl, prState, prNumber, prAdditions, prDeletions } = ticket;
  if (!prUrl) return null;
  // Both derived from the same narrowed local, so the icon and its tone cannot disagree.
  const Icon = prState === null ? null : PR_ICON[prState];
  const tone = prState === null ? "" : PR_TONE[prState];

  return (
    <a
      href={prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-[11px] underline-offset-2 hover:underline"
    >
      {Icon !== null && <Icon aria-hidden className={`size-3.5 ${tone}`} />}
      <span className="font-mono">{prNumber === null ? "PR" : `PR #${prNumber}`}</span>
      {prAdditions !== null && prDeletions !== null && (
        <span className="font-mono">
          <span className="text-emerald-600 dark:text-emerald-400">+{prAdditions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">&minus;{prDeletions}</span>
        </span>
      )}
    </a>
  );
}

/**
 * Focus, not prompt — this always POSTs `/tickets/:id/focus`, which calls `agent.focus` in the
 * backend, never `agent.prompt`. Two mechanisms follow from that rather than from a prompt
 * refusal:
 *
 * Focusing marks the tab "seen", and that is what flips a `done` agent back to `idle`
 * (verified in `herdr --skill`) — steering a ticket the agent just finished can reopen it as a
 * side effect of this same call.
 *
 * Herdr also has per-client focus — `herdr --skill` warns "Do not rely on another client's
 * focused pane" — so whether a remote client freshly attached with `herdr --remote` lands on
 * the pane this call focused is UNVERIFIED; this button only guarantees the focus call itself.
 *
 * Remote mode additionally copies the attach command, reusing the tick-feedback timer
 * `CopyButton` already uses above rather than inventing a second pattern.
 */
function SteerButton({ ticket, steerMode }: { ticket: Ticket; steerMode: SteerMode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // A card unmounts on every poll that changes it, and a pending timer would then set state on
  // a dead component.
  useEffect(() => () => clearTimeout(timer.current), []);

  const remoteConfigured = steerMode === "remote" && REMOTE_TARGET !== "";
  const title =
    steerMode === "local"
      ? "Focuses the agent's pane in Herdr."
      : remoteConfigured
        ? "Copies the remote attach command and focuses the agent's pane in Herdr."
        : "VITE_HERDR_REMOTE_TARGET is unset, so the attach command cannot be copied.";

  return (
    <Button
      size="sm"
      className="h-7 gap-1 px-2 text-[11px]"
      title={title}
      onClick={() => {
        // Never copy "herdr --remote " with a missing target — copying only happens once a
        // target is actually configured. Focusing still runs either way.
        if (remoteConfigured) {
          void navigator.clipboard.writeText(remoteCommand());
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        }
        void fetch(`/tickets/${ticket.id}/focus`, { method: "POST" });
      }}
    >
      {copied ? <Check aria-hidden className="size-3" /> : <ShipWheel aria-hidden className="size-3" />}
      Steer
    </Button>
  );
}

type PreviewState = "idle" | "starting" | "live" | "stopping";

/**
 * The one write this card has in flight, or null. A single slot rather than a flag per button,
 * because the card's rule is one write at a time: every button that could start another is
 * disabled while one runs, and the value names which so only that button shows a spinner.
 */
type PendingAction = null | "plan" | "move" | "start" | "accept";

/**
 * One branch per status and never an `else`. Plan is scoped to `backlog`, Start to `todo`,
 * Steer and Cancel to `in_progress`, Accept and Reject to `in_review`, and the server answers
 * 409 from anywhere else — so an `else` would put a button on a card whose status cannot take
 * it. Done is terminal and its only run action is Archive; its pull request fills the rest of the row.
 * The two manual moves sit alongside them — To Do on `backlog`, Backlog on `todo`. Both are
 * human-only: they spawn nothing and retire nothing, which is why they are the only
 * transitions in this row that are pure status writes.
 *
 * Variants carry the consequence: the forward move is primary, a reversible move is outline,
 * and only the one that destroys something is destructive. Exactly one primary per card, so
 * the card always names a single next step — which is why a Backlog ticket hands the primary
 * from Plan to To Do the moment it HAS a plan, rather than showing two. Everything that is
 * not a state transition — Delete worktree, Edit, Delete — lives in the expanded region,
 * which is also what keeps this row inside the width of a five-column card.
 */
function RunActions({
  ticket,
  steerMode,
  pending,
  onPlan,
  onMove,
  onStart,
  onAccept,
  onCancel,
  previewState,
  onTogglePreview,
}: {
  ticket: Ticket;
  steerMode: SteerMode;
  pending: PendingAction;
  onPlan: () => void;
  onMove: (to: Status) => void;
  onStart: () => void;
  onAccept: () => void;
  onCancel: () => void;
  previewState: PreviewState;
  onTogglePreview: () => void;
}) {
  if (ticket.status === "backlog") {
    // The whole readiness signal, and deliberately the whole of it: a plan exists once BOTH
    // checklists are non-empty, which is exactly what the planning agent PATCHes back when it
    // is finished. Either alone is half a plan — a breakdown with nothing to check it against,
    // or criteria with no work behind them — and neither is inspected any further, because the
    // agent proposes by filling them in and the human confirms by clicking To Do. Computing it
    // here is the point: which plans are ripe has to be readable off the board without opening
    // a pane.
    const planned = ticket.taskBreakdown.length > 0 && ticket.acceptanceCriteria.length > 0;
    return (
      <>
        {/*
          Not instant: the route creates a workspace, a pane and an agent before it answers, so
          the spinner is the only thing between the click and several seconds of apparent
          nothing. Disabled for the whole of it — a second POST would answer 409
          `operation_in_flight`, and a planner that did start twice would be a paid agent.
        */}
        <Button
          size="sm"
          variant={planned ? "outline" : "default"}
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Talks the idea through with a planning agent until it is ready to start."
          onClick={onPlan}
        >
          {pending === "plan" ? (
            <Spinner aria-hidden className="size-3" />
          ) : (
            <NotebookPen aria-hidden className="size-3" />
          )}
          {pending === "plan" ? "Planning..." : "Plan"}
        </Button>
        <Button
          size="sm"
          variant={planned ? "default" : "outline"}
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title={
            planned
              ? "The plan is filled in. Moves the ticket to To Do, ready to start."
              : "Accepts the ticket as written and skips planning."
          }
          onClick={() => onMove("todo")}
        >
          <ArrowRight aria-hidden className="size-3" />
          To Do
        </Button>
      </>
    );
  }
  if (ticket.status === "todo") {
    return (
      <>
        {/*
          The slowest write on the board: the route creates the worktree, reserves the port
          block, writes the injected `.env` and waits for the agent to be genuinely ready
          before it answers, so there are several seconds between the click and anything
          changing. Disabled throughout, because a second POST that won the race would be a
          second paid agent — and the two 409s it can answer instead (`not_in_todo`,
          `port_pool_exhausted`) both roll the claim back to To Do, so the message on the card
          is the only evidence the click did anything at all.
        */}
        <Button
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Spawns the agent in its own worktree, branch and port block."
          onClick={onStart}
        >
          {pending === "start" ? (
            <Spinner aria-hidden className="size-3" />
          ) : (
            <Play aria-hidden className="size-3" />
          )}
          {pending === "start" ? "Starting..." : "Start"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Returns the ticket for re-planning. Nothing is destroyed."
          onClick={() => onMove("backlog")}
        >
          <ArrowLeft aria-hidden className="size-3" />
          Backlog
        </Button>
      </>
    );
  }
  if (ticket.status === "in_progress") {
    return (
      <>
        {/*
          Always offered, so every card in a column carries the same actions. This focuses
          rather than prompts — see the doc comment on `SteerButton` for the two mechanisms
          that follow from a focus call instead of a prompt.
        */}
        <SteerButton ticket={ticket} steerMode={steerMode} />
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
        {/*
          Pushes the branch and opens the pull request before it answers, so it is slow for the
          same reason Start is — and the only irreversible action on the board, since the pull
          request outlives any local rollback. When the push or the PR call fails the server
          hands the claim back to `in_review`, so the card must be seen to return to this
          column with the message showing rather than settle into Done: that is exactly what
          refreshing only on success buys.
        */}
        <Button
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Pushes the branch, opens a pull request, and retires the agent."
          onClick={onAccept}
        >
          {pending === "accept" ? (
            <Spinner aria-hidden className="size-3" />
          ) : (
            <Check aria-hidden className="size-3" />
          )}
          {pending === "accept" ? "Accepting..." : "Accept"}
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
export function TicketCard({
  ticket,
  steerMode,
  onOpen,
  onChanged,
}: {
  ticket: Ticket;
  steerMode: SteerMode;
  onOpen: () => void;
  /** Refreshes the board now that a write landed, instead of waiting out the poll interval. */
  onChanged: () => void;
}) {
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
  const [pending, setPending] = useState<PendingAction>(null);
  // The last write that failed, or null. Shown on the card rather than in a toast: the failure
  // belongs to THIS ticket — `not_in_backlog` means someone else's click already moved it,
  // `transition_has_side_effects` means the button asked for a move it does not own — and a
  // banner elsewhere would not say which card it was about.
  const [actionError, setActionError] = useState<string | null>(null);

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

  /**
   * The one path every wired button on this card takes. The guard is belt to the buttons'
   * braces: they are all disabled while a write runs, but a click already dispatched — or a
   * keyboard repeat — must not start a second POST either. For Plan and Start a second POST is
   * a second paid agent; for Accept it is a second pull request, which nothing can take back.
   *
   * The refresh is deliberately AFTER the await and only on success: the board is the source
   * of truth for where a ticket now is, and reading it back is what makes the card agree with
   * the server rather than with an optimistic guess this component made. On failure there is
   * no refresh and no guess to undo, so a failed Accept simply stays on an In Review card with
   * the message on it — which is where the server rolled its claim back to anyway.
   */
  const runAction = async (kind: Exclude<PendingAction, null>, write: () => Promise<void>) => {
    if (pending !== null) return;
    setPending(kind);
    setActionError(null);
    try {
      await write();
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
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
            {/* The id stays in the accessible tree through `<article aria-label={ticket.id}>`, so hiding the text here costs nothing to assistive tech. */}
            <CopyButton value={ticket.id} label={`Ticket id ${ticket.id}`} icon={Hash} />
            {dispatched && ticket.branch && (
              <CopyButton value={ticket.branch} label={`Branch ${ticket.branch}`} icon={GitBranch} tone="git" />
            )}
            {ticket.worktreePath && (
              <CopyButton
                value={ticket.worktreePath}
                label={`Worktree ${ticket.worktreePath}`}
                icon={IconChristmasTreeFilled}
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
              {/* The hit area comes from a transparent `::after`, not padding: the row is a
                  fixed `h-5` and this button draws its focus ring on its own box, so growing
                  the box would both overflow the row and enlarge the ring. */}
              <button
                type="button"
                aria-label="Ticket actions"
                className="relative shrink-0 rounded-sm text-muted-foreground transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
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
                  <IconChristmasTreeFilled aria-hidden />
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
          {/*
            A failed write takes over this line rather than adding one: the row is a fixed
            `h-4` and every card is the same height, so an extra line would make one card taller
            than its neighbours exactly when something has gone wrong. The description is the
            least urgent thing on the card and the full message stays in the `title`. `role`
            announces it, because the click that caused it gave no other feedback.

            Otherwise the line is reserved whether or not there is text, so an empty description
            fills it with a dimmed "n/a" rather than leaving a gap that reads as a rendering fault.
          */}
          {actionError !== null ? (
            <p className="min-w-0 flex-1 truncate text-xs leading-4 text-destructive" role="status" title={actionError}>
              {actionError}
            </p>
          ) : (
            <p
              className={`min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground${ticket.description ? "" : " italic opacity-70"}`}
              title={ticket.description || undefined}
            >
              {ticket.description || "n/a"}
            </p>
          )}
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
            steerMode={steerMode}
            pending={pending}
            onPlan={() => void runAction("plan", () => startPlanning(ticket.id))}
            onMove={(to) => void runAction("move", () => moveTicket(ticket.id, to))}
            onStart={() => void runAction("start", () => spawnAgent(ticket.id))}
            onAccept={() => void runAction("accept", () => acceptTicket(ticket.id))}
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
