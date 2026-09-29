import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // One .env for the whole repo, at the root, so the backend (which loads it itself, in
  // `backend/src/env.ts`) and Vite read the same file. Without this, `envDir` defaults to
  // the Vite root (this directory) and the client half drifts into a second file.
  //
  // Safe despite GITHUB_TOKEN living in that file: Vite exposes only VITE_-prefixed
  // variables to client code, and inlines only those into the bundle. Everything else in
  // .env is loaded into the config process and dropped.
  //
  // The corollary, and the reason this is worth a comment: that guarantee is the prefix
  // filter, nothing more. Widening `envPrefix`, or defining `process.env` wholesale through
  // `define`, would ship the token. Neither is done here, and neither should be.
  envDir: path.resolve(import.meta.dirname, ".."),
  server: {
    port: 5173,
    // The board owns the API. Proxying rather than hardcoding an origin keeps the app
    // same-origin in dev exactly as it is in production, so no CORS handling is needed
    // in a zero-dependency server that has none today.
    proxy: {
      "/tickets": "http://127.0.0.1:4010",
      "/projects": "http://127.0.0.1:4010",
      "/webhooks": "http://127.0.0.1:4010",
    },
  },
  build: {
    // Served by the backend's static handler, whose allow-list is .html/.css/.js/.svg.
    // Keeping the default asset layout means nothing needs adding to that list.
    outDir: "dist",
    emptyOutDir: true,
  },
});
