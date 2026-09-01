/**
 * Wiring: what a click means, what a poll does, and the boot sequence.
 *
 * This is the only layer that decides anything. It reads from api.js, writes to state.js
 * and asks render.js to draw — and it never touches `document` itself, which is what makes
 * a redesign a change to render.js and styles.css alone.
 *
 * TODO: replace the poll with SSE once the backend pushes Herdr events directly
 * (memory/parking-lot.md) — the 1000ms interval below is a placeholder. The backend already
 * learns of `pane.agent_status_changed` the instant it fires; only the browser is behind.
 */
import {
  deleteTicket,
  deleteWorktree,
  fetchBoard,
  fetchProjects,
  messageFor,
  patchTicket,
  postAccept,
  postCancel,
  postFocus,
  postReject,
  postSpawn,
  postTicket,
} from "./api.js";
import {
  attachCommandFor,
  findTicket,
  setDiag,
  markCopied,
  pendingActions,
  setActionError,
  state,
} from "./state.js";
import {
  bindControls,
  clearComposerErrors,
  clearComposerText,
  composerHasField,
  readComposerDraft,
  renderBoard,
  renderCard,
  renderComposer,
  renderProjectSelectors,
  setComposerSubmitting,
  showComposerError,
} from "./render.js";

/** The one object render.js calls back into. Nothing else crosses the seam. */
const handlers = {
  onProjectChange,
  onComposerSubmit,
  onComposerOpen,
  onComposerClose,
  onCardAction,
  onEditInput,
  onDiagToggle,
};

/* ---------------------------------------------------------------------
 * Polling
 * ------------------------------------------------------------------- */

async function loadProjects() {
  const { ok, body } = await fetchProjects();
  state.projects = ok && Array.isArray(body) ? body : [];
  renderProjectSelectors();
}

async function loadTickets() {
  const { ok, status, body } = await fetchBoard(state.currentProjectId);
  if (ok && body && Array.isArray(body.tickets)) {
    state.ticketsData = { tickets: body.tickets, unowned: Array.isArray(body.unowned) ? body.unowned : [] };
    state.boardErrorMsg = null;
  } else {
    // Keep the last-known board on screen; a transient poll failure shouldn't blank it.
    // The board-error banner is the only surface for this now.
    state.boardErrorMsg = messageFor(body, status);
  }
  renderBoard(handlers);
}

/* ---------------------------------------------------------------------
 * Header and composer
 * ------------------------------------------------------------------- */

function onProjectChange(value) {
  state.currentProjectId = value || null;
  renderProjectSelectors();
  loadTickets();
}

function onComposerOpen() {
  clearComposerErrors();
  state.composerOpen = true;
  renderComposer();
}

/**
 * Also runs for Escape and the backdrop, via the dialog's own `close` event, so this is
 * the single place the drawer's closed state is recorded. Text is cleared on the way out:
 * reopening should be a fresh ticket, not a half-typed one.
 */
function onComposerClose() {
  state.composerOpen = false;
  clearComposerText();
  clearComposerErrors();
  renderComposer();
}

async function onComposerSubmit() {
  clearComposerErrors();
  const { title, description, projectId } = readComposerDraft();

  if (!title) {
    showComposerError("title", "required");
    return;
  }
  if (!projectId) {
    showComposerError("projectId", "pick a project");
    return;
  }

  setComposerSubmitting(true);
  try {
    const { ok, status, body } = await postTicket({ projectId, title, description });
    if (ok) {
      clearComposerText();
      state.composerOpen = false;
      renderComposer();
      await loadTickets();
      return;
    }
    // The server attributes a validation failure to a field when it can; anything else is
    // a form-level message rather than being dropped.
    if (body && composerHasField(body.field)) {
      showComposerError(body.field, body.message || body.error || "invalid");
    } else {
      showComposerError("form", messageFor(body, status));
    }
  } finally {
    setComposerSubmitting(false);
  }
}

/* ---------------------------------------------------------------------
 * Card actions
 * ------------------------------------------------------------------- */

/**
 * `pendingActions` is the client-side half of the guard: the server rejects a second
 * concurrent operation with 409 `operation_in_flight` regardless, this just stops the
 * button from firing it. `finally` always re-polls, so a failure still refreshes the board.
 */
