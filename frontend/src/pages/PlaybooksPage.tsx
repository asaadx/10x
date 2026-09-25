/**
 * Placeholder for `/playbooks` — the design is fully worked out in
 * `docs/playbooks-and-dashboard.md` (YAML files under `$STATE_DIR/playbooks`, a list view, a
 * split YAML/form editor) but none of it is built yet. This route exists so the nav
 * destination and the production static-route fallback have somewhere real to land; building
 * the page is a separate, larger ticket.
 */
export function PlaybooksPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">Playbooks is not built yet.</p>
    </main>
  );
}
