export const REDACTED = "[REDACTED]";

export type ScrubbableBreadcrumb = {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type ScrubbableErrorEvent = {
  message?: string;
  transaction?: string;
  logentry?: { message?: string; formatted?: string; params?: unknown[] };
  server_name?: string;
  user?: Record<string, unknown>;
  request?: {
    url?: string;
    method?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { type?: string; handled?: boolean; synthetic?: boolean; data?: Record<string, unknown> };
      stacktrace?: {
        frames?: Array<{
          filename?: string;
          abs_path?: string;
          function?: string;
          lineno?: number;
          colno?: number;
          in_app?: boolean;
          vars?: Record<string, unknown>;
        }>;
      };
    }>;
  };
  breadcrumbs?: ScrubbableBreadcrumb[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  tags?: Record<string, unknown>;
  fingerprint?: string[];
  threads?: {
    values?: Array<{
      id?: number | string;
      name?: string;
      crashed?: boolean;
      current?: boolean;
      stacktrace?: {
        frames?: Array<{
          filename?: string;
          abs_path?: string;
          function?: string;
          lineno?: number;
          colno?: number;
          in_app?: boolean;
          vars?: Record<string, unknown>;
        }>;
      };
    }>;
  };
};

const SAFE_KEYS = new Set(["filename", "abspath", "dirname", "basename", "pathname", "typename", "function"]);
const URL_DATA_KEYS = new Set(["url", "from", "to"]);
const SAFE_HTTP_METHOD_RE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
const SAFE_URL_SEGMENT_RE = /^(?:[A-Za-z0-9._~-]|\[REDACTED\]|;){1,128}$/;
const NUMERIC_VERSION_RE = /^v?\d+(?:\.\d+){0,3}$/;
const HEX_16_RE = /^[0-9a-f]{16}$/i;
const HEX_32_RE = /^[0-9a-f]{32}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_SERVER_EPOCH_RE = /^(?:(?=[0-9a-f]*[a-f])[0-9a-f]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|epoch-\d{1,6}|c3-e2e-[0-9a-f]{4,16})$/i;
const SAFE_SENTRY_PACKAGE_RE = /^npm:@sentry\/[a-z0-9-]+$/;

const SAFE_HEADER_KEYS = new Set(["content-type", "content-length", "accept", "x-server-epoch"]);
const SAFE_MIME_TYPES = new Set([
  "application/json",
  "application/x-www-form-urlencoded",
  "application/octet-stream",
  "application/problem+json",
  "application/x-sentry-envelope",
  "multipart/form-data",
  "text/plain",
  "text/html",
  "text/csv",
  "text/event-stream",
  "*/*",
]);
const SAFE_MIME_CHARSETS = new Set(["utf-8", "utf8", "iso-8859-1", "us-ascii"]);

const KNOWN_APP_NAMES = new Set(["api", "office", "driver", "traslado-api", "traslado-office", "traslado-driver"]);
const KNOWN_ENVIRONMENTS = new Set(["production", "staging", "development", "test", "local", "preview"]);
const KNOWN_LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const KNOWN_PLATFORMS = new Set(["node", "javascript", "other"]);
const KNOWN_EVENT_TYPES = new Set(["error", "transaction", "event", "default"]);
const KNOWN_BOOLEAN_STRINGS = new Set(["yes", "no", "true", "false"]);
const KNOWN_ALERT_TAGS = new Set(["disk_usage", "disk_usage_high"]);
const KNOWN_MECHANISM_TYPES = new Set([
  "generic",
  "onerror",
  "onunhandledrejection",
  "onuncaughtexception",
  "instrument",
  "middleware",
  "http",
  "fetch",
  "xhr",
  "chained",
  "auto.http",
  "auto.browser",
  "auto.http.node.http",
  "auto.http.browser.fetch",
  "auto.http.browser.xhr",
  "auto.ui.browser",
]);
const KNOWN_EXCEPTION_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "TimeoutError",
  "DatabaseError",
  "error",
  "HTTPException",
  "HttpError",
  "ZodError",
  "FetchError",
  "NetworkError",
  "SecurityError",
  "QuotaExceededError",
  "NotAllowedError",
  "SystemError",
  "AssertionError",
  "InternalError",
  "InvalidReferenceError",
  "PlanningError",
  "RoutingEngineError",
]);
const KNOWN_BREADCRUMB_CATEGORIES = new Set([
  "fetch",
  "xhr",
  "http",
  "navigation",
  "console",
  "ui.click",
  "sentry.event",
  "sentry.transaction",
  "error",
  "exception",
  "log",
  "info",
  "debug",
  "query",
  "default",
]);
const KNOWN_BREADCRUMB_TYPES = new Set([
  "default",
  "debug",
  "error",
  "navigation",
  "http",
  "info",
  "query",
  "transaction",
  "ui",
]);
const KNOWN_RUNTIME_NAMES = new Set([
  "node",
  "browser",
  "v8",
  "deno",
  "bun",
  "cloudflare-workers",
  "edge-light",
  "workerd",
  "javascript",
]);
const KNOWN_OS_NAMES = new Set([
  "linux",
  "windows",
  "macos",
  "mac os x",
  "darwin",
  "android",
  "ios",
  "ipados",
  "chrome os",
  "chromeos",
  "ubuntu",
  "debian",
  "alpine",
  "centos",
  "fedora",
  "redhat",
  "freebsd",
  "openbsd",
]);
const KNOWN_BROWSER_NAMES = new Set([
  "chrome",
  "chromium",
  "chrome mobile",
  "chrome mobile webview",
  "firefox",
  "firefox mobile",
  "safari",
  "mobile safari",
  "edge",
  "edge mobile",
  "opera",
  "opera mobile",
  "samsung internet",
  "webkit",
  "brave",
  "vivaldi",
]);
const KNOWN_TRACE_OPS = new Set([
  "default",
  "http.server",
  "http.client",
  "pageload",
  "navigation",
  "ui.action",
  "ui.action.click",
  "db",
  "db.query",
  "db.sql.query",
  "function",
  "middleware",
  "resource",
]);
const KNOWN_SDK_NAMES = new Set(["sentry.javascript.node", "sentry.javascript.browser"]);
const KNOWN_SDK_INTEGRATIONS = new Set([
  "InboundFilters",
  "FunctionToString",
  "LinkedErrors",
  "Dedupe",
  "EventFilters",
  "Breadcrumbs",
  "GlobalHandlers",
  "OnUncaughtException",
  "OnUnhandledRejection",
  "Http",
  "Console",
  "ContextLines",
  "LocalVariables",
  "Modules",
  "Context",
  "RequestData",
  "NodeFetch",
  "BrowserApiErrors",
  "TryCatch",
]);

