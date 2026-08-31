/**
 * Transport. Every HTTP call the board makes, and the one place a non-2xx is turned
 * into a message.
 *
 * No DOM in this file, by construction: it must stay possible to change the wire
 * format without opening render.js, and to redesign the board without opening this.
 */

/**
 * The single fetch wrapper. Never throws and never swallows: a network failure and a
 * 500 both come back as `{ok: false, status, body}` so the caller has exactly one
 * shape to handle.
 */
async function api(path, options) {
  try {
    const res = await fetch(path, options);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null; // empty or non-JSON body is fine for e.g. a bare 404
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: "network_error", message: String(err) } };
  }
}

/** The server's uniform `{error, message?}` envelope, rendered as one line of prose. */
export function messageFor(body, status) {
  if (body && typeof body.error === "string") {
    return body.message ? `${body.error}: ${body.message}` : body.error;
  }
  return `request failed (HTTP ${status})`;
}

const JSON_HEADERS = { "content-type": "application/json" };

/** Ticket ids come from the server but are still ours to escape — they reach a URL path. */
function ticketPath(id, suffix = "") {
  return `/tickets/${encodeURIComponent(id)}${suffix}`;
}

export function fetchProjects() {
  return api("/projects");
}

/** `projectId` null means "all projects", which is the query parameter simply being absent. */
export function fetchBoard(projectId) {
  const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return api(`/tickets${qs}`);
}

export function postTicket(draft) {
  return api("/tickets", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(draft) });
}

export function patchTicket(id, fields) {
  return api(ticketPath(id), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(fields) });
}

export function deleteTicket(id) {
  return api(ticketPath(id), { method: "DELETE" });
}

export function postSpawn(id) {
  return api(ticketPath(id, "/spawn"), { method: "POST" });
}

export function postCancel(id) {
  return api(ticketPath(id, "/cancel"), { method: "POST" });
}

export function postAccept(id) {
  return api(ticketPath(id, "/accept"), { method: "POST" });
}

export function deleteWorktree(id) {
  return api(ticketPath(id, "/worktree"), { method: "DELETE" });
}

export function postFocus(id) {
  return api(ticketPath(id, "/focus"), { method: "POST" });
}
