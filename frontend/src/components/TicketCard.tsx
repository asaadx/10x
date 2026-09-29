import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  CircleAlert,
  Eye,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hash,
  MoreHorizontal,
  NotebookPen,
  Play,
  Square,
  SquareArrowOutUpRight,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentStateBadge, previewPhase, SessionLink } from "@/components/AgentSession.tsx";
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
import {
  acceptTicket,
  archiveTicket,
  cancelTicket,
  deleteTicket,
  moveTicket,
  rejectTicket,
  spawnAgent,
  startPlanning,
  startPreview,
  stopPreview,
} from "@/lib/api.ts";
import { previewOffered, runFailed } from "@/lib/board.ts";
import { PRIORITIES, type Priority, type ProvisionState, type Status, type Ticket } from "@/types.ts";

export const PR_ICON = {
  merged: GitMerge,
  closed: GitPullRequestClosed,
  open: GitPullRequest,
} as const;

export const PR_TONE = {
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-red-600 dark:text-red-400",
  open: "text-emerald-600 dark:text-emerald-400",
} as const;

// Idle icon colour per identifier kind: the branch gets the git tone so it stands apart from
// the plain ticket id beside it.
const COPY_BUTTON_TONE = {
  default: "text-muted-foreground",
  git: "text-emerald-600 dark:text-emerald-400",
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
 * Read-only star badge: 1/2/3 filled stars for low/medium/high, immediately left of the
 * three-dot menu. Position in `PRIORITIES` is the count, the same rule the sheet's picker
 * uses, so there is no second low/medium/high-to-count mapping that could drift.
 */
export function PriorityBadge({ priority }: { priority: Priority }) {
  const count = PRIORITIES.indexOf(priority) + 1;
  return (
    <span
      className="flex shrink-0 items-center gap-px text-amber-500"
      title={`Priority: ${priority}`}
      aria-label={`Priority: ${priority}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <Star key={i} aria-hidden className="size-3 fill-current" />
      ))}
    </span>
  );
}

/**
 * Click-to-copy for the identifiers a ticket is handled by: its id, and the branch the agent
 * reported pushing. The branch is a value you paste into a terminal, never one you read, so it
 * is an icon here and spelled out in full in the sheet.
 *
 * Every glyph sits in its own `size-4` box and the label runs at `leading-4`, so they share one
 * 16px line box instead of each being centred against whatever happens to sit beside it.
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
  tone?: "default" | "git";
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
 * The one write this card has in flight, or null. A single slot rather than a flag per button,
 * because the card's rule is one write at a time: every button that could start another is
 * disabled while one runs, and the value names which so only that button shows a spinner.
 */
type PendingAction =
  | null
  | "plan"
  | "move"
  | "start"
  | "accept"
  | "reject"
  | "cancel"
  | "archive"
  | "preview"
  | "stopPreview"
  | "deleteTicket";

/**
 * Preview, driven entirely by `ticket.preview` from the poll: no local lifecycle, so a preview
 * started from the sheet (or before a reload) shows here too.
 *
 * - none: a button that POSTs `/tickets/:id/preview`.
 * - running: a link to the dev server, pulsing, in a new tab. Stopping lives in the overflow
 *   menu and the sheet, because this slot is the link.
 * - checkout (the project has no dev command) and exited: a button that opens the sheet, which
 *   has the checkout path to copy and says why nothing is serving.
 */
function PreviewButton({
  ticket,
  pending,
  onStart,
  onOpenSheet,
}: {
  ticket: Ticket;
  pending: PendingAction;
  onStart: () => void;
  onOpenSheet: () => void;
}) {
  const phase = previewPhase(ticket.preview);
  const classes = "h-7 gap-1 px-2 text-[11px]";
  if (phase === "running" && ticket.preview !== null) {
    return (
      <Button asChild size="sm" className={classes}>
        <a href={ticket.preview.url} target="_blank" rel="noopener noreferrer" title={`Open ${ticket.preview.url}`}>
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
          Live
        </a>
      </Button>
    );
  }
  if (phase === "checkout" || phase === "exited") {
    return (
      <Button
        size="sm"
        variant="outline"
        className={classes}
        title={
          phase === "checkout"
            ? "Checked out locally, but this project has no dev command. Open the ticket for the path."
            : "The dev command exited. Open the ticket to restart it."
        }
        onClick={onOpenSheet}
      >
        <Eye aria-hidden className="size-3" />
        {phase === "checkout" ? "Checkout" : "Exited"}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className={classes}
      disabled={pending !== null}
      title="Checks the pushed branch out locally and runs the project's dev command on its own port."
      onClick={onStart}
    >
      {pending === "preview" ? <Spinner aria-hidden className="size-3" /> : <Eye aria-hidden className="size-3" />}
      {pending === "preview" ? "Starting..." : "Preview"}
    </Button>
  );
}

/**
 * Wraps a button that spawns an agent, and explains the one reason it can be dead through no
 * fault of the click: `POST /tickets/:id/plan` and `/spawn` both answer 409
 * `project_not_provisioned` unless the project's repo is on disk, so neither may offer the
 * click in the first place.
 *
 * It takes the state rather than a boolean because the two dead states need different
 * sentences. Telling someone to wait for a download that already failed sends them to watch a
 * spinner that will never arrive; the fix is Retry in the banner above, so say that instead.
 *
 * The reason has to live on the WRAPPER. A disabled button receives no pointer events, so its
 * own `title` never surfaces — which would leave a dead button with no stated cause, the one
 * thing this must not be. The button inside takes `w-full`, since the actions row stretches its
 * direct children and the wrapper is now the child.
 */
/**
 * Undefined and any unrecognised value read as "no reason to block" — the same fail-open
 * direction the banner takes. A backend that predates `provision_state` sends no such field,
 * and disabling Plan and Start on every project because a field is missing would break the
 * board outright. The server refuses a genuine non-ready spawn with 409 either way, so the
 * cost of being wrong here is a visible error message, not a broken session.
 */
const SPAWN_BLOCKED: Record<string, (action: string) => string> = {
  pending: (action) => `10x is still downloading the repo. ${action} becomes available when it finishes.`,
  cloning: (action) => `10x is still downloading the repo. ${action} becomes available when it finishes.`,
  failed: (action) =>
    `This project's repo could not be downloaded, so ${action} cannot run. Retry it from the banner above.`,
};

const spawnBlocked = (state: ProvisionState | undefined): boolean =>
  state !== undefined && SPAWN_BLOCKED[state] !== undefined;

function spawnGateReason(state: ProvisionState | undefined, action: string): string | undefined {
  return state === undefined ? undefined : SPAWN_BLOCKED[state]?.(action);
}

function SpawnGate({
  state,
  action,
  children,
}: {
  state: ProvisionState | undefined;
  action: string;
  children: React.ReactNode;
}) {
  return (
    <span className="w-full" title={spawnGateReason(state, action)}>
      {children}
    </span>
  );
}

/**
 * One branch per status and never an `else`. Plan is scoped to `backlog`, Start to `todo`,
 * Steer and Cancel to `in_progress`, Accept and Reject to `in_review`, and the server answers
 * 409 from anywhere else — so an `else` would put a button on a card whose status cannot take
 * it. Done is terminal and its only run action is Archive; its pull request fills the rest of the row.
 * The two manual moves sit alongside them — To Do on `backlog`, Backlog on `todo`. Both are
 * human-only: they start nothing and stop nothing, which is why they are the only
 * transitions in this row that are pure status writes.
 *
 * Steer is a link to the cloud session, not a board action. A Backlog ticket whose planning
 * session is already open trades Plan for it — a second Plan would be a second paid session —
 * and In Review reaches its session from the icon in the card's top row, since that row
 * already holds three buttons.
 *
 * Variants carry the consequence: the forward move is primary, a reversible move is outline,
 * and only the one that destroys something is destructive. Exactly one primary per card, so
 * the card always names a single next step — which is why a Backlog ticket hands the primary
 * from Plan to To Do the moment it HAS a plan, rather than showing two. Everything that is
 * not a state transition — Edit, Delete, Stop preview — lives in the overflow menu or the
 * sheet, which is also what keeps this row inside the width of a five-column card.
 */
function RunActions({
  ticket,
  provisionState,
  pending,
  onPlan,
  onMove,
  onStart,
  onAccept,
  onReject,
  onCancel,
  onArchive,
  onPreview,
  onOpenSheet,
}: {
  ticket: Ticket;
  provisionState: ProvisionState | undefined;
  pending: PendingAction;
  onPlan: () => void;
  onMove: (to: Status) => void;
  onStart: () => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onPreview: () => void;
  onOpenSheet: () => void;
}) {
  const preview = previewOffered(ticket) ? (
    <PreviewButton ticket={ticket} pending={pending} onStart={onPreview} onOpenSheet={onOpenSheet} />
  ) : null;

  if (ticket.status === "backlog") {
    // The whole readiness signal, and deliberately the whole of it: a plan exists once BOTH
    // checklists are non-empty, which is exactly what the planning agent writes back when it
    // is finished. Either alone is half a plan — a breakdown with nothing to check it against,
    // or criteria with no work behind them — and neither is inspected any further, because the
    // agent proposes by filling them in and the human confirms by clicking To Do.
    const planned = ticket.taskBreakdown.length > 0 && ticket.acceptanceCriteria.length > 0;
    const planning = ticket.sessionKind === "plan" && ticket.sessionUrl !== null;
    return (
      <>
        {planning ? (
          <SessionLink ticket={ticket} variant={planned ? "outline" : "default"} />
        ) : (
          /*
            Not instant: the route starts a cloud session before it answers, so the spinner is
            the only thing between the click and several seconds of apparent nothing. Disabled
            for the whole of it — a second POST would answer 409 `operation_in_flight`, and a
            planner that did start twice would be a second paid session.
          */
          <SpawnGate state={provisionState} action="Plan">
            <Button
              size="sm"
              variant={planned ? "outline" : "default"}
              className="h-7 w-full gap-1 px-2 text-[11px]"
              disabled={pending !== null || spawnBlocked(provisionState)}
              title="Starts a planning session on claude.ai to talk the idea through until it is ready to start."
              onClick={onPlan}
            >
              {pending === "plan" ? (
                <Spinner aria-hidden className="size-3" />
              ) : (
                <NotebookPen aria-hidden className="size-3" />
              )}
              {pending === "plan" ? "Planning..." : "Plan"}
            </Button>
          </SpawnGate>
        )}
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
          Slow: the route starts a Claude Code cloud session before it answers. Disabled
          throughout, because a second POST that won the race would be a second paid session —
          and a failed start hands the claim back to To Do, so the message on the card is the
          only evidence the click did anything at all.
        */}
        <SpawnGate state={provisionState} action="Start">
          <Button
            size="sm"
            className="h-7 w-full gap-1 px-2 text-[11px]"
            disabled={pending !== null || spawnBlocked(provisionState)}
            title="Starts a Claude Code cloud session that implements this ticket and opens a draft PR."
            onClick={onStart}
          >
            {pending === "start" ? (
              <Spinner aria-hidden className="size-3" />
            ) : (
              <Play aria-hidden className="size-3" />
            )}
            {pending === "start" ? "Starting..." : "Start"}
          </Button>
        </SpawnGate>
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
        <SessionLink ticket={ticket} />
        {preview}
        <Button
          size="sm"
          variant="destructive"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Tells the agent to stop and returns the ticket to To Do."
          onClick={onCancel}
        >
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
          The only irreversible action on the board: the pull request outlives any local
          rollback. When the GitHub call fails the server hands the claim back to `in_review`,
          so the card must be seen to return to this column with the message showing rather
          than settle into Done: that is exactly what refreshing only on success buys.
        */}
        <Button
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Marks the agent's draft pull request ready for review (or opens one from its branch)."
          onClick={onAccept}
        >
          {pending === "accept" ? (
            <Spinner aria-hidden className="size-3" />
          ) : (
            <Check aria-hidden className="size-3" />
          )}
          {pending === "accept" ? "Accepting..." : "Accept"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={pending !== null}
          title="Sends feedback to the agent's session, which keeps working. Nothing is destroyed."
          onClick={onReject}
        >
          <Undo2 aria-hidden className="size-3" />
          Reject
        </Button>
        {preview}
      </>
    );
  }
  if (ticket.status === "done") {
    // Done is terminal and its pull request is already linked from the description row, so the
    // single action here is Archive. Disabled until the PR is recorded and terminal, because
    // the server re-verifies live and answers 409 otherwise — this is only so the button does
    // not invite a click that cannot succeed.
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={pending !== null || ticket.prNumber === null || (ticket.prState !== "merged" && ticket.prState !== "closed")}
        title="Hides the ticket from the board for good."
        onClick={onArchive}
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
 * the run actions plus whatever that ticket's state is worth saying — the agent's state, a
 * pull request, a failed click. Everything else — the full description, the agent's note, the
 * preview's details, Save/Delete — lives in `TicketSheet`, opened via the title or the overflow menu.
 *
 * The top right holds the overflow menu and nothing else.
 */
export function TicketCard({
  ticket,
  provisionState,
  onOpen,
  onChanged,
}: {
  ticket: Ticket;
  /** False while 10x is still downloading this ticket's project, which gates Plan and Start. */
  provisionState: ProvisionState | undefined;
  /**
   * Opens this ticket's sheet, handing it the last failed action so the full message is
   * readable there — the card itself only shows a one-word chip (see `actionError` below).
   */
  onOpen: (actionError: string | null) => void;
  /** Refreshes the board now that a write landed, instead of waiting out the poll interval. */
  onChanged: () => void;
}) {
  const failed = runFailed(ticket);
  // The run timer is the least urgent thing on the card, so it only shows while the agent has
  // not said anything about itself yet; any reported state takes the slot instead.
  const showTimer = ticket.status === "in_progress" && ticket.agentState === null && ticket.startedAt !== null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  // The last write that failed, or null. The failure belongs to THIS ticket — `not_in_backlog`
  // means someone else's click already moved it, `transition_has_side_effects` means the button
  // asked for a move it does not own — so a banner elsewhere would not say which card it was
  // about. The card shows a one-word chip for it and hands the text to the sheet, which is the
  // only surface with room to read it.
  //
  // Component state, deliberately: the message does NOT survive a reload, and it does not
  // survive this card remounting — which happens when a ticket changes column, because each
  // column renders its own list. It is feedback for a click that just happened rather than a
  // record of it, so losing it either way is accepted here rather than persisted or held in a
  // store.
  const [actionError, setActionError] = useState<string | null>(null);

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
   *
   * Returns whether the write succeeded, which is all a confirmation dialog needs to decide
   * its own fate: Cancel, Reject, Archive and Delete close themselves on `true` and
   * stay open on `false`, so a failure is read in place — next to the button that can retry
   * it — instead of behind a dialog that already closed.
   */
  const runAction = async (
    kind: Exclude<PendingAction, null>,
    write: () => Promise<void>,
  ): Promise<boolean> => {
    if (pending !== null) return false;
    setPending(kind);
    setActionError(null);
    try {
      await write();
      onChanged();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      return false;
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
        data-failed={failed || undefined}
        data-blocked={ticket.agentState === "blocked" || undefined}
        onClick={(e) => {
          // Every interactive child already has its own job; only bare card surface opens the sheet.
          if ((e.target as HTMLElement).closest("button, a, input, select, [role='menu']")) return;
          onOpen(actionError);
        }}
        className="group cursor-pointer rounded-md border bg-card p-3 text-card-foreground shadow-xs transition-colors data-[blocked]:border-amber-500/60 data-[failed]:border-destructive/60"
      >
        {/* `h-5` keeps this row a fixed 20px whatever it contains, which is half of what makes
            every card the same height. */}
        <div className="flex h-5 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* The id is now visible as text too — with several projects on one board, the id's
                project prefix (e.g. "jarvis-6") is the only at-a-glance way to tell which
                project a card belongs to without opening it. Still a CopyButton: the click-to-copy
                behavior is unchanged, this only stops hiding the value it already copies. */}
            <CopyButton value={ticket.id} label={`Ticket id ${ticket.id}`} icon={Hash}>
              <span className="truncate text-[11px] tabular-nums">{ticket.id}</span>
            </CopyButton>
            {/* The agent writes `branch` once it has pushed, so its presence is the evidence. */}
            {ticket.branch !== null && (
              <CopyButton value={ticket.branch} label={`Branch ${ticket.branch}`} icon={GitBranch} tone="git" />
            )}
            {/* The session link on every card that has one, whatever its column — In Review
                and a planned Backlog ticket have no Steer button in their action row. */}
            {ticket.sessionUrl !== null && (
              <a
                href={ticket.sessionUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open session on claude.ai (new tab)"
                aria-label="Open session"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-violet-600 transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none dark:text-violet-400"
              >
                <SquareArrowOutUpRight aria-hidden className="size-3" />
              </a>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <PriorityBadge priority={ticket.priority} />
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
                <DropdownMenuItem onClick={() => onOpen(actionError)}>Open</DropdownMenuItem>
                {/* Not status-scoped: a preview outlives a move to Done, and this is the only
                    way to free its ports from the card. */}
                {ticket.preview !== null && (
                  <DropdownMenuItem
                    disabled={pending !== null}
                    onSelect={() => void runAction("stopPreview", () => stopPreview(ticket.id))}
                  >
                    <Square aria-hidden />
                    Stop preview
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
        </div>

        <h3 className="mt-2 text-sm leading-snug font-medium">
          <button
            type="button"
            onClick={() => onOpen(actionError)}
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
            The line is reserved whether or not there is text, so an empty description fills it
            with a dimmed "n/a" rather than leaving a gap that reads as a rendering fault.

            A failed write no longer takes this over. The description is what identifies the
            ticket, and hiding it exactly when something has gone wrong is when the card is
            hardest to place; the failure is a chip on the right instead, and the sheet has the
            text.
          */}
          <p
            className={`min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground${ticket.description ? "" : " italic opacity-70"}`}
            title={ticket.description || undefined}
          >
            {ticket.description || "n/a"}
          </p>
          {/*
            Two chip slots after the pull request, and never a third: the row is a fixed `h-4`
            on a five-column card, so a third word would squeeze the description away.

            The first is the agent's own state (a blocked agent's question is its tooltip), or
            the run timer while it has not reported yet. The second is a failed click, which
            has no other feedback at all.
          */}
          <div className="flex shrink-0 items-center gap-2">
            <PullRequestLine ticket={ticket} />
            {showTimer && ticket.startedAt !== null ? (
              <RunTimer since={ticket.startedAt} />
            ) : (
              // A Done ticket's agent is done by definition, and its PR needs the room.
              <AgentStateBadge state={ticket.status === "done" ? null : ticket.agentState} note={ticket.agentNote} />
            )}
            {actionError !== null && (
              // `role` is what the full-text line this replaces carried, and the click that
              // caused the failure gave no other feedback. The visible word is only "failed",
              // so the message itself is announced from an `sr-only` span — absolutely
              // positioned, so it is not a flex item and costs this fixed row no width.
              <span
                role="status"
                className="inline-flex items-center gap-1 text-[11px] text-destructive"
                title={actionError}
              >
                <CircleAlert aria-hidden className="size-3" />
                failed
                <span className="sr-only">: {actionError}. Open the ticket to read it.</span>
              </span>
            )}
          </div>
        </div>

        {/* Experiment: stretch run-action buttons to fill the row. `h-7` holds the row open on a
            Done card, which is terminal and has no run action. */}
        <div className="mt-3 flex h-7 items-center gap-1.5 [&>*]:min-w-0 [&>*]:flex-1">
          <RunActions
            ticket={ticket}
            provisionState={provisionState}
            pending={pending}
            onPlan={() => void runAction("plan", () => startPlanning(ticket.id))}
            onMove={(to) => void runAction("move", () => moveTicket(ticket.id, to))}
            onStart={() => void runAction("start", () => spawnAgent(ticket.id))}
            onAccept={() => void runAction("accept", () => acceptTicket(ticket.id))}
            onReject={() => setConfirmReject(true)}
            onCancel={() => setConfirmCancel(true)}
            onArchive={() => setConfirmArchive(true)}
            onPreview={() => void runAction("preview", () => startPreview(ticket.id).then(() => undefined))}
            onOpenSheet={() => onOpen(actionError)}
          />
        </div>
      </article>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this attempt?</AlertDialogTitle>
            <AlertDialogDescription>
              Tells the agent to stop, unlinks its session from this ticket and returns the ticket to To Do. The
              session itself stays in claude.ai — archive it there if you want it gone — and anything it already
              pushed stays on GitHub.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Keep working</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={pending !== null}
              onClick={(e) => {
                e.preventDefault();
                void runAction("cancel", () => cancelTicket(ticket.id)).then((ok) => {
                  if (ok) setConfirmCancel(false);
                });
              }}
            >
              {pending === "cancel" && <Spinner aria-hidden />}
              {pending === "cancel" ? "Cancelling..." : "Cancel attempt"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmReject}
        onOpenChange={(open) => {
          setConfirmReject(open);
          if (!open) setRejectReason("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this work?</AlertDialogTitle>
            <AlertDialogDescription>
              Sends the reason below to the agent's session, which keeps working on this ticket and pushes to the same pull request.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="What needs to change?"
            rows={4}
            disabled={pending !== null}
            className="min-h-24 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Keep in review</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null || rejectReason.trim() === ""}
              onClick={(e) => {
                e.preventDefault();
                void runAction("reject", () => rejectTicket(ticket.id, rejectReason.trim())).then((ok) => {
                  if (ok) setConfirmReject(false);
                });
              }}
            >
              {pending === "reject" && <Spinner aria-hidden />}
              {pending === "reject" ? "Rejecting..." : "Reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this ticket?</AlertDialogTitle>
            <AlertDialogDescription>
              The ticket is hidden from the board for good — there is no un-archive. Its pull request and branch
              stay on GitHub. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={pending !== null}
              onClick={(e) => {
                e.preventDefault();
                void runAction("archive", () => archiveTicket(ticket.id)).then((ok) => {
                  if (ok) setConfirmArchive(false);
                });
              }}
            >
              {pending === "archive" && <Spinner aria-hidden />}
              {pending === "archive" ? "Archiving..." : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DeleteTicketDialog
        ticket={ticket}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        pending={pending === "deleteTicket"}
        onConfirm={() => {
          void runAction("deleteTicket", () => deleteTicket(ticket.id)).then((ok) => {
            if (ok) setConfirmDelete(false);
          });
        }}
      />
    </>
  );
}