const SAFE_TAG_VALIDATORS: Record<string, (value: string) => boolean> = {
  app: (value) => KNOWN_APP_NAMES.has(value.toLowerCase()),
  server_epoch: (value) => isSafeServerEpoch(value),
  environment: (value) => KNOWN_ENVIRONMENTS.has(value.toLowerCase()),
  handled: (value) => KNOWN_BOOLEAN_STRINGS.has(value.toLowerCase()),
  level: (value) => KNOWN_LEVELS.has(value.toLowerCase()),
  mechanism: (value) => KNOWN_MECHANISM_TYPES.has(value.toLowerCase()),
  alert: (value) => KNOWN_ALERT_TAGS.has(value.toLowerCase()),
};

const SAFE_CONTEXT_VALIDATORS: Record<string, Record<string, (value: string) => boolean>> = {
  runtime: {
    name: (value) => KNOWN_RUNTIME_NAMES.has(value.toLowerCase()),
    version: (value) => NUMERIC_VERSION_RE.test(value),
  },
  os: {
    name: (value) => KNOWN_OS_NAMES.has(value.toLowerCase()),
    version: (value) => NUMERIC_VERSION_RE.test(value),
  },
  browser: {
    name: (value) => KNOWN_BROWSER_NAMES.has(value.toLowerCase()),
    version: (value) => NUMERIC_VERSION_RE.test(value),
  },
  trace: {
    trace_id: (value) => HEX_32_RE.test(value),
    span_id: (value) => HEX_16_RE.test(value),
    parent_span_id: (value) => HEX_16_RE.test(value),
    op: (value) => KNOWN_TRACE_OPS.has(value.toLowerCase()),
  },
  app: {
    app_name: (value) => KNOWN_APP_NAMES.has(value.toLowerCase()),
    app_version: (value) => NUMERIC_VERSION_RE.test(value),
  },
};

