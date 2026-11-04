import {
  BrowserClient, breadcrumbsIntegration, dedupeIntegration, defaultStackParser, eventFiltersIntegration,
  getCurrentScope, globalHandlersIntegration, linkedErrorsIntegration, makeFetchTransport, Scope, setCurrentClient,
  type Breadcrumb,
} from "@sentry/browser";
import { scrubBreadcrumb, scrubErrorEvent } from "@traslado/shared";

export type DriverErrorTrackerOptions = {
  dsn?: string;
  environment?: string;
  fetchImpl?: typeof fetch;
  installGlobalHandlers?: boolean;
};

export function createDriverErrorTracker(options: DriverErrorTrackerOptions = {}) {
  const dsn = options.dsn?.trim();
  if (!dsn) {
    return { addBreadcrumb: (_b: Breadcrumb) => undefined, captureError: (_e: unknown, _x?: Record<string, unknown>) => undefined, flush: async () => true };
  }
  const client = new BrowserClient({
    dsn,
    environment: options.environment ?? "production",
    tracesSampleRate: 0,
    stackParser: defaultStackParser,
    integrations: [
      eventFiltersIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      ...(options.installGlobalHandlers
        ? [breadcrumbsIntegration({ dom: false, fetch: true, history: true, sentry: false, xhr: true }), globalHandlersIntegration({ onerror: true, onunhandledrejection: true })]
        : []),
    ],
    transport: (transportOptions) => makeFetchTransport(transportOptions, options.fetchImpl),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSend: (event) => scrubErrorEvent(event),
  });

  const scope = new Scope();
  scope.setTag("app", "driver");
  scope.setClient(client);
  if (options.installGlobalHandlers) {
    setCurrentClient(client);
    getCurrentScope().setTag("app", "driver");
  }
  client.init();

  return {
    addBreadcrumb: (breadcrumb: Breadcrumb) => {
      const cleaned = scrubBreadcrumb(breadcrumb);
      if (cleaned) scope.addBreadcrumb(cleaned);
    },
    captureError: (error: unknown, extras?: Record<string, unknown>) => {
      scope.captureException(error, extras ? { captureContext: { extra: extras } } : undefined);
    },
    flush: async (timeoutMs = 2000) => await client.flush(timeoutMs),
  };
}

export function initDriverErrorTracking() {
  return createDriverErrorTracker({ dsn: import.meta.env.VITE_GLITCHTIP_DSN, environment: import.meta.env.MODE, installGlobalHandlers: true });
}
