import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `ghost serve` (default :8788) holds every key; the browser only ever talks to /api.
const api = `http://127.0.0.1:${process.env.GHOST_SERVE_PORT ?? 8788}`;

export default defineConfig({
  plugins: [react()],
  // The SDK's derive.ts needs 3 functions from chainsig.js; the package itself is ~7 MB of wallets.
  resolve: {
    alias: {
      "chainsig.js": fileURLToPath(
        new URL("../../packages/sdk/src/chainsig-lite.ts", import.meta.url),
      ),
    },
  },
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: false } } },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // index.html: the recipient's app (talks to `ghost serve`). pay.html: the payer's page, static,
    // no server and no keys (the payer's wallet signs); host it anywhere (docs/HOSTING.md).
    // receive.html: the recipient's setup guide, static too; it reads the registry and holds no keys.
    rollupOptions: { input: { main: "index.html", pay: "pay.html", receive: "receive.html" } },
  },
});
