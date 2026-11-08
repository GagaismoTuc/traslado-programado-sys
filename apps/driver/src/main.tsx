import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDriverErrorTracking } from "./error-tracking";

const errorTracker = initDriverErrorTracking();

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => errorTracker.captureError(error),
  onCaughtError: (error) => errorTracker.captureError(error),
}).render(<StrictMode><App /></StrictMode>);

// sw.js is written by the build (see vite.config.ts), so the service worker exists only in production builds.
if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