const HANDLED_EVENT_KEYS = new Set([
  "event_id", "timestamp", "platform", "level", "environment", "sdk", "modules",
  "type", "debug_meta", "user", "server_name", "message", "transaction", "logentry", "request", "exception",
  "breadcrumbs", "extra", "contexts", "tags", "fingerprint", "threads",
]);

const SENSITIVE_KEYS = new Set([
  "name", "fullname", "firstname", "lastname", "passengername", "drivername", "adultname", "guardianname", "receivername",
  "actorlabel", "username", "displayname", "address", "homeaddress", "baseaddress", "street", "streetname", "accessnotes",
  "medicalalert", "alert", "wheelchair", "frontseat", "companions", "requiredfeatures", "adaptacionesrequeridas", "featureids",
  "diagnosis", "sex", "gender", "reason", "overridereason", "before", "after", "beforedata", "afterdata", "dni", "receiverdni",
  "documento", "phone", "calledphone", "telefono", "email", "body", "requestbody", "responsebody", "query", "querystring",
  "search", "params", "parameters", "args", "arguments", "bind", "variables", "input", "cookie", "cookies", "setcookie",
  "authorization", "proxyauthorization", "auth", "token", "tokenhash", "session", "sessiontoken", "rememberdevice", "secret",
  "totp", "totpsecret", "password", "passwordhash", "code", "recoverycode", "apikey", "xapikey", "xauthtoken", "xcsrftoken",
  "xforwardedfor", "forwarded", "trueclientip", "xclientip", "xrealip", "cfconnectingip", "ip", "ipaddress", "clientip", "lat", "lng", "lon", "latitude", "longitude",
  "homelat", "homelng", "homelatitude", "homelongitude", "startlat", "startlng", "startlatitude", "startlongitude", "endlat",
  "endlng", "coords", "coordinates", "location", "position", "pickup", "dropoff", "point", "points", "geo",
  "waypoint", "waypoints", "label", "residence",
]);

const SENSITIVE_SUFFIXES = [
  "address", "dni", "phone", "latitude", "longitude", "homelat", "homelng", "token", "secret", "password", "cookie",
];

// Exact complete safe messages only: no prefix/suffix wildcards that could admit untrusted free text.
const SAFE_EXACT_MESSAGES = new Set([
  "browser sdk smoke event",
  "offline mark error",
  "routing error",
  "database unavailable",
  "unexpected failure",
  "osrm is down",
  "vroom did not answer",
  "failed to fetch",
  "load failed",
  "networkerror when attempting to fetch resource.",
  "database transactions are required for account writes",
  "no router configured",
  "health check timed out",
  "unknown vehicle feature",
  "invalid usual vehicle",
  "plan diario not found",
  "recorrido not found",
  "versión del plan not found",
  "traslado not found in this versión del plan",
  "marca not found on this traslado",
  "invalid request",
  "a recorrido en curso or cerrado cannot change chofer",
  "this chofer is deactivated: choose another one",
  "this recorrido has no previous recorrido with paradas to start from",
  "set where this recorrido starts: the previous recorrido has another vehículo or no paradas",
  "this marca belongs to another chofer",
  "a recorrido without paradas cannot be published",
  "address search is unavailable",
  "nominatim timed out",
  "nominatim answered an unexpected result",
  "server_epoch is required",
  "database_url must be a valid url",
  "osrm_url must be a valid url",
  "vroom_url must be a valid url",
  "nominatim_url must be a valid url",
  "glitchtip_dsn must be a valid url",
  "auth_allowed_origins must be a comma-separated list of origins",
  "speed_factors must be a comma-separated list of hh:mm=factor with factors above 0 and up to 5",
  "base_address must be at most 500 characters",
  "migration_database_url is required",
  "usage: db:bootstrap-office <username>",
  "usage: db:break-glass-office <username>",
  "username is required",
  "bootstrap_office_password is required",
  "break_glass_office_password is required",
  "an office account already exists",
]);

