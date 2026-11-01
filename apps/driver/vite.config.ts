import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildVersion, precacheList, serviceWorkerSource } from "./src/service-worker";

// Writes sw.js at build time with the exact list of built files, so the service worker precaches only the app.
function serviceWorker(): Plugin {
  return {
    name: "driver-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).sort();
      const contents = names.map((name) => {
        const output = bundle[name];
        return output.type === "chunk" ? output.code : String(output.source);
      });
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource(precacheList(names), buildVersion([...names, ...contents])) });
    },
  };
}

export default defineConfig({ plugins: [react(), serviceWorker()] });
