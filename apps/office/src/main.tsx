import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initOfficeErrorTracking } from "./error-tracking";

const errorTracker = initOfficeErrorTracking();

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => errorTracker.captureError(error),
  onCaughtError: (error) => errorTracker.captureError(error),
}).render(<StrictMode><App /></StrictMode>);
