import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
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
