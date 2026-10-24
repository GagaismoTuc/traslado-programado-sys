import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Same-origin API under /api, used by the C3 browser tests through VITE_API_URL=/api.
  server: {
    proxy: {
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3000", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
});
