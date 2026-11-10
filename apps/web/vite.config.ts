import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `ghost serve` (default :8788) holds every key; the browser only ever talks to /api.
const api = `http://127.0.0.1:${process.env.GHOST_SERVE_PORT ?? 8788}`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: false } } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 700 },
});