// Tightly anchored structural patterns admitting only bounded numeric codes or exact known system mount points.
const NOMINATIM_STATUS_RE = /^Nominatim answered \d{3}$/;
const DISK_ALERT_RE = /^Disk usage high: \d{1,3}% on (\/[A-Za-z0-9._/-]*) \(threshold \d{1,3}%\)$/;
const SAFE_DISK_MOUNTS = new Set([
  "/",
  "/var",
  "/var/lib",
  "/var/lib/docker",
  "/var/lib/postgresql",
  "/var/log",
  "/data",
  "/srv",
  "/opt",
  "/tmp",
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  if (SAFE_KEYS.has(normalized)) return false;
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function hasNumericPii(value: string): boolean {
  return /(?<!\w)\+\d[\d\s().-]{7,}\d(?!\w)/.test(value)
    || /(?<![0-9a-zA-Z])\d{10}(?![0-9a-zA-Z])/.test(value)
    || /-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/.test(value)
    || /(?<![0-9a-zA-Z.])\d{1,2}\.\d{3}\.\d{3}(?![0-9a-zA-Z.])/.test(value)
    || /(?<![0-9a-zA-Z.-])\d{7,8}(?![0-9a-zA-Z.-])/.test(value)
    || /(?<![0-9a-zA-Z])-\d{6,8}(?![0-9a-zA-Z])/.test(value);
}

function isSensitiveNumber(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (!Number.isInteger(value)) return true;
  if (Math.abs(value) >= 1_000_000) return true;
  if (value <= -100_000) return true;
  return false;
}

function isCoordinatePair(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [a, b] = value;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0) return false;
  return Math.abs(a) <= 180 && Math.abs(b) <= 180 && (Math.abs(a) <= 90 || Math.abs(b) <= 90);
}

function isSafeServerEpoch(value: string): boolean {
  return SAFE_SERVER_EPOCH_RE.test(value) && !hasNumericPii(value);
}

function isSafeTimestamp(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return ISO_TIMESTAMP_RE.test(value.trim());
  return false;
}

function isSafeMimeHeader(value: string): boolean {
  const parts = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const [rawType, ...params] = part.split(";").map((segment) => segment.trim());
    if (!rawType || !SAFE_MIME_TYPES.has(rawType.toLowerCase())) return false;
    for (const param of params) {
      if (!param) return false;
      const eqIndex = param.indexOf("=");
      if (eqIndex <= 0) return false;
      const key = param.slice(0, eqIndex).trim().toLowerCase();
      const val = param.slice(eqIndex + 1).trim().toLowerCase();
      if (key === "charset") {
        if (!SAFE_MIME_CHARSETS.has(val)) return false;
      } else if (key === "q") {
        if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(val)) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

export function stripUrlQueryAndFragment(url: string): string {
  return url
    .replace(/([?#]).*$/, "")
    .replace(/([/;])-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?/g, `$1${REDACTED}`);
}

function scrubPathSegments(pathname: string): string {
  if (!pathname) return "";
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return "";
      if (SAFE_URL_SEGMENT_RE.test(segment) && !hasNumericPii(segment)) return segment;
      return REDACTED;
    })
    .join("/");
}

function scrubRequestUrl(url: string): string {
  const stripped = stripUrlQueryAndFragment(url.trim());
  const httpMatch = /^(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)(\/.*)?$/i.exec(stripped);
  if (httpMatch) {
    const [, origin, path = ""] = httpMatch;
    return `${origin}${scrubPathSegments(path)}`;
  }
  if (stripped.startsWith("/")) {
    return scrubPathSegments(stripped);
  }
  return REDACTED;
}

function scrubTransaction(transaction: string): string {
  const trimmed = transaction.trim();
  const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(trimmed);
  if (methodMatch) {
    const [, method, target] = methodMatch;
    return `${method!.toUpperCase()} ${scrubRequestUrl(target!)}`;
  }
  if (trimmed.startsWith("/") || /^https?:\/\//i.test(trimmed)) {
    return scrubRequestUrl(trimmed);
  }
  return REDACTED;
}

export function isWhitelistedMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (SAFE_EXACT_MESSAGES.has(trimmed.toLowerCase()) || NOMINATIM_STATUS_RE.test(trimmed)) return true;
  const diskMatch = DISK_ALERT_RE.exec(trimmed);
  return Boolean(diskMatch && SAFE_DISK_MOUNTS.has(diskMatch[1]!));
}

export function scrubMessage(message: string | undefined): string | undefined {
  if (message === undefined || message === null) return message;
  if (message === "") return "";
  return isWhitelistedMessage(message) ? message.trim() : REDACTED;
}

export function scrubString(input: string): string {
  return input
    .replace(/otpauth:\/\/[^\s"']+/gi, REDACTED)
    .replace(/https?:\/\/[^\s"']+/gi, (match) => stripUrlQueryAndFragment(match))
    .replace(/(^|[\s"'(])(\/[A-Za-z0-9._~/%-;,-]*)[?#][^\s"')]+/g, (_, prefix: string, path: string) => `${prefix}${stripUrlQueryAndFragment(path)}`)
    .replace(/Key\s*\([^)]+\)=\([^)]*\)/gi, `Key (${REDACTED})=(${REDACTED})`)
    .replace(/Failing row contains\s*\([^)]*\)/gi, `Failing row contains (${REDACTED})`)
    .replace(/(invalid input (?:syntax|value)(?:\s+for\s+type|\s+for\s+enum|\s+for)?\s*[^:]*:\s*)("[^"]*"|'[^']*'|[^,\n\r]+)/gi, `$1"${REDACTED}"`)
    .replace(/"([a-zA-Z0-9_-]+)"\s*:\s*("[^"\\]*(?:\\.[^"\\]*)*"|-?\d+(?:\.\d+)?|true|false|null|\[\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+\s*\])/g, (full, key: string) =>
      isSensitiveKey(key) ? `"${key}":"${REDACTED}"` : full)
    .replace(/\b([a-zA-Z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s,&;)]+(?:\s+(?![a-zA-Z0-9_-]+\s*=)[^\s,&;)]+)*)/g, (full, key: string) =>
      isSensitiveKey(key) ? `${key}=${REDACTED}` : full)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/(?<!\w)\+\d[\d\s().-]{7,}\d(?!\w)/g, REDACTED)
    .replace(/(?<![0-9a-zA-Z])\d{10}(?![0-9a-zA-Z])/g, REDACTED)
    .replace(/-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/g, REDACTED)
    .replace(/(?<![0-9a-zA-Z.])\d{1,2}\.\d{3}\.\d{3}(?![0-9a-zA-Z.])/g, REDACTED)
    .replace(/(?<![0-9a-zA-Z.-])\d{7,8}(?![0-9a-zA-Z.-])/g, REDACTED);
}

function scrubUntrustedValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return REDACTED;
  if (typeof value === "number") return isSensitiveNumber(value) ? REDACTED : value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return isCoordinatePair(value) ? REDACTED : value.map((item) => scrubUntrustedValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : scrubUntrustedValue(entry, seen);
  }
  return output;
}

function scrubHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers)) {
    const normalized = header.toLowerCase();
    if (!SAFE_HEADER_KEYS.has(normalized)) continue;
    if (typeof value !== "string") {
      cleaned[header] = REDACTED;
      continue;
    }
    const trimmed = value.trim();
    if (normalized === "content-type" || normalized === "accept") {
      cleaned[header] = isSafeMimeHeader(trimmed) ? trimmed : REDACTED;
    } else if (normalized === "content-length") {
      cleaned[header] = /^\d{1,6}$/.test(trimmed) ? trimmed : REDACTED;
    } else {
      cleaned[header] = isSafeServerEpoch(trimmed) ? trimmed : REDACTED;
    }
  }
  return cleaned;
}

function scrubTags(tags: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags)) {
    const normalized = key.toLowerCase();
    const validator = SAFE_TAG_VALIDATORS[normalized];
    if (!validator) {
      cleaned[key] = typeof value === "object" && value !== null ? scrubUntrustedValue(value, seen) : REDACTED;
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      cleaned[key] = validator(trimmed) ? trimmed : REDACTED;
    } else if (typeof value === "boolean" && normalized === "handled") {
      cleaned[key] = value;
    } else {
      cleaned[key] = scrubUntrustedValue(value, seen);
    }
  }
  return cleaned;
}

