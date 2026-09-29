import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { NavBar } from "@/components/NavBar.tsx";
import { ALL_PROJECTS } from "@/lib/board.ts";
import { BoardPage } from "@/pages/BoardPage.tsx";
import { DashboardPage } from "@/pages/DashboardPage.tsx";
import { ListPage } from "@/pages/ListPage.tsx";
import { PlaybooksPage } from "@/pages/PlaybooksPage.tsx";
import { initialSteerMode, storeSteerMode, type SteerMode } from "@/lib/steer-mode.ts";
import { useTheme } from "@/lib/theme.ts";
import { useBoard } from "@/lib/use-board.ts";

/**
 * The router shell. `NavBar` is the one piece of chrome every route shares, so it lives here
 * rather than inside `BoardPage` — that is also why `theme`, `steerMode` and the selected
 * `projectId` (and the single `useBoard` poll it drives) are owned here instead of by the
 * board: the nav's project picker and theme toggle have to work identically regardless of
 * which route is active, and `BoardPage` needs the same `projectId` to filter its columns.
 *
 * `/` redirects to `/board`. `/list` is the same tickets as a sortable, filterable table, fed by
 * the same `useBoard` read. `/dashboard` and `/playbooks` are placeholders (see their own files)
 * until the pages described in `docs/playbooks-and-dashboard.md` are built.
 */
export function App() {
  const { theme, toggleTheme } = useTheme();
  const [steerMode, setSteerMode] = useState<SteerMode>(() => initialSteerMode());
  // Seeded from the sentinel, not from a project: projects arrive asynchronously and the list
  // may legitimately be empty, so this is the only value that is valid before the first read.
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS);

  useEffect(() => storeSteerMode(steerMode), [steerMode]);

  const { tickets, projects, error, refresh } = useBoard(projectId);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <NavBar
        projects={projects}
        projectId={projectId}
        onProjectChange={setProjectId}
        steerMode={steerMode}
        onSteerModeChange={setSteerMode}
        theme={theme}
        onThemeToggle={toggleTheme}
      />
      <Routes>
        <Route path="/" element={<Navigate to="/board" replace />} />
        <Route
          path="/board"
          element={
            <BoardPage
              projectId={projectId}
              tickets={tickets}
              projects={projects}
              error={error}
              refresh={refresh}
              steerMode={steerMode}
            />
          }
        />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/playbooks" element={<PlaybooksPage />} />
        <Route
          path="/list"
          element={
            <ListPage projectId={projectId} tickets={tickets} projects={projects} error={error} refresh={refresh} />
          }
        />
      </Routes>
    </div>
  );
}
