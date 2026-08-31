/**
 * The DOM layer. Every `document` reference in the frontend lives in this file.
 *
 * It reads state and writes markup, and it never decides anything: no `fetch`, no state
 * mutation, no transitions. Behaviour reaches it as a `handlers` object, and user intent
 * leaves through that same object — so a card can be relaid out, recoloured or given
 * different icons without any path through here changing what a click does.
 *
 * Two rules make that guarantee real, and both are load-bearing:
 *
 *  1. **Nothing is located by class.** Elements are found by id, by `data-*` or by role.
 *     Classes below are styling handles only; deleting one changes appearance and cannot
 *     change behaviour.
 *  2. **State leaves as attributes, not classes.** A busy card gets `data-busy`, a failing
 *     poll gets `data-state="failing"`, a hidden panel gets the native `hidden`. The
 *     stylesheet keys off those, so it can be rewritten without JS agreeing to anything.
 */
import { icons } from "./icons.js";
import {
  actionErrors,
  cardIsProtected,
  copyConfirmActive,
  isBusy,
  state,
} from "./state.js";

/* ---------------------------------------------------------------------
 * Escaping
 * ------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function truncate(text, n) {
  if (!text) return "";
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

/* ---------------------------------------------------------------------
 * Header: connection pill, repo path, both project selectors
 * ------------------------------------------------------------------- */

function renderConnStatus() {
  const el = document.getElementById("conn-status");
  // `data-state`, not a class: the pill can be restyled or replaced outright and this
  // assignment still means the same thing.
  el.dataset.state = state.live ? "live" : "failing";
  document.getElementById("conn-status-text").textContent = state.live ? "live" : "poll failing";
}

export function renderProjectSelectors() {
  fillSelect(document.getElementById("project-select"), [
    { id: "", name: "All projects" },
    ...state.projects.map((p) => ({ id: p.id, name: p.name })),
  ], state.currentProjectId ?? "");

  fillSelect(document.getElementById("c-project"), state.projects.map((p) => ({ id: p.id, name: p.name })), null);

  const repoEl = document.getElementById("repo-path");
  const selected = state.projects.find((p) => p.id === state.currentProjectId);
  repoEl.innerHTML = selected
    ? `<span class="label">repo:</span>${escapeHtml(selected.repoPath)}`
    : `<span class="label">repo:</span><span class="placeholder">— select a project —</span>`;
}

