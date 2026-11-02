import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const runFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const checkDiskScript = join(repositoryRoot, "infra/monitoring/check-disk.sh");
const serviceUnit = join(repositoryRoot, "infra/monitoring/traslado-disk-alert.service");
const timerUnit = join(repositoryRoot, "infra/monitoring/traslado-disk-alert.timer");

function resolveSh(): string {
  if (process.platform === "win32") {
    for (const candidate of ["C:\\Program Files\\Git\\usr\\bin\\sh.exe", "C:\\Program Files\\Git\\bin\\sh.exe"]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "sh";
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function withFakeDf<T>(usedPercent: number, fn: (binDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "traslado-df-"));
  const dfPath = join(dir, "df");
  const script = `#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf '/dev/sda1 80000000 68000000 12000000 ${usedPercent}%% /\\n'\n`;
  await writeFile(dfPath, script, { encoding: "utf8" });
  await chmod(dfPath, 0o755);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCheckDisk(binDir: string, extraEnv: Record<string, string>) {
  const basePath = process.env.PATH ?? process.env.Path ?? "";
  const gitBins = process.platform === "win32" ? `${delimiter}C:\\Program Files\\Git\\mingw64\\bin${delimiter}C:\\Program Files\\Git\\usr\\bin` : "";
  return await runFile(resolveSh(), [checkDiskScript], {
    env: {
      PATH: `${binDir}${delimiter}${basePath}${gitBins}`,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      MSYS_NO_PATHCONV: "1",
      MSYS2_ENV_CONV_EXCL: "DISK_MOUNT",
      TEMP: tmpdir(),
      TMP: tmpdir(),
      ...extraEnv,
    },
  });
}

describe("disk usage alert", () => {
  it("stays silent below threshold, alerts webhook and GlitchTip at or above threshold without personal data, and fails fast when misconfigured", async () => {
    const requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
    let nextStatus = 200;
    const server = createServer(async (req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: await readBody(req) });
      res.statusCode = nextStatus;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    const port = (server.address() as { port: number }).port;

    try {
      const webhookUrl = `http://127.0.0.1:${port}/webhook`;
      const dsnKey = "d".repeat(32);
      const dsn = `http://${dsnKey}@127.0.0.1:${port}/_glitchtip/7`;

      await withFakeDf(90, async (binDir) => {
        await expect(runCheckDisk(binDir, { DISK_ALERT_THRESHOLD_PERCENT: "80" })).rejects.toThrow(/DISK_ALERT_WEBHOOK_URL or GLITCHTIP_DSN/);
      });

      await withFakeDf(62, async (binDir) => {
        await runCheckDisk(binDir, { DISK_MOUNT: "/", DISK_ALERT_THRESHOLD_PERCENT: "80", DISK_ALERT_WEBHOOK_URL: webhookUrl, GLITCHTIP_DSN: dsn });
      });
      expect(requests).toEqual([]);

      await withFakeDf(85, async (binDir) => {
        await runCheckDisk(binDir, {
          DISK_MOUNT: "/",
          DISK_ALERT_THRESHOLD_PERCENT: "80",
          DISK_ALERT_WEBHOOK_URL: webhookUrl,
          GLITCHTIP_DSN: dsn,
          SYNTHETIC_UNRELATED_SECRET: "Pasajero Sintético Secreto",
        });
      });

      expect(requests).toHaveLength(2);
      const webhookCall = requests.find((item) => item.url === "/webhook")!;
      expect(webhookCall.method).toBe("POST");
      expect(JSON.parse(webhookCall.body)).toEqual({ alert: "disk_usage_high", mount: "/", usedPercent: 85, thresholdPercent: 80 });

      const envelopeCall = requests.find((item) => item.url === "/_glitchtip/api/7/envelope/")!;
      expect(envelopeCall).toBeDefined();
      expect(envelopeCall.method).toBe("POST");
      expect(String(envelopeCall.headers["x-sentry-auth"] ?? "")).toContain(`sentry_key=${dsnKey}`);
      expect(envelopeCall.body).toContain("Disk usage high: 85%");
      expect(envelopeCall.body).not.toContain("Pasajero Sintético Secreto");

      nextStatus = 500;
      await withFakeDf(91, async (binDir) => {
        await expect(runCheckDisk(binDir, { DISK_MOUNT: "/", DISK_ALERT_THRESHOLD_PERCENT: "80", DISK_ALERT_WEBHOOK_URL: webhookUrl })).rejects.toThrow();
      });

      expect(await readFile(serviceUnit, "utf8")).toContain("check-disk.sh");
      expect(await readFile(timerUnit, "utf8")).toContain("OnCalendar=");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
