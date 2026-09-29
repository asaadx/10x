import { Check, CircleX, Copy, ExternalLink, Play, Square, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { startPreview, stopPreview } from "@/lib/api.ts";
import { cn } from "@/lib/utils.ts";
import type { AgentState, Preview, Ticket } from "@/types.ts";

/**
 * The pieces of a ticket that describe its cloud session: the agent's self-reported state, the
 * link to the session tab (which is the whole of "Steer" now), and the local Preview of what it
 * pushed. Shared by the card, the sheet and the List view so the three cannot drift apart.
 *
 * Everything here is read off the board poll. The agent writes `agentState` / `agentNote`
 * straight into the shared database (docs/prototype-cloud.md) because a session's status has no
 * API; the board only ever reads it back.
 */

const STATE_LABEL: Record<AgentState, string> = {
  starting: "starting",
  working: "working",
  done: "done",
  blocked: "blocked",
  failed: "failed",
};

const STATE_TITLE: Record<AgentState, string> = {
  starting: "The session was started and the agent has not reported in yet.",
  working: "The agent reported that it is working.",
  done: "The agent reported that it has finished.",
  blocked: "The agent is waiting on you. Answer it in the session tab.",
  failed: "The agent reported that it could not finish.",
};

const STATE_TONE: Record<AgentState, string> = {
  starting: "text-muted-foreground",
  working: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-600 dark:text-emerald-400",
  blocked: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
};

function StateGlyph({ state }: { state: AgentState }) {
  switch (state) {
    case "starting":
      // `role`/`aria-label` off: the badge's own label already says "starting", and the
      // primitive's default "Loading" would be announced on top of it.
      return <Spinner aria-hidden role={undefined} aria-label={undefined} className="size-3" />;
    case "working":
      return (
        <span aria-hidden className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
        </span>
      );
    case "done":
      return <Check aria-hidden className="size-3" />;
    case "blocked":
      return <TriangleAlert aria-hidden className="size-3" />;
    case "failed":
      return <CircleX aria-hidden className="size-3" />;
  }
}

/**
 * A small word-plus-glyph for `agentState`, or nothing when the agent has never reported. For a
 * blocked agent the tooltip is its question, so hovering the card is enough to read what it
 * wants; the sheet shows it in full.
 */
export function AgentStateBadge({
  state,
  note,
  className,
}: {
  state: AgentState | null;
  note?: string | null;
  className?: string;
}) {
  if (state === null) return null;
  const title = state === "blocked" && note ? `Agent asks: ${note}` : STATE_TITLE[state];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] leading-4", STATE_TONE[state], className)}
      title={title}
      aria-label={`Agent ${STATE_LABEL[state]}`}
    >
      <span className="flex size-3 items-center justify-center">
        <StateGlyph state={state} />
      </span>
      {STATE_LABEL[state]}
    </span>
  );
}

const SESSION_NAME = { plan: "planning session", impl: "implementation session" } as const;

/**
 * Steer is a link now: the human talks to the agent in the claude.ai session tab, and there is
 * no board route behind it. An anchor, not a button that calls `window.open`, so middle-click,
 * copy-link and the browser's own new-tab handling all work.
 *
 * With no session the control still renders — a card's action row keeps its shape — but as a
 * disabled button whose reason sits on a wrapper, because a disabled button receives no pointer
 * events and its own `title` would never show.
 */