async function runAction(ticket, fn) {
  if (pendingActions.has(ticket.id)) return;
  pendingActions.add(ticket.id);
  renderCard(ticket, handlers);
  try {
    const { ok, status, body } = await fn();
    setActionError(ticket.id, ok ? null : messageFor(body, status));
  } finally {
    pendingActions.delete(ticket.id);
    await loadTickets();
  }
}

/**
 * Copy the attach command, then pre-focus the pane. The clipboard write comes first and its
 * failure is reported on the card: the command is the useful half, and `/focus` never fails
 * the request — a dead agent is an ordinary outcome reported inside a 200.
 */
async function steer(ticket) {
  const cmd = attachCommandFor(ticket);
  if (!cmd) {
    setActionError(ticket.id, "no agent attached to this ticket yet");
    renderCard(ticket, handlers);
    return;
  }
  try {
    await navigator.clipboard.writeText(cmd);
    markCopied(ticket.id);
    setActionError(ticket.id, null);
    renderCard(ticket, handlers);
    // Repaint once the confirmation has expired, in case no poll lands in between.
    setTimeout(() => renderCard(findTicket(ticket.id) || ticket, handlers), 1850);
  } catch (err) {
    setActionError(ticket.id, `clipboard write failed: ${String(err)}`);
    renderCard(ticket, handlers);
  }
  const { ok, status, body } = await postFocus(ticket.id);
  if (!ok) {
    setActionError(ticket.id, messageFor(body, status));
    renderCard(ticket, handlers);
  }
}

function startEdit(ticket) {
  state.editingId = ticket.id;
  state.editBuffer = { title: ticket.title, description: ticket.description };
  state.editFieldError = null;
  renderCard(ticket, handlers);
}

function cancelEdit(ticket) {
  state.editingId = null;
  state.editFieldError = null;
  renderCard(ticket, handlers);
}

async function saveEdit(ticket) {
  state.editFieldError = null;
  const { ok, status, body } = await patchTicket(ticket.id, {
    title: state.editBuffer.title,
    description: state.editBuffer.description,
  });
  if (ok) {
    state.editingId = null;
    await loadTickets();
    return;
  }
  state.editFieldError = messageFor(body, status);
  renderCard(ticket, handlers);
}

/**
 * `data-act` value -> what it does. The two destructive actions confirm first, and both
 * confirmations name what is unrecoverable: cancel discards the branch and the worktree,
 * delete drops the row.
 */
const CARD_ACTIONS = {
  spawn: (t) => runAction(t, () => postSpawn(t.id)),
  cancel: (t) => {
    if (!confirm(`Cancel "${t.title}"? This DISCARDS the in-progress attempt: the branch and worktree are deleted and cannot be recovered.`)) return;
    runAction(t, () => postCancel(t.id));
  },
  "drop-worktree": (t) => runAction(t, () => deleteWorktree(t.id)),
  accept: (t) => runAction(t, () => postAccept(t.id)),
  // The reason becomes the agent's re-prompt, so a blank one is useless: `prompt` mirrors
  // the `confirm` used by cancel/delete above, and a cancelled or blank prompt sends nothing.
  reject: (t) => {
    const reason = window.prompt("What needs to change before this is accepted?")?.trim();
    if (!reason) return;
    runAction(t, () => postReject(t.id, reason));
  },
  edit: startEdit,
  delete: (t) => {
    if (!confirm(`Delete ticket "${t.title}"? This cannot be undone.`)) return;
    runAction(t, () => deleteTicket(t.id));
  },
  steer,
  "save-edit": saveEdit,
  "cancel-edit": cancelEdit,
};

/**
 * `ticket` is the copy the card was rendered from; the live row is preferred so a click
 * acts on current data, and the captured copy is the fallback for a row that has since
 * left the board.
 */
function onCardAction(act, ticket) {
  if (!Object.hasOwn(CARD_ACTIONS, act)) return;
  CARD_ACTIONS[act](findTicket(ticket.id) || ticket);
}

function onEditInput(field, value) {
  state.editBuffer[field] = value;
}

/** The <details> element already moved; we only record it so the next render can restore it. */
function onDiagToggle(id, open) {
  setDiag(id, open);
}

/* ---------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------- */

bindControls(handlers);
await loadProjects();
await loadTickets();
setInterval(loadTickets, 1000);
setInterval(loadProjects, 5000);