function scrubContexts(
  contexts: Record<string, Record<string, unknown> | undefined>,
  seen: WeakSet<object>,
): Record<string, Record<string, unknown> | undefined> {
  const cleaned: Record<string, Record<string, unknown> | undefined> = {};
  for (const [contextKey, entry] of Object.entries(contexts)) {
    if (entry === undefined || entry === null) {
      cleaned[contextKey] = entry;
      continue;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      cleaned[contextKey] = scrubUntrustedValue(entry, seen) as Record<string, unknown>;
      continue;
    }
    const fieldValidators = SAFE_CONTEXT_VALIDATORS[contextKey.toLowerCase()];
    if (!fieldValidators) {
      cleaned[contextKey] = scrubUntrustedValue(entry, seen) as Record<string, unknown>;
      continue;
    }
    const nextEntry: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(entry)) {
      const validator = fieldValidators[field.toLowerCase()];
      if (validator && typeof value === "string" && validator(value.trim())) {
        nextEntry[field] = value.trim();
      } else {
        nextEntry[field] = isSensitiveKey(field) ? REDACTED : scrubUntrustedValue(value, seen);
      }
    }
    cleaned[contextKey] = nextEntry;
  }
  return cleaned;
}

function scrubSdk(sdk: unknown, seen: WeakSet<object>): unknown {
  if (!sdk || typeof sdk !== "object" || Array.isArray(sdk)) return scrubUntrustedValue(sdk, seen);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sdk as Record<string, unknown>)) {
    if (key === "name") {
      cleaned.name = typeof value === "string" && KNOWN_SDK_NAMES.has(value.trim()) ? value.trim() : REDACTED;
    } else if (key === "version") {
      cleaned.version = typeof value === "string" && NUMERIC_VERSION_RE.test(value.trim()) ? value.trim() : REDACTED;
    } else if (key === "integrations" && Array.isArray(value)) {
      cleaned.integrations = value.map((item) =>
        typeof item === "string" && KNOWN_SDK_INTEGRATIONS.has(item.trim()) ? item.trim() : REDACTED,
      );
    } else if (key === "packages" && Array.isArray(value)) {
      cleaned.packages = value.map((pkg) => {
        if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return scrubUntrustedValue(pkg, seen);
        const nextPkg: Record<string, unknown> = {};
        for (const [pkgKey, pkgVal] of Object.entries(pkg as Record<string, unknown>)) {
          if (pkgKey === "name") {
            nextPkg.name = typeof pkgVal === "string" && SAFE_SENTRY_PACKAGE_RE.test(pkgVal.trim()) ? pkgVal.trim() : REDACTED;
          } else if (pkgKey === "version") {
            nextPkg.version = typeof pkgVal === "string" && NUMERIC_VERSION_RE.test(pkgVal.trim()) ? pkgVal.trim() : REDACTED;
          } else {
            nextPkg[pkgKey] = scrubUntrustedValue(pkgVal, seen);
          }
        }
        return nextPkg;
      });
    } else {
      cleaned[key] = isSensitiveKey(key) ? REDACTED : scrubUntrustedValue(value, seen);
    }
  }
  return cleaned;
}

