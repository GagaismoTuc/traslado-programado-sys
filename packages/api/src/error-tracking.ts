import {
  createTransport, dedupeIntegration, defaultStackParser, eventFiltersIntegration, getCurrentScope,
  linkedErrorsIntegration, makeNodeTransport, NodeClient, onUncaughtExceptionIntegration,
  onUnhandledRejectionIntegration, Scope, setCurrentClient,
} from "@sentry/node";
import { scrubBreadcrumb, scrubErrorEvent, stripUrlQueryAndFragment } from "@traslado/shared";

export type ApiRequestMetadata = { method: string; url: string; headers: Record<string, string> };

export type ApiErrorTrackerOptions = {
  dsn?: string | null;
  environment?: string;
  serverEpoch?: string;
  installProcessHandlers?: boolean;
  sendEnvelope?: (payload: string) => Promise<{ statusCode?: number }>;
};

export function createApiErrorTracker(options: ApiErrorTrackerOptions = {}) {
  const dsn = options.dsn?.trim();
  if (!dsn) {
    return {
      captureRequestError: (_error: unknown, _request: ApiRequestMetadata) => undefined,
      flush: async () => true,
      close: async () => true,
    };
  }

  const client = new NodeClient({
    dsn,
    environment: options.environment ?? "production",
    tracesSampleRate: 0,
    sendClientReports: false,
    stackParser: defaultStackParser,
    integrations: [
      eventFiltersIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      ...(options.installProcessHandlers
        ? [onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: true }), onUnhandledRejectionIntegration({ mode: "warn" })]
        : []),
    ],
    transport: options.sendEnvelope
      ? (transportOptions) =>
          createTransport(transportOptions, async ({ body }) => {
            const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
            return await options.sendEnvelope!(text);
          })
      : makeNodeTransport,
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSend: (event) => scrubErrorEvent(event),
  });

  const scope = new Scope();
  scope.setTag("app", "api");
  if (options.serverEpoch) scope.setTag("server_epoch", options.serverEpoch);
  scope.setClient(client);
  if (options.installProcessHandlers) {
    setCurrentClient(client);
    getCurrentScope().setTag("app", "api");
    if (options.serverEpoch) getCurrentScope().setTag("server_epoch", options.serverEpoch);
  }
  client.init();

  return {
    captureRequestError: (error: unknown, request: ApiRequestMetadata) => {
      const requestScope = scope.clone();
      requestScope.addEventProcessor((event) => ({
        ...event,
        request: { method: request.method, url: stripUrlQueryAndFragment(request.url), headers: request.headers },
      }));
      requestScope.captureException(error);
    },
    flush: async (timeoutMs = 2000) => await client.flush(timeoutMs),
    close: async (timeoutMs = 2000) => await client.close(timeoutMs),
  };
}