/** Rebuild a <select>'s options without disturbing it while the user has it open/focused. */
function fillSelect(select, options, desiredValue) {
  if (document.activeElement === select) return; // don't yank a mid-choice select
  const prior = select.value;
  select.innerHTML = options
    .map((o) => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}</option>`)
    .join("");
  const target = desiredValue !== null ? desiredValue : prior;
  if (options.some((o) => o.id === target)) {
    select.value = target;
  } else if (options.length > 0) {
    select.value = options[0].id;
  }
}

/* ---------------------------------------------------------------------
 * Composer
 * ------------------------------------------------------------------- */

/** Field name as the server reports it -> the span that shows its error. */
const COMPOSER_ERROR_IDS = {
  title: "c-title-error",
  projectId: "c-project-error",
  description: "c-desc-error",
  form: "c-form-error",
};

export function clearComposerErrors() {
  for (const id of Object.values(COMPOSER_ERROR_IDS)) {
    document.getElementById(id).textContent = "";
  }
}

/** `field` is a server field name, or "form" for anything not attributable to one. */
export function showComposerError(field, message) {
  const id = COMPOSER_ERROR_IDS[field] ?? COMPOSER_ERROR_IDS.form;
  document.getElementById(id).textContent = message;
}

/** True if the named field has its own error span, so the caller can route the message. */
export function composerHasField(field) {
  return typeof field === "string" && Object.hasOwn(COMPOSER_ERROR_IDS, field);
}

export function readComposerDraft() {
  return {
    title: document.getElementById("c-title").value.trim(),
    description: document.getElementById("c-desc").value,
    projectId: document.getElementById("c-project").value,
  };
}

/** Clears the two free-text fields; the project select deliberately keeps its choice. */
export function clearComposerText() {
  document.getElementById("c-title").value = "";
  document.getElementById("c-desc").value = "";
}

export function setComposerSubmitting(submitting) {
  document.getElementById("c-submit").disabled = submitting;
}

/* ---------------------------------------------------------------------
 * Panels
 * ------------------------------------------------------------------- */

function renderUnowned() {
  const panel = document.getElementById("unowned-panel");
  const rows = state.ticketsData.unowned;
  panel.hidden = rows.length === 0;
  if (rows.length === 0) return;
  document.getElementById("unowned-rows").innerHTML = rows
    .map(
      (w) =>
        `<div class="unowned-row"><span class="branch">${escapeHtml(w.branch)}</span><span class="path">${escapeHtml(w.path)}</span></div>`,
    )
    .join("");
}

function renderBoardError() {
  const el = document.getElementById("board-error");
  el.hidden = !state.boardErrorMsg;
  el.textContent = state.boardErrorMsg ? `board fetch failed — ${state.boardErrorMsg}` : "";
}

/* ---------------------------------------------------------------------
 * Diagnostics
 * ------------------------------------------------------------------- */

const DIAG_FIELDS = [
  ["startAttempts", "agent.start attempts", (v) => v > 1],
  ["paneBusyRetries", "agent_pane_busy retries", (v) => v > 0],
  ["startReturnedStatus", "start returned status", (v) => v != null && v !== "idle"],
  ["startReturnedReady", "start returned ready", (v) => v !== true],
  ["startReturnedAfterMs", "start returned after", () => false],
  ["neededReadinessPoll", "needed readiness poll", (v) => v === true],
  ["readinessPolls", "readiness polls", (v) => v > 0],
  ["readyAfterMs", "ready after", () => false],
  ["promptAttempts", "agent.prompt attempts", (v) => v > 1],
  ["promptNotReadyRetries", "prompt not_ready retries", (v) => v > 0],
  ["reusedExistingAgent", "reused running agent", (v) => v === true],
];

function fmtDiagValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function diagBlock(diagnostics) {
  if (!diagnostics) return "";
  const rows = DIAG_FIELDS.map(([key, label, flagFn]) => {
    const raw = diagnostics[key];
    const suffix = key.endsWith("Ms") && typeof raw === "number" ? "ms" : "";
    // `data-flagged` rather than a class: "this value tripped a guard" is meaning, and the
    // stylesheet decides what meaning looks like.
    return `<tr><td>${escapeHtml(label)}</td><td${flagFn(raw) ? " data-flagged" : ""}>${escapeHtml(fmtDiagValue(raw))}${suffix}</td></tr>`;
  }).join("");
  const raced = Boolean(diagnostics.paneBusyRetries > 0 || diagnostics.neededReadinessPoll || diagnostics.promptNotReadyRetries > 0);
  return `
      <details class="diag">
        <summary>diagnostics ${raced ? '<span data-race-tag>· spawn race fired (guard worked, this is normal)</span>' : ""}</summary>
        <table>${rows}</table>
        <div class="diag-note">Highlighted values mean a retry guard caught a transient race (e.g. a freshly created pane not yet at its prompt) and recovered on its own — not a failure.</div>
      </details>`;
}

/* ---------------------------------------------------------------------
 * Card
 * ------------------------------------------------------------------- */

/**
 * `null` means no agent has ever run for this ticket. Herdr's `unknown` means an agent
 * IS present but could not be classified — which per memory/agent-status.md never proves anything and
 * must never be read as success. Rendering both as "UNKNOWN" conflates "not started"
 * with "running but unreadable", so they get different labels.
 */
function statusBadge(status) {
  if (!status) return `<span class="badge" data-status="none" title="no agent has run for this ticket">idle · not started</span>`;
  return `<span class="badge" data-status="${escapeAttr(status)}" ${
    status === "unknown"
      ? 'title="an agent is present but Herdr cannot classify it — this is NOT completion"'
      : ""
  }>${escapeHtml(status)}</span>`;
}

/** The badge `title`s are a card's only accessible handles, so they are content, not decoration. */
function badgeIcon(kind, title) {
  return `<span class="badge-icon" data-icon="${kind}" title="${escapeAttr(title)}">${icons[kind]}</span>`;
}

function buildCardBody(ticket) {
  const busy = isBusy(ticket);
  const badges = [statusBadge(ticket.agentStatus ?? null)];
  // A pane closing AFTER the turn finished no longer erases `finished` server-side, so `died`
  // on its own no longer means the run failed. The checkmark follows the completion; the cross
  // and the red border are reserved for a run that died without ever finishing.
  if (ticket.finished) badges.push(badgeIcon("finished", "finished"));
  if (ticket.died && !ticket.finished) badges.push(badgeIcon("died", "run died"));
  if (ticket.hasWorktree) badges.push(badgeIcon("worktree", "worktree exists"));

  const err = actionErrors.get(ticket.id);

  /*
   * One branch per status, never an `else`: Cancel, Remove worktree, Accept and Reject are
   * all scoped to one status each on the server — Cancel claims `in_progress → backlog`,
   * Accept and Reject both claim `in_review`, and each answers 409 from anywhere else — so
   * an `else` would put a button on a card whose status can't take it. Done is terminal and
   * matches no branch here, so it draws no run action at all. Edit, Delete and Steer below
   * are status-independent and still there.
   */
  const actions = [];
  if (ticket.status === "backlog") {
    actions.push(`<button class="primary" data-act="spawn" ${busy ? "disabled" : ""}>Start</button>`);
  } else if (ticket.status === "in_progress") {
    actions.push(`<button class="danger" data-act="cancel" ${busy ? "disabled" : ""} title="Discards the attempt: deletes the branch and worktree.">Cancel (discard)</button>`);
    if (ticket.hasWorktree) {
      actions.push(`<button data-act="drop-worktree" ${busy ? "disabled" : ""} title="Reclaims disk space. The branch and its commits are kept.">Remove worktree</button>`);
    }
  } else if (ticket.status === "in_review") {
    actions.push(`<button class="primary" data-act="accept" ${busy ? "disabled" : ""} title="Pushes the branch, opens a pull request, and retires the agent.">Accept</button>`);
    actions.push(`<button data-act="reject" ${busy ? "disabled" : ""} title="Sends your feedback back to the agent, which keeps working. Not destructive — the worktree, branch and agent all survive.">Reject</button>`);
  }
  actions.push(`<button class="ghost" data-act="edit" ${busy ? "disabled" : ""}>Edit</button>`);
  actions.push(`<button class="danger ghost" data-act="delete" ${busy ? "disabled" : ""}>Delete</button>`);
  const hasAttach = Boolean(ticket.agentName);
  actions.push(
    `<button class="icon-btn ghost" data-act="steer" ${busy ? "disabled" : ""} ` +
      `title="${hasAttach ? "Copy the terminal command to attach to this agent's pane, and pre-focus it in Herdr — steer it like a captain at the wheel." : "No agent attached yet."}">${icons.steer}</button>`,
  );

  if (state.editingId === ticket.id) {
    return `
        <div class="card-top">
          <span class="card-id">${escapeHtml(ticket.id)}</span>
        </div>
        <div class="edit-form">
          <input type="text" data-field="title" value="${escapeAttr(state.editBuffer.title)}" />
          <textarea data-field="description" rows="3">${escapeHtml(state.editBuffer.description)}</textarea>
          ${state.editFieldError ? `<div class="card-error">${escapeHtml(state.editFieldError)}</div>` : ""}
          <div class="row">
            <button class="primary" data-act="save-edit">Save</button>
            <button class="ghost" data-act="cancel-edit">Cancel</button>
          </div>
        </div>`;
  }

  return `
      <div class="card-top">
        <span class="card-id">${escapeHtml(ticket.id)}</span>
        <div class="card-badges">${badges.join("")}</div>
      </div>
      <div class="card-title">${escapeHtml(ticket.title)}</div>
      <div class="card-desc" title="${escapeAttr(ticket.description || "")}">${escapeHtml(truncate(ticket.description, 140))}</div>
      ${ticket.branch ? `<div class="card-meta"><span>branch: ${escapeHtml(ticket.branch)}</span></div>` : ""}
      ${
        ticket.status === "done" && ticket.prUrl
          ? `<div class="card-meta"><a href="${escapeAttr(ticket.prUrl)}" target="_blank" rel="noopener noreferrer">PR #${escapeHtml(String(ticket.prNumber))}</a></div>`
          : ""
      }
      ${
        ticket.died && !ticket.finished
          ? `<div class="died-note">Run died — the pane exited unexpectedly. This is NOT a finished ticket. The worktree was deliberately kept so you can inspect it before deciding what to do.</div>`
          : ""
      }
      ${busy ? `<div class="busy-hint">${icons.busy} operation in flight — actions disabled</div>` : ""}
      <div class="card-actions">${actions.join("")}</div>
      ${copyConfirmActive(ticket.id) ? `<div class="copy-confirm">copied — command ready to paste</div>` : ""}
      ${err ? `<div class="card-error">${escapeHtml(err)}</div>` : ""}
      ${diagBlock(ticket.diagnostics)}
    `;
}

/**
 * Run state as attributes. The card keeps a fixed `class="card"`, so the stylesheet owns
 * the look and this function owns only the facts.
 */
function applyCardState(el, ticket) {
  el.toggleAttribute("data-busy", isBusy(ticket));
  el.toggleAttribute("data-blocked", ticket.agentStatus === "blocked");
  el.toggleAttribute("data-died", Boolean(ticket.died) && !ticket.finished);
}

/**
 * `data-act` is forwarded verbatim; this file has no idea what "spawn" does. The captured
 * `ticket` travels with it so the handler can fall back to it if the id has since left the
 * board.
 */
function attachCardHandlers(el, ticket, handlers) {
  el.querySelectorAll("button[data-act]").forEach((btn) => {
    const act = btn.getAttribute("data-act");
    btn.addEventListener("click", () => handlers.onCardAction(act, ticket));
  });
  if (state.editingId === ticket.id) {
    el.querySelector('[data-field="title"]')
      .addEventListener("input", (e) => handlers.onEditInput("title", e.target.value));
    el.querySelector('[data-field="description"]')
      .addEventListener("input", (e) => handlers.onEditInput("description", e.target.value));
  }
}

/** Element per ticket id, for in-place reconciliation. */
const cardEls = new Map();

function paintCard(el, ticket, handlers) {
  applyCardState(el, ticket);
  el.innerHTML = buildCardBody(ticket);
  attachCardHandlers(el, ticket, handlers);
}

/** Re-render exactly one card in place, used after actions/edits without touching the rest of the board. */
export function renderCard(ticket, handlers) {
  const el = cardEls.get(ticket.id);
  if (!el) return;
  paintCard(el, ticket, handlers);
}

/* ---------------------------------------------------------------------
 * Board reconciliation — keyed diff so a card mid-edit or a control the
 * user is focused on is never destroyed by a poll landing underneath it.
 * ------------------------------------------------------------------- */

function renderColumn(containerId, countId, status, handlers) {
  const container = document.getElementById(containerId);
  const rows = state.ticketsData.tickets.filter((t) => t.status === status);
  document.getElementById(countId).textContent = String(rows.length);

  const seen = new Set();
  let cursor = container.firstElementChild;

  for (const ticket of rows) {
    seen.add(ticket.id);
    let el = cardEls.get(ticket.id);
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      cardEls.set(ticket.id, el);
      el.dataset.id = ticket.id;
      el.className = "card";
      // A card is an `article` named by its ticket id: the only accessible handle it has,
      // and the reason the e2e suite no longer needs to reach through the DOM structure.
      el.setAttribute("role", "article");
      el.setAttribute("aria-label", ticket.id);
    }

    // Position it correctly.
    if (cursor !== el) {
      container.insertBefore(el, cursor);
    }
    cursor = el.nextElementSibling;

    if (cardIsProtected(ticket.id)) {
      // Leave an actively-edited or focused-input card alone this cycle.
      if (!el.dataset.rendered) {
        paintCard(el, ticket, handlers);
        el.dataset.rendered = "1";
      }
      continue;
    }

    paintCard(el, ticket, handlers);
    el.dataset.rendered = "1";
  }

  // Remove cards no longer present.
  for (const [id, el] of cardEls) {
    if (!seen.has(id) && el.parentElement === container) {
      el.remove();
      cardEls.delete(id);
    }
  }

  // `data-empty` is the hook, `.empty-hint` is only the styling: the placeholder can be
  // restyled or reworded without this lookup losing the element it has to remove.
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-hint" data-empty>empty</div>`;
  } else {
    container.querySelector("[data-empty]")?.remove();
  }
}

export function renderBoard(handlers) {
  renderConnStatus();
  renderBoardError();
  renderUnowned();
  renderColumn("backlog-cards", "backlog-count", "backlog", handlers);
  renderColumn("in-progress-cards", "in-progress-count", "in_progress", handlers);
  renderColumn("in-review-cards", "in-review-count", "in_review", handlers);
  renderColumn("done-cards", "done-count", "done", handlers);
}

/* ---------------------------------------------------------------------
 * Static controls. The elements are found here; what they mean is decided
 * in app.js.
 * ------------------------------------------------------------------- */

export function bindControls(handlers) {
  document.getElementById("project-select").addEventListener("change", (e) => {
    handlers.onProjectChange(e.target.value);
  });
  document.getElementById("composer-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handlers.onComposerSubmit();
  });
}