function scrubMechanism(
  mechanism: NonNullable<NonNullable<ScrubbableErrorEvent["exception"]>["values"]>[number]["mechanism"],
  seen: WeakSet<object>,
) {
  if (!mechanism || typeof mechanism !== "object") return mechanism;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mechanism)) {
    if (key === "type") {
      cleaned.type = typeof value === "string" && KNOWN_MECHANISM_TYPES.has(value.trim().toLowerCase()) ? value.trim() : REDACTED;
    } else if (key === "handled" || key === "synthetic") {
      cleaned[key] = typeof value === "boolean" ? value : REDACTED;
    } else {
      cleaned[key] = isSensitiveKey(key) ? REDACTED : scrubUntrustedValue(value, seen);
    }
  }
  return cleaned as NonNullable<typeof mechanism>;
}

function scrubFrames(
  frames: NonNullable<NonNullable<NonNullable<ScrubbableErrorEvent["exception"]>["values"]>[number]["stacktrace"]>["frames"],
  seen: WeakSet<object>,
) {
  return frames?.map((frame) => ({
    ...frame,
    ...(typeof frame.filename === "string" ? { filename: stripUrlQueryAndFragment(frame.filename) } : {}),
    ...(typeof frame.abs_path === "string" ? { abs_path: stripUrlQueryAndFragment(frame.abs_path) } : {}),
    ...(frame.vars ? { vars: scrubUntrustedValue(frame.vars, seen) as Record<string, unknown> } : {}),
  }));
}

