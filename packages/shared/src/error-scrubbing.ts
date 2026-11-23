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
const SAFE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
const SAFE_SHORT_TOKEN_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
const SAFE_URL_SEGMENT_RE = /^(?:[A-Za-z0-9._~-]|\[REDACTED\]|;){1,128}$/;
const SAFE_MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9-]+=[a-z0-9._+-]+)*$/i;

const SAFE_HEADER_KEYS = new Set(["content-type", "content-length", "accept", "x-server-epoch"]);
const SAFE_TAG_KEYS = new Set(["app", "server_epoch", "environment", "handled", "level", "mechanism", "alert"]);
const SAFE_CONTEXT_FIELDS: Record<string, ReadonlySet<string>> = {
  runtime: new Set(["name", "version"]),
  os: new Set(["name", "version"]),
  browser: new Set(["name", "version"]),
  trace: new Set(["trace_id", "span_id", "parent_span_id", "op"]),
  app: new Set(["app_name", "app_version"]),
};
const KNOWN_SENTRY_TOP_LEVEL_KEYS = new Set([
  "event_id", "timestamp", "platform", "level", "logger", "environment", "release", "dist", "sdk", "modules",
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

// Tightly anchored full-string structural patterns admitting only bounded numeric codes or static mount paths.
const SAFE_FULL_MESSAGE_PATTERNS = [
  /^Nominatim answered \d{3}$/,
  /^Disk usage high: \d{1,3}% on \/[A-Za-z0-9._/-]* \(threshold \d{1,3}%\)$/,
];

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

function isSafeToken(value: string): boolean {
  return SAFE_SHORT_TOKEN_RE.test(value) && !hasNumericPii(value);
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
  return SAFE_EXACT_MESSAGES.has(trimmed.toLowerCase()) || SAFE_FULL_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
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
      cleaned[header] = SAFE_MIME_RE.test(trimmed) ? trimmed : REDACTED;
    } else if (normalized === "content-length") {
      cleaned[header] = /^\d{1,9}$/.test(trimmed) ? trimmed : REDACTED;
    } else {
      cleaned[header] = isSafeToken(trimmed) ? trimmed : REDACTED;
    }
  }
  return cleaned;
}

function scrubTags(tags: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!SAFE_TAG_KEYS.has(key.toLowerCase())) {
      cleaned[key] = typeof value === "object" && value !== null ? scrubUntrustedValue(value, seen) : REDACTED;
      continue;
    }
    if (typeof value === "string") {
      cleaned[key] = isSafeToken(value.trim()) ? value.trim() : REDACTED;
    } else if (typeof value === "boolean") {
      cleaned[key] = value;
    } else if (typeof value === "number") {
      cleaned[key] = isSensitiveNumber(value) ? REDACTED : value;
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
    if (!entry || typeof entry !== "object") {
      cleaned[contextKey] = entry;
      continue;
    }
    const allowedFields = SAFE_CONTEXT_FIELDS[contextKey.toLowerCase()];
    if (!allowedFields) {
      cleaned[contextKey] = scrubUntrustedValue(entry, seen) as Record<string, unknown>;
      continue;
    }
    const nextEntry: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(entry)) {
      if (allowedFields.has(field.toLowerCase()) && typeof value === "string" && isSafeToken(value.trim())) {
        nextEntry[field] = value.trim();
      } else {
        nextEntry[field] = isSensitiveKey(field) ? REDACTED : scrubUntrustedValue(value, seen);
      }
    }
    cleaned[contextKey] = nextEntry;
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
      cleaned.type = typeof value === "string" && SAFE_IDENTIFIER_RE.test(value) ? value : REDACTED;
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
  if (typeof next.category === "string" && !SAFE_IDENTIFIER_RE.test(next.category)) next.category = REDACTED;
  if (typeof next.type === "string" && !SAFE_IDENTIFIER_RE.test(next.type)) next.type = REDACTED;
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

  for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
    if (!KNOWN_SENTRY_TOP_LEVEL_KEYS.has(key)) {
      (next as Record<string, unknown>)[key] = isSensitiveKey(key) ? REDACTED : scrubUntrustedValue(value, seen);
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
        ...(typeof item.type === "string" ? { type: SAFE_IDENTIFIER_RE.test(item.type) ? item.type : REDACTED } : {}),
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
      item === "{{ default }}" || isSafeToken(item.trim()) ? item.trim() : REDACTED,
    );
  }
  return next;
}
