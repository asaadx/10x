/**
 * Module state, and the derivations that read it.
 *
 * No DOM and no `fetch` in this file: it is the answer to "what does the board
 * currently believe?", nothing more. The board is a projection of this object, so a
 * redesign changes how it is drawn and never what it is.
 */

export const state = {
  /** @type {Array<{id:string,name:string,repoPath:string,baseBranch:string}>} */
  projects: [],
  /** null = "All projects". */
  currentProjectId: null,
  ticketsData: { tickets: [], unowned: [] },
  boardErrorMsg: null,
  /** false once a poll has failed; the last-known board stays on screen regardless. */
  live: true,
  /** id of the ticket being edited inline; that card is frozen against re-render. */
  editingId: null,
  /** Live buffer for the open edit form, so a poll landing mid-edit can't clobber keystrokes. */
  editBuffer: { title: "", description: "" },
  editFieldError: null,
};

/** Per-ticket last action error, surfaced on the card until the next action clears it. */
export const actionErrors = new Map();

/** Ticket ids with an action in flight client-side (belt-and-suspenders on top of server `busy`). */
export const pendingActions = new Set();

/**
 * Ticket id -> epoch ms when its "copied" confirmation should stop showing. Map-backed
 * (not a DOM-appended sibling) so a poll landing mid-flash re-renders the card without
 * erasing it.
 */
const copyConfirms = new Map();

export function findTicket(id) {
  return state.ticketsData.tickets.find((t) => t.id === id);
}

export function setActionError(id, msg) {
  if (msg) actionErrors.set(id, msg);
  else actionErrors.delete(id);
}

export function markCopied(id) {
  copyConfirms.set(id, Date.now() + 1800);
}

export function copyConfirmActive(id) {
  const until = copyConfirms.get(id);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    copyConfirms.delete(id);
    return false;
  }
  return true;
}

/** The server's own `busy`, plus the click we have not heard back about yet. */
export function isBusy(ticket) {
  return Boolean(ticket.busy) || pendingActions.has(ticket.id);
}

/** An actively-edited card must survive the poll that lands underneath it. */
export function cardIsProtected(id) {
  return state.editingId === id;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

/**
 * Best-effort attach command; `agentName` is only set once a ticket has actually spawned.
 *
 * The host is derived from where THIS PAGE was loaded from, which is exactly the machine
 * Herdr runs on — the backend needs Herdr's unix socket, so the board is always served
 * from the host. So if you opened it on localhost you are already there and `--remote`
 * would make herdr SSH to itself; if you opened it over the tailnet, that same hostname
 * is the one to pass. Zero configuration, and correct from either machine.
 */
export function attachCommandFor(ticket) {
  if (!ticket.agentName) return null;
  const host = location.hostname;
  const prefix = LOOPBACK.has(host) ? "herdr" : `herdr --remote ${host}`;
  return `${prefix} agent attach ${ticket.agentName}`;
}

/**
 * What a Done card should show about its PR, or `null` when there is nothing to show — not
 * done, or done without a PR yet. `state` stays whatever the last webhook reported (`null` if
 * none ever arrived — see memory/frontend.md: that is "we have not heard", not "open").
 */
export function prMetaFor(ticket) {
  if (ticket.status !== "done" || !ticket.prUrl) return null;
  return {
    url: ticket.prUrl,
    number: ticket.prNumber,
    state: ticket.prState ?? null,
    additions: ticket.prAdditions ?? null,
    deletions: ticket.prDeletions ?? null,
  };
}