function scrubBreadcrumbMessage(message: string): string {
  if (message === "") return "";
  if (isWhitelistedMessage(message)) return message.trim();
  const httpSummary = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i.exec(message.trim());
  if (httpSummary) {
    const [, method, target] = httpSummary;
    if (/^https?:\/\//i.test(target!) || target!.startsWith("/")) {
      return `${method!.toUpperCase()} ${scrubRequestUrl(target!)}`;
    }
  }
  return REDACTED;
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T | null {
  const category = breadcrumb.category?.toLowerCase() ?? "";
  if (category.startsWith("ui.input") || category.startsWith("geolocation") || breadcrumb.type === "user") return null;
  const seen = new WeakSet<object>();
  const next = { ...breadcrumb } as T;
  const record = next as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "category" || key === "type" || key === "message" || key === "data") continue;
    if (key === "level") {
      record.level = typeof value === "string" && KNOWN_LEVELS.has(value.trim().toLowerCase()) ? value.trim() : REDACTED;
    } else if (key === "timestamp") {
      record.timestamp = isSafeTimestamp(value) ? value : REDACTED;
    } else {
      record[key] = isSensitiveKey(key) ? REDACTED : scrubUntrustedValue(value, seen);
    }
  }
  if (typeof next.category === "string") {
    next.category = KNOWN_BREADCRUMB_CATEGORIES.has(next.category.trim().toLowerCase()) ? next.category.trim() : REDACTED;
  }
  if (typeof next.type === "string") {
    next.type = KNOWN_BREADCRUMB_TYPES.has(next.type.trim().toLowerCase()) ? next.type.trim() : REDACTED;
  }
  if (typeof next.message === "string") next.message = scrubBreadcrumbMessage(next.message);
  if (next.data && typeof next.data === "object") {
    const cleanedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.data)) {
      const normalized = key.toLowerCase();
      if (isSensitiveKey(key) || normalized === "referrer") continue;
      if (URL_DATA_KEYS.has(normalized) && typeof value === "string") {
        cleanedData[key] = scrubRequestUrl(value);
      } else if (normalized === "method" && typeof value === "string") {
        cleanedData[key] = SAFE_HTTP_METHOD_RE.test(value.trim()) ? value.trim().toUpperCase() : REDACTED;
      } else if (normalized === "status_code" && typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        cleanedData[key] = value;
      } else {
        cleanedData[key] = scrubUntrustedValue(value, seen);
      }
    }
    next.data = cleanedData;
  }
  return next;
}

