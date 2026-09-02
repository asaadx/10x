import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ExternalLink,
  TreePineIcon,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hash,
  NotebookPen,
  Pencil,
  Play,
  ShipWheel,
  Timer,
  Trash2,
  Undo2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
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

/**
 * Whether the agent has stopped in a column it should be running in.
 *
 * `working` is what an In Progress card is supposed to look like. Every other status there
 * means nothing will happen until a human looks: `idle`/`done` are the same state and may be a
 * prose question Herdr cannot tell from success, `blocked` is a question it can — and
 * `agent.prompt` refuses a blocked agent outright — and `unknown` never proves completion
 * (memory/agent-status.md).
 *
 * This tints the run timer rather than raising a chip. The state is real and worth seeing, but
 * it does not earn a badge of its own.
 */
function agentStalled(ticket: Ticket): boolean {
  return ticket.status === "in_progress" && ticket.agentStatus !== null && ticket.agentStatus !== "working";
}

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
 * PLACEHOLDER SOURCE: this counts from `updatedAt`, which is the closest thing the row has to a
 * run start and is not one. `setRunFields` appends `updated_at` unconditionally, so every
 * lifecycle write — the branch, the agent name, `finished` — moves it. A truthful timer needs a
 * `started_at` written once when the spawn CAS wins; until that exists this resets whenever the
 * run touches the row.
 */
function RunTimer({ since, stalled }: { since: string; stalled: boolean }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      title={
        stalled
          ? "The agent has stopped and will not continue without you."
          : "How long the agent has been on this ticket"
      }
      className={`inline-flex items-center gap-1 text-[11px] tabular-nums ${
        stalled ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      }`}
    >
      <Timer aria-hidden className="size-3" />
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
  children,
}: {
  value: string;
  label: string;
  icon: LucideIcon;
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
      className="inline-flex min-w-0 shrink items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {copied ? (
          <Check aria-hidden className="size-3 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Icon aria-hidden className="size-3" />
        )}
      </span>
      {children}
    </button>
  );
}

