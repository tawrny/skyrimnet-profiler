import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The profiler API listens on 8095 (packages/api); the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": "http://127.0.0.1:8095" },
  },
});