export function SessionLink({
  ticket,
  label = "Steer",
  size = "sm",
  variant = "default",
  className,
}: {
  ticket: Ticket;
  label?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline";
  className?: string;
}) {
  const classes = cn(size === "sm" && "h-7 gap-1 px-2 text-[11px]", className);
  if (ticket.sessionUrl === null) {
    return (
      <span className="w-full" title="No cloud session yet — Plan or Start creates one.">
        <Button size={size} variant={variant} disabled className={cn("w-full", classes)}>
          <ExternalLink aria-hidden className="size-3" />
          {label}
        </Button>
      </span>
    );
  }
  const kind = ticket.sessionKind === null ? "session" : SESSION_NAME[ticket.sessionKind];
  return (
    <Button asChild size={size} variant={variant} className={classes}>
      <a
        href={ticket.sessionUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Opens the ${kind} on claude.ai in a new tab — talk to the agent there.`}
      >
        <ExternalLink aria-hidden className="size-3" />
        {label}
      </a>
    </Button>
  );
}

/**
 * What the Preview is doing, from the poll's `ticket.preview` alone — the card and sheet hold no
 * preview state of their own, so a Preview started from one surface shows on the other.
 * `checkout` is the no-dev-command case: the branch is on disk and nothing was started.
 */
export type PreviewPhase = "none" | "checkout" | "running" | "exited";

export function previewPhase(preview: Preview | null): PreviewPhase {
  if (preview === null) return "none";
  if (preview.command === "") return "checkout";
  return preview.running ? "running" : "exited";
}

/** Click-to-copy with a brief tick, for the preview checkout's path. */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      title={`${label} — click to copy`}
      aria-label={`Copy ${label.toLowerCase()}`}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {copied ? <Check aria-hidden className="size-3 shrink-0" /> : <Copy aria-hidden className="size-3 shrink-0" />}
      <span className="truncate">{value}</span>
    </button>
  );
}

/**
 * The sheet's Preview section: start and stop, the live url, and — when the project has no dev
 * command — the checkout path to open by hand plus where to set one. Owns only its in-flight
 * flag and last error; the preview itself comes back on the next poll, which `onChanged` asks
 * for immediately.
 */
export function PreviewPanel({ ticket, onChanged }: { ticket: Ticket; onChanged: () => void }) {
  const [pending, setPending] = useState<null | "start" | "stop">(null);
  const [error, setError] = useState<string | null>(null);
  const { preview } = ticket;
  const phase = previewPhase(preview);

  const run = async (kind: "start" | "stop") => {
    if (pending !== null) return;
    setPending(kind);
    setError(null);
    try {
      if (kind === "start") await startPreview(ticket.id);
      else await stopPreview(ticket.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Preview</span>
        <div className="flex items-center gap-1.5">
          {phase === "running" && preview !== null && (
            <Button asChild size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]">
              <a href={preview.url} target="_blank" rel="noopener noreferrer" title={`Opens ${preview.url}`}>
                <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                {preview.url.replace(/^https?:\/\//, "")}
              </a>
            </Button>
          )}
          {phase === "none" ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={pending !== null}
              title="Checks the pushed branch out locally and runs the project's dev command on its own port."
              onClick={() => void run("start")}
            >
              {pending === "start" ? <Spinner aria-hidden className="size-3" /> : <Play aria-hidden className="size-3" />}
              {pending === "start" ? "Starting..." : "Start preview"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={pending !== null}
              title="Stops the dev server, removes the preview checkout and frees its ports."
              onClick={() => void run("stop")}
            >
              {pending === "stop" ? <Spinner aria-hidden className="size-3" /> : <Square aria-hidden className="size-3" />}
              {pending === "stop" ? "Stopping..." : "Stop"}
            </Button>
          )}
        </div>
      </div>
      {preview !== null && (
        <div className="grid gap-1.5">
          <CopyValue value={preview.path} label="Preview checkout path" />
          {phase === "checkout" && (
            <p className="text-[11px] text-muted-foreground">
              The branch is checked out here with <span className="font-mono">PORT={preview.port}</span> reserved, but
              nothing was started — this project has no dev command. Set one in the project settings (the pencil beside
              the project picker) and Preview will run it.
            </p>
          )}
          {phase === "exited" && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              <span className="font-mono">{preview.command}</span> is not running any more. Stop and start the preview
              to run it again.
            </p>
          )}
        </div>
      )}
      {error !== null && (
        <p role="status" className="rounded-md bg-destructive/10 p-2 text-xs break-words text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