/** A labelled line in the expanded region, carrying the same icon that marks it when collapsed. */
function Detail({ term, icon: Icon, children }: { term: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <Icon aria-hidden className="size-3 shrink-0" />
        {term}
      </dt>
      <dd className="break-all font-mono">{children}</dd>
    </>
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

/**
 * One branch per status and never an `else`. Plan is scoped to `backlog`, Start to `todo`,
 * Steer and Cancel to `in_progress`, Accept and Reject to `in_review`, and the server answers
 * 409 from anywhere else — so an `else` would put a button on a card whose status cannot take
 * it. Done is terminal and draws no run action; its pull request fills the row instead.
 *
 * Variants carry the consequence: the forward move is primary, a reversible move is outline,
 * and only the one that destroys something is destructive. Everything that is not a state
 * transition — Preview, Delete worktree, Edit, Delete — lives in the expanded region, which is
 * also what keeps this row inside the width of a five-column card.
 */
function RunActions({ ticket }: { ticket: Ticket }) {
  if (ticket.status === "backlog") {
    return (
      <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Talks the idea through with a planning agent until it is ready to start.">
        <NotebookPen aria-hidden className="size-3.5" />
        Plan
      </Button>
    );
  }
  if (ticket.status === "todo") {
    return (
      <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Spawns the agent in its own worktree, branch and port block.">
        <Play aria-hidden className="size-3.5" />
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
        <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Sends another instruction to the running agent without interrupting it.">
          <ShipWheel aria-hidden className="size-3.5" />
          Steer
        </Button>
        <Button size="sm" variant="destructive" className="h-7 gap-1.5 px-2.5 text-xs" title="Discards the attempt: deletes the branch and worktree.">
          <Ban aria-hidden className="size-3.5" />
          Cancel
        </Button>
      </>
    );
  }
  if (ticket.status === "in_review") {
    return (
      <>
        <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Pushes the branch, opens a pull request, and retires the agent.">
          <Check aria-hidden className="size-3.5" />
          Accept
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" title="Sends feedback back to the agent, which keeps working. Nothing is destroyed.">
          <Undo2 aria-hidden className="size-3.5" />
          Reject
        </Button>
      </>
    );
  }
  return null;
}

/**
 * Every card is the same height collapsed, whatever state its ticket is in: an identity row, a
 * one-line title, a one-line description slot that is reserved even when empty, and one row
 * that holds the run actions plus whatever that ticket's state is worth saying — a live timer,
 * a pull request, a dead run. Anything else lives below the fold, so a column of cards scans as
 * a list rather than as a ragged stack.
 *
 * The top right holds the disclosure chevron and nothing else.
 */
export function TicketCard({ ticket }: { ticket: Ticket }) {
  const [open, setOpen] = useState(false);
  const failed = runFailed(ticket);
  const running = ticket.status === "in_progress" && !failed;

  return (
    // `article` named by its ticket id is the card's only accessible handle, and the e2e suite
    // locates every card this way. A redesign may move or restyle anything inside; this must not
    // move with it.
    <article
      aria-label={ticket.id}
      data-died={failed || undefined}
      className="group rounded-md border bg-card p-3 text-card-foreground shadow-xs transition-colors data-[died]:border-destructive/60"
    >
      {/* `h-5` keeps this row a fixed 20px whatever it contains, which is half of what makes
          every collapsed card the same height. */}
      <div className="flex h-5 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <CopyButton value={ticket.id} label="Ticket id" icon={Hash}>
            <span className="truncate font-mono text-xs leading-4">{ticket.id}</span>
          </CopyButton>
          {ticket.branch && <CopyButton value={ticket.branch} label={`Branch ${ticket.branch}`} icon={GitBranch} />}
          {ticket.worktreePath && (
            <CopyButton value={ticket.worktreePath} label={`Worktree ${ticket.worktreePath}`} icon={TreePineIcon} />
          )}
        </div>

        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          title={open ? "Hide details" : "Show details"}
          className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown aria-hidden className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      <h3
        className={`mt-2 text-sm leading-snug font-medium ${open ? "" : "truncate"}`}
        title={open ? undefined : ticket.title}
      >
        {ticket.title}
      </h3>

      {/*
        One description, two shapes. Closed it is a reserved single line — rendered even when
        empty, which is what keeps every collapsed card the same height. Open it wraps in place,
        so the full text appears where the reader is already looking instead of being repeated
        further down.
      */}
      <p
        className={`mt-1 text-xs leading-4 text-muted-foreground ${open ? "" : "h-4 truncate"}`}
        title={open ? undefined : ticket.description}
      >
        {ticket.description}
      </p>

      {/*
        `h-7` holds this row open on a Done card, which is terminal and has no run action. State
        that used to sit in the top right — the pull request, the run timer — is right-aligned
        here instead, where a Done card has empty space and the chevron is not sharing an edge
        with a link.
      */}
      <div className="mt-3 flex h-7 items-center gap-1.5">
        <RunActions ticket={ticket} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <PullRequestLine ticket={ticket} />
          {running && <RunTimer since={ticket.updatedAt} stalled={agentStalled(ticket)} />}
          {failed && (
            <span className="inline-flex items-center gap-1 text-[11px] text-destructive" title="The pane exited before the agent finished.">
              <Unplug aria-hidden className="size-3" />
              died
            </span>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-2 border-t pt-3 text-[11px]">
          {failed && (
            <p className="rounded-md bg-destructive/10 p-2 text-destructive">
              Run died — the pane exited before finishing. The worktree was kept so you can inspect it.
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
            {ticket.branch && (
              <Detail term="Branch" icon={GitBranch}>
                {ticket.branch}
              </Detail>
            )}
            {ticket.worktreePath && (
              <Detail term="Worktree" icon={TreePineIcon}>
                {ticket.worktreePath}
              </Detail>
            )}
            {/* Accept is `retireAgent` — it closes the pane and deletes the transcript
                (memory/teardown.md), so a Done ticket's `agentName` names an agent that no
                longer exists. */}
            {ticket.agentName && ticket.status !== "done" && (
              <Detail term="Agent" icon={Bot}>
                {ticket.agentName}
              </Detail>
            )}
          </dl>

          <div className="flex flex-wrap items-center gap-1 border-t pt-2">
            {/*
              MUST become conditional on the project's run config — command, port count and path
              to open — before this is wired: a backend-only project has no meaningful preview,
              and the recorded decision is that it HIDES rather than fails
              (memory/parking-lot.md). It binds the ticket's own port block, which is why a
              ticket in review still holds one.
            */}
            {ticket.status === "in_review" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs"
                title="Opens the agent's dev server on this ticket's port block."
              >
                <ExternalLink aria-hidden className="size-3.5" />
                Preview
              </Button>
            )}
            {ticket.status === "in_progress" && ticket.hasWorktree && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs"
                title="Reclaims disk space. The branch and its commits are kept."
              >
                <TreePineIcon aria-hidden className="size-3.5" />
                Delete tree
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs">
              <Pencil aria-hidden className="size-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 aria-hidden className="size-3.5" />
              Delete
            </Button>
          </div>

          {/* Off unless VITE_DIAGNOSTICS=true; see frontend/.env.example. */}
          {import.meta.env["VITE_DIAGNOSTICS"] === "true" && ticket.diagnostics && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-2 font-mono text-muted-foreground">
              {Object.entries(ticket.diagnostics).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </article>
  );
}