export function scrubErrorEvent<T extends ScrubbableErrorEvent>(event: T): T {
  const seen = new WeakSet<object>();
  const next = { ...event, user: undefined, server_name: undefined } as T;
  const record = next as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (key === "event_id") {
      record.event_id = typeof value === "string" && HEX_32_RE.test(value.trim()) ? value.trim() : REDACTED;
    } else if (key === "timestamp") {
      record.timestamp = isSafeTimestamp(value) ? value : REDACTED;
    } else if (key === "platform") {
      record.platform = typeof value === "string" && KNOWN_PLATFORMS.has(value.trim().toLowerCase()) ? value.trim() : REDACTED;
    } else if (key === "level") {
      record.level = typeof value === "string" && KNOWN_LEVELS.has(value.trim().toLowerCase()) ? value.trim() : REDACTED;
    } else if (key === "environment") {
      record.environment = typeof value === "string" && KNOWN_ENVIRONMENTS.has(value.trim().toLowerCase()) ? value.trim() : REDACTED;
    } else if (key === "type") {
      record.type = typeof value === "string" && KNOWN_EVENT_TYPES.has(value.trim().toLowerCase()) ? value.trim() : REDACTED;
    } else if (key === "sdk") {
      record.sdk = scrubSdk(value, seen);
    } else if (key === "modules" || key === "debug_meta") {
      record[key] = undefined;
    } else if (!HANDLED_EVENT_KEYS.has(key)) {
      record[key] = isSensitiveKey(key) ? REDACTED : scrubUntrustedValue(value, seen);
    }
  }

  if (typeof next.message === "string") next.message = scrubMessage(next.message);
  if (typeof next.transaction === "string") next.transaction = scrubTransaction(next.transaction);
  if (next.logentry && typeof next.logentry === "object") {
    const scrubbedLogentry: NonNullable<ScrubbableErrorEvent["logentry"]> = {};
    if (typeof next.logentry.message === "string") scrubbedLogentry.message = scrubMessage(next.logentry.message);
    if (typeof next.logentry.formatted === "string") scrubbedLogentry.formatted = scrubMessage(next.logentry.formatted);
    next.logentry = Object.keys(scrubbedLogentry).length > 0 ? scrubbedLogentry : { message: REDACTED };
  }

  if (next.request && typeof next.request === "object") {
    const { method, url, headers } = next.request;
    next.request = {
      ...(typeof method === "string"
        ? { method: SAFE_HTTP_METHOD_RE.test(method.trim()) ? method.trim().toUpperCase() : REDACTED }
        : {}),
      ...(typeof url === "string" ? { url: scrubRequestUrl(url) } : {}),
      ...(headers ? { headers: scrubHeaders(headers) } : {}),
    };
  }

  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((item) => ({
        ...item,
        ...(typeof item.type === "string" ? { type: KNOWN_EXCEPTION_TYPES.has(item.type.trim()) ? item.type.trim() : REDACTED } : {}),
        ...(typeof item.value === "string" ? { value: scrubMessage(item.value) } : {}),
        ...(item.mechanism ? { mechanism: scrubMechanism(item.mechanism, seen) } : {}),
        ...(item.stacktrace?.frames
          ? {
              stacktrace: {
                ...item.stacktrace,
                frames: scrubFrames(item.stacktrace.frames, seen),
              },
            }
          : {}),
      })),
    };
  }

  if (next.threads?.values) {
    next.threads = {
      ...next.threads,
      values: next.threads.values.map((thread) => ({
        ...thread,
        ...(typeof thread.name === "string" ? { name: REDACTED } : {}),
        ...(thread.stacktrace?.frames
          ? {
              stacktrace: {
                ...thread.stacktrace,
                frames: scrubFrames(thread.stacktrace.frames, seen),
              },
            }
          : {}),
      })),
    };
  }

  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb)).filter((crumb): crumb is ScrubbableBreadcrumb => crumb !== null);
  }
  if (next.extra) next.extra = scrubUntrustedValue(next.extra, seen) as Record<string, unknown>;
  if (next.contexts) next.contexts = scrubContexts(next.contexts, seen);
  if (next.tags) next.tags = scrubTags(next.tags, seen);
  if (Array.isArray(next.fingerprint)) {
    next.fingerprint = next.fingerprint.map((item) =>
      typeof item === "string" && item.trim() === "{{ default }}" ? "{{ default }}" : REDACTED,
    );
  }
  return next;
}
