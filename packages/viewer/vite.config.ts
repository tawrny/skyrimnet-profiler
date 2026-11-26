import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The relay's read-only API listens on 8091 (packages/relay/src/api.ts); the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": "http://127.0.0.1:8091" },
  },
});
