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
  };
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { type?: string; handled?: boolean; data?: Record<string, unknown> };
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
};

const SAFE_KEYS = new Set(["filename", "abspath", "dirname", "basename", "pathname", "typename", "function"]);
const URL_DATA_KEYS = new Set(["url", "from", "to", "referrer"]);

const SENSITIVE_KEYS = new Set([
  "name", "fullname", "firstname", "lastname", "passengername", "drivername", "adultname", "guardianname", "receivername",
  "actorlabel", "username", "displayname", "address", "homeaddress", "baseaddress", "street", "streetname", "accessnotes",
  "medicalalert", "alert", "wheelchair", "frontseat", "companions", "requiredfeatures", "adaptacionesrequeridas", "featureids",
  "diagnosis", "sex", "gender", "reason", "overridereason", "before", "after", "beforedata", "afterdata", "dni", "receiverdni",
  "documento", "phone", "calledphone", "telefono", "email", "body", "requestbody", "responsebody", "query", "querystring",
  "search", "params", "parameters", "args", "arguments", "bind", "variables", "input", "cookie", "cookies", "setcookie",
  "authorization", "proxyauthorization", "auth", "token", "tokenhash", "session", "sessiontoken", "rememberdevice", "secret",
  "totp", "totpsecret", "password", "passwordhash", "code", "recoverycode", "apikey", "xapikey", "xauthtoken", "xcsrftoken",
  "xforwardedfor", "xrealip", "cfconnectingip", "ip", "ipaddress", "clientip", "lat", "lng", "lon", "latitude", "longitude",
  "homelat", "homelng", "homelatitude", "homelongitude", "startlat", "startlng", "startlatitude", "startlongitude", "endlat",
  "endlng", "coords", "coordinates", "location", "position", "pickup", "dropoff", "point", "points", "geo",
]);

const SENSITIVE_SUFFIXES = [
  "address", "dni", "phone", "latitude", "longitude", "homelat", "homelng", "token", "secret", "password", "cookie",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  if (SAFE_KEYS.has(normalized)) return false;
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isCoordinatePair(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [a, b] = value;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Number.isInteger(a) && Number.isInteger(b)) return false;
  return Math.abs(a) <= 180 && Math.abs(b) <= 180 && (Math.abs(a) <= 90 || Math.abs(b) <= 90);
}

export function stripUrlQueryAndFragment(url: string): string {
  return url.replace(/([?#]).*$/, "").replace(/([/;])-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/g, `$1${REDACTED}`);
}

export function scrubString(input: string): string {
  return input
    .replace(/otpauth:\/\/[^\s"']+/gi, REDACTED)
    .replace(/https?:\/\/[^\s"']+/gi, (match) => stripUrlQueryAndFragment(match))
    .replace(/(^|[\s"'(])(\/[A-Za-z0-9._~/%-;,-]*)[?#][^\s"')]+/g, (_, prefix: string, path: string) => `${prefix}${stripUrlQueryAndFragment(path)}`)
    .replace(/Key\s*\([^)]+\)=\([^)]*\)/gi, `Key (${REDACTED})=(${REDACTED})`)
    .replace(/"([a-zA-Z0-9_-]+)"\s*:\s*("[^"\\]*(?:\\.[^"\\]*)*"|-?\d+(?:\.\d+)?|true|false|null|\[\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+\s*\])/g, (full, key: string) =>
      isSensitiveKey(key) ? `"${key}":"${REDACTED}"` : full)
    .replace(/\b([a-zA-Z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s,&;]+)/g, (full, key: string) =>
      isSensitiveKey(key) ? `${key}=${REDACTED}` : full)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/(?<!\w)\+\d[\d\s().-]{7,}\d(?!\w)/g, REDACTED)
    .replace(/-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/g, REDACTED)
    .replace(/(?<![0-9a-zA-Z.])\d{1,2}\.\d{3}\.\d{3}(?![0-9a-zA-Z.])/g, REDACTED)
    .replace(/(?<![0-9a-zA-Z.-])\d{7,8}(?![0-9a-zA-Z.-])/g, REDACTED);
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return isCoordinatePair(value) ? REDACTED : value.map((item) => scrubValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = isSensitiveKey(key) ? REDACTED : scrubValue(entry, seen);
  return output;
}

function scrubHeaders(headers: Record<string, string> | undefined, seen: WeakSet<object>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers)) {
    if (!isSensitiveKey(header)) cleaned[header] = typeof value === "string" ? scrubString(value) : String(scrubValue(value, seen));
  }
  return cleaned;
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T | null {
  const category = breadcrumb.category?.toLowerCase() ?? "";
  if (category.startsWith("ui.input") || category.startsWith("geolocation") || breadcrumb.type === "user") return null;
  const seen = new WeakSet<object>();
  const next = { ...breadcrumb } as T;
  if (typeof next.message === "string") next.message = scrubString(next.message);
  if (next.data && typeof next.data === "object") {
    const cleanedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.data)) {
      if (isSensitiveKey(key)) continue;
      cleanedData[key] = URL_DATA_KEYS.has(key.toLowerCase()) && typeof value === "string"
        ? stripUrlQueryAndFragment(value)
        : scrubValue(value, seen);
    }
    next.data = cleanedData;
  }
  return next;
}

export function scrubErrorEvent<T extends ScrubbableErrorEvent>(event: T): T {
  const seen = new WeakSet<object>();
  const next = { ...event, user: undefined, server_name: undefined } as T;
  if (typeof next.message === "string") next.message = scrubString(next.message);
  if (typeof next.transaction === "string") next.transaction = scrubString(stripUrlQueryAndFragment(next.transaction));
  if (next.logentry && typeof next.logentry === "object") next.logentry = scrubValue(next.logentry, seen) as ScrubbableErrorEvent["logentry"];

  if (next.request && typeof next.request === "object") {
    const { data: _data, query_string: _query, cookies: _cookies, headers, url, ...rest } = next.request;
    next.request = {
      ...(scrubValue(rest, seen) as Record<string, unknown>),
      ...(typeof url === "string" ? { url: stripUrlQueryAndFragment(url) } : {}),
      ...(headers ? { headers: scrubHeaders(headers, seen) } : {}),
    };
  }

  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((item) => ({
        ...item,
        ...(typeof item.value === "string" ? { value: scrubString(item.value) } : {}),
        ...(item.mechanism ? { mechanism: scrubValue(item.mechanism, seen) as NonNullable<typeof item.mechanism> } : {}),
        ...(item.stacktrace?.frames
          ? {
              stacktrace: {
                ...item.stacktrace,
                frames: item.stacktrace.frames.map((frame) => ({
                  ...frame,
                  ...(typeof frame.filename === "string" ? { filename: stripUrlQueryAndFragment(frame.filename) } : {}),
                  ...(typeof frame.abs_path === "string" ? { abs_path: stripUrlQueryAndFragment(frame.abs_path) } : {}),
                  ...(frame.vars ? { vars: scrubValue(frame.vars, seen) as Record<string, unknown> } : {}),
                })),
              },
            }
          : {}),
      })),
    };
  }

  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb)).filter((crumb): crumb is ScrubbableBreadcrumb => crumb !== null);
  }
  if (next.extra) next.extra = scrubValue(next.extra, seen) as Record<string, unknown>;
  if (next.contexts) next.contexts = scrubValue(next.contexts, seen) as ScrubbableErrorEvent["contexts"];
  if (next.tags) next.tags = scrubValue(next.tags, seen) as Record<string, unknown>;
  return next;
}
