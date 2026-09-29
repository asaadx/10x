import { Plus } from "lucide-react";

import { TicketCard } from "@/components/TicketCard.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { columnIsWorking } from "@/lib/board.ts";
import type { ProvisionState, Status, Ticket } from "@/types.ts";

/**
 * One per column: the column accents, in state-machine order.
 */
const DOT: Record<Status, string> = {
  backlog: "bg-neutral-400",
  todo: "bg-blue-500",
  in_progress: "bg-amber-500",
  in_review: "bg-orange-500",
  done: "bg-emerald-500",
};

const SPINNER: Record<Status, string> = {
  backlog: "text-neutral-400",
  todo: "text-blue-500",
  in_progress: "text-amber-500",
  in_review: "text-orange-500",
  done: "text-emerald-500",
};

type Props = {
  status: Status;
  label: string;
  tickets: Ticket[];
  /**
   * Which projects have their repo on disk. Keyed by id rather than a single flag, because
   * `All projects` mixes cards from several projects into one column and Start is refused per
   * project, not per column.
   */
  projectStates: Record<string, ProvisionState>;
  onNewTicket?: () => void;
  /** The card hands over its last failed action so the sheet can show the full message. */
  onOpenTicket: (ticket: Ticket, actionError: string | null) => void;
  /** Passed straight to each card: a write landed, so re-read the board now. */
  onTicketChanged: () => void;
};

export function Column({
  status,
  label,
  tickets,
  projectStates,
  onNewTicket,
  onOpenTicket,
  onTicketChanged,
}: Props) {
  const headingId = `${status}-heading`;
  // columnIsWorking means "an agent in this column reported starting or working": a planning
  // session in Backlog lights it as much as an implementation one. A Preview is a dev server on
  // a port, not an agent, and deliberately does not.
  const working = columnIsWorking(tickets);

  return (
    // A `region` labelled by its own heading, so the accessible name carries the live count
    // ("Backlog 2") with no duplicated string to drift. The e2e suite locates columns this way.
    <section
      aria-labelledby={headingId}
      data-status={status}
      className="flex min-w-0 flex-col rounded-md border bg-muted/40"
    >
      {/*
        The heading `div` holds only the dot, the labelled h2, and the working spinner: the
        New ticket button lives in the footer below, never inside the h2's `aria-labelledby`
        subtree, so it can never append its label to the region's accessible name.
      */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b px-3">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[status]}`} />
        {/*
          The count stays INSIDE the h2: `aria-labelledby` points here, so the region's
          accessible name is "Backlog 2" and the e2e suite locates columns by it. Styling the
          count as a pill is safe; moving it out of the heading is not.

          The `{" "}` is load-bearing for the same reason. Flex `gap` is drawn, not text, so
          without a real whitespace node the accessible name computes as "Backlog2" and every
          column locator in the suite misses.
        */}
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-sm font-medium tracking-tight">
          <span className="truncate">{label}</span>{" "}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums">
            {tickets.length}
          </span>
        </h2>

        <div className="ml-auto flex items-center gap-1">
          {working && <Spinner aria-label="agent working" className={`size-3.5 ${SPINNER[status]}`} />}
        </div>
      </div>

      {/* Scrolls inside a fixed-height column, so the board never grows past the viewport. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tickets.length === 0 && (
          <p data-empty className="px-1 py-6 text-center text-xs text-muted-foreground">
            nothing here
          </p>
        )}
        {tickets.map((t) => (
          <TicketCard
            key={t.id}
            ticket={t}
            provisionState={projectStates[t.projectId]}
            onOpen={(actionError) => onOpenTicket(t, actionError)}
            onChanged={onTicketChanged}
          />
        ))}
      </div>

      {/*
        Pinned below the scroll region, not inside it: it never occupies card space and never
        scrolls away with the list. The border reads it as column chrome, not as a card.
      */}
      {onNewTicket && (
        <div className="shrink-0 border-t p-2">
          <Button
            variant="ghost"
            className="h-8 w-full justify-center gap-1 text-xs text-muted-foreground"
            onClick={onNewTicket}
          >
            <Plus aria-hidden className="size-3.5" />
            New ticket
          </Button>
        </div>
      )}
    </section>
  );
}
