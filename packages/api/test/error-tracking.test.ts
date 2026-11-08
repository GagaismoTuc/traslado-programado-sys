import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createApp, type HealthDatabase, type RoutingHealth } from "../src/app.js";
import { createPool } from "../src/db.js";
import { createApiErrorTracker } from "../src/error-tracking.js";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const rootComposeFile = join(repositoryRoot, "compose.yaml");
const glitchtipComposeFile = join(repositoryRoot, "infra/glitchtip/compose.yaml");
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const stubDb: HealthDatabase = { query: async () => ({ rows: [], rowCount: 0 }) };

type ComposePort = { host_ip?: string; published?: string | number; target?: number };
type ComposeServiceConfig = {
  image?: string;
  logging?: { driver?: string; options?: Record<string, string> };
  ports?: ComposePort[];
};

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

async function inspectCompose(file: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, ComposeServiceConfig>> {
  const { stdout } = await run("docker", ["compose", "-f", file, "config", "--format", "json"], { env });
  return (JSON.parse(stdout) as { services: Record<string, ComposeServiceConfig> }).services;
}

function parseMemoryMiB(raw: string): number {
  const usage = raw.split("/")[0]?.trim() ?? "";
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/i.exec(usage);
  if (!match) throw new Error(`Unrecognized docker stats memory value: ${raw}`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === "b") return amount / (1024 * 1024);
  if (unit === "kib" || unit === "kb") return amount / 1024;
  if (unit === "mib" || unit === "mb") return amount;
  if (unit === "gib" || unit === "gb") return amount * 1024;
  throw new Error(`Unsupported unit in docker stats: ${raw}`);
}

describe("error tracking and container log rotation", () => {
  it("configures json-file log rotation with max-size and max-file on every Compose service and keeps GlitchTip off public ports", async () => {
    const sampleEnv = {
      ...process.env,
      GLITCHTIP_POSTGRES_PASSWORD: "synthetic-db-password",
      GLITCHTIP_SECRET_KEY: "synthetic-secret-key",
      GLITCHTIP_ADMIN_USER: "ops-admin",
      GLITCHTIP_ADMIN_PASSWORD_HASH: ["$2a$14$", "0".repeat(53)].join(""),
    };
    const rootServices = await inspectCompose(rootComposeFile, sampleEnv);
    const glitchtipServices = await inspectCompose(glitchtipComposeFile, sampleEnv);

    expect(Object.keys(rootServices).sort()).toEqual(["osrm", "vroom"]);
    expect(Object.keys(glitchtipServices).sort()).toEqual(["caddy", "glitchtip", "postgres"]);

    for (const [name, service] of [...Object.entries(rootServices), ...Object.entries(glitchtipServices)]) {
      expect(service.logging?.driver, `${name} logging driver`).toBe("json-file");
      expect(service.logging?.options?.["max-size"], `${name} max-size`).toMatch(/^\d+[kmg]$/i);
      expect(Number(service.logging?.options?.["max-file"]), `${name} max-file`).toBeGreaterThanOrEqual(2);
    }

    expect(glitchtipServices.postgres!.ports ?? []).toEqual([]);
    expect(glitchtipServices.glitchtip!.ports ?? []).toEqual([]);
    expect(glitchtipServices.caddy!.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", target: 8080 })]);
  });

  it("runs GlitchTip on a private admin path, stores API errors with a Pasajero payload without personal data, and measures container RAM", async () => {
    const id = randomBytes(4).toString("hex");
    const project = `traslado-gt-${id}`;
    const port = await freePort();
    const adminUser = "ops-admin";
    const adminPassword = `synthetic-admin-${id}`;
    const placeholderEnv = {
      ...process.env,
      GLITCHTIP_POSTGRES_PASSWORD: "x",
      GLITCHTIP_SECRET_KEY: "x",
      GLITCHTIP_ADMIN_USER: adminUser,
      GLITCHTIP_ADMIN_PASSWORD_HASH: ["$2a$14$", "0".repeat(53)].join(""),
    };
    const caddyImage = (await inspectCompose(glitchtipComposeFile, placeholderEnv)).caddy!.image!;
    const { stdout: hashOut } = await run("docker", ["run", "--rm", caddyImage, "caddy", "hash-password", "--plaintext", adminPassword]);

    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GLITCHTIP_PORT: String(port),
      GLITCHTIP_DOMAIN: `http://127.0.0.1:${port}`,
      GLITCHTIP_ADMIN_PATH: "/_glitchtip",
      GLITCHTIP_POSTGRES_PASSWORD: randomBytes(16).toString("hex"),
      GLITCHTIP_SECRET_KEY: randomBytes(24).toString("hex"),
      GLITCHTIP_ADMIN_USER: adminUser,
      GLITCHTIP_ADMIN_PASSWORD_HASH: hashOut.trim(),
    };
    const compose = (...args: string[]) => run("docker", ["compose", "-f", glitchtipComposeFile, "-p", project, ...args], { env: composeEnv });

    let trackerClose: (() => Promise<boolean>) | undefined;
    try {
      await compose("up", "-d", "--wait");
      const baseUrl = `http://127.0.0.1:${port}`;

      expect((await fetch(`${baseUrl}/`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/0/organizations/`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/_glitchtip/`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/_glitchtip/api/0/organizations/`)).status).toBe(401);

      const basicHeader = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
      const uiResponse = await fetch(`${baseUrl}/_glitchtip/`, { headers: { Authorization: basicHeader } });
      expect(uiResponse.status).toBe(200);
      expect(await uiResponse.text()).toContain('<base href="/_glitchtip/">');

      const bootstrapScript = [
        "import json, os, django",
        "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'glitchtip.settings'); django.setup()",
        "from apps.users.models import User",
        "from apps.organizations_ext.models import Organization",
        "from apps.projects.models import Project, ProjectKey",
        "from apps.teams.models import Team",
        "from apps.api_tokens.models import APIToken",
        "user, _ = User.objects.get_or_create(email='ops-synthetic@example.invalid', defaults={'is_superuser': True, 'is_staff': True})",
        "org, _ = Organization.objects.get_or_create(slug='traslado-test', defaults={'name': 'Traslado Test'}); org.add_user(user)",
        "proj, _ = Project.objects.get_or_create(slug='traslado-app', organization=org, defaults={'name': 'Traslado App'})",
        "team, _ = Team.objects.get_or_create(slug='ops', organization=org)",
        "team.members.add(org.organization_users.get(user=user)); team.projects.add(proj)",
        "key = ProjectKey.objects.filter(project=proj).first() or ProjectKey.objects.create(project=proj)",
        "tok = APIToken.objects.create(user=user, label='test-read'); tok.add_permissions(['project:read', 'event:read', 'org:read'])",
        "print(json.dumps({'projectId': proj.id, 'publicKey': key.public_key.hex, 'apiToken': tok.token}))",
      ].join("; ");

      const { stdout: bootstrapOut } = await compose("exec", "-T", "glitchtip", "python", "-c", bootstrapScript);
      const { projectId, publicKey, apiToken } = JSON.parse(bootstrapOut.trim().split(/\r?\n/).pop()!) as {
        projectId: number; publicKey: string; apiToken: string;
      };

      const tracker = createApiErrorTracker({ dsn: `http://${publicKey}@127.0.0.1:${port}/_glitchtip/${projectId}`, serverEpoch: "glitchtip-c2" });
      trackerClose = tracker.close;

      // Browser SDK CORS preflight and cross-origin envelope ingestion succeed without Basic Auth and strip client IPs.
      const preflight = await fetch(`${baseUrl}/_glitchtip/api/${projectId}/envelope/`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://oficina.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(preflight.status).toBeLessThan(400);
      expect(preflight.headers.get("access-control-allow-origin")).toBeTruthy();

      const browserEventId = randomBytes(16).toString("hex");
      const browserEnvelope = [
        JSON.stringify({ event_id: browserEventId, dsn: `http://${publicKey}@127.0.0.1:${port}/_glitchtip/${projectId}` }),
        JSON.stringify({ type: "event" }),
        JSON.stringify({ event_id: browserEventId, platform: "javascript", message: "Browser SDK smoke event", tags: { app: "office" } }),
      ].join("\n");
      const browserPost = await fetch(`${baseUrl}/_glitchtip/api/${projectId}/envelope/?sentry_key=${publicKey}&sentry_version=7`, {
        method: "POST",
        headers: {
          Origin: "https://oficina.example",
          "Content-Type": "text/plain;charset=UTF-8",
          "X-Forwarded-For": "198.51.100.77",
        },
        body: browserEnvelope,
      });
      expect(browserPost.status).toBeLessThan(300);
      expect(browserPost.headers.get("access-control-allow-origin")).toBeTruthy();

      const syntheticPassenger = {
        name: "Pasajero Sintético GlitchTip",
        dni: "43.456.789",
        homeAddress: "Calle Inventada 101",
        homeLat: -26.8302,
        homeLng: -65.2101,
        accessNotes: "Portón azul sintético",
        companions: 1,
        frontSeat: true,
        wheelchair: true,
        medicalAlert: "Alerta sintética: epilepsia fotosensible",
        authorizedAdults: [{ name: "Adulto Sintético Legal", dni: "30.111.222", phone: "+5493815550177", legalGuardian: true }],
      };

      const app = createApp({ db: stubDb, routing: routingUp, errorReporter: tracker.captureRequestError, config: { serverEpoch: "glitchtip-c2" } });
      app.post("/passengers-crash", async (context) => {
        const body = await context.req.json();
        throw new Error(`Database crash while saving ${JSON.stringify(body)} at -26.8302, -65.2101 with Key (name)=(Pasajero Sintético GlitchTip)`);
      });

      const crashResponse = await app.request("http://localhost/passengers-crash?name=Pasajero+Sint%C3%A9tico+GlitchTip&dni=43456789", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
          Cookie: "session=synthetic-live-cookie; remember_device=synthetic-live-device",
          Authorization: "Bearer synthetic-live-bearer",
        },
        body: JSON.stringify(syntheticPassenger),
      });
      expect(crashResponse.status).toBe(500);
      await tracker.flush(5000);

      let storedEvents: Array<{ eventID?: string; id?: string; title?: string }> = [];
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const eventsResponse = await fetch(`${baseUrl}/_glitchtip/api/0/projects/traslado-test/traslado-app/events/`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        expect(eventsResponse.status).toBe(200);
        storedEvents = (await eventsResponse.json()) as Array<{ eventID?: string; id?: string; title?: string }>;
        if (storedEvents.length >= 2) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }

      expect(storedEvents.length).toBeGreaterThanOrEqual(2);
      const allDetails = await Promise.all(
        storedEvents.map(async (item) => {
          const eventId = item.eventID ?? item.id;
          const res = await fetch(`${baseUrl}/_glitchtip/api/0/projects/traslado-test/traslado-app/events/${eventId}/`, {
            headers: { Authorization: `Bearer ${apiToken}` },
          });
          expect(res.status).toBe(200);
          return await res.text();
        }),
      );
      const storedDetailText = allDetails.join("\n");

      expect(storedDetailText).toContain("Database crash while saving");
      expect(storedDetailText).toContain("Browser SDK smoke event");
      for (const forbidden of [
        "Pasajero Sintético GlitchTip", "Adulto Sintético Legal", "43.456.789", "43456789", "30.111.222", "30111222",
        "3815550177", "Calle Inventada 101", "Portón azul sintético", "epilepsia fotosensible", "-26.8302", "-65.2101",
        "synthetic-live-cookie", "synthetic-live-device", "synthetic-live-bearer", "198.51.100.77",
      ]) {
        expect(storedDetailText).not.toContain(forbidden);
      }

      const { stdout: psIds } = await compose("ps", "-q");
      const containerIds = psIds.trim().split(/\r?\n/).filter(Boolean);
      expect(containerIds.length).toBe(3);
      const { stdout: statsOut } = await run("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}", ...containerIds]);
      const statsLines = statsOut.trim().split(/\r?\n/).filter(Boolean);
      const totalMiB = statsLines.reduce((sum, line) => sum + parseMemoryMiB(line.split("\t")[1]!), 0);
      console.info(`GlitchTip Compose measured memory: ${totalMiB.toFixed(1)} MiB (${statsLines.join("; ")})`);
      expect(totalMiB).toBeGreaterThan(20);
      expect(totalMiB).toBeLessThan(1024);
    } finally {
      await trackerClose?.().catch(() => undefined);
      await compose("down", "-v", "--remove-orphans").catch(() => undefined);
    }
  }, 240_000);

  it("redacts unstructured free text errors containing passenger names or addresses by default in API envelopes", async () => {
    const bodies: string[] = [];
    const tracker = createApiErrorTracker({
      dsn: `http://${"a".repeat(32)}@127.0.0.1:8080/1`,
      sendEnvelope: async (payload) => {
        bodies.push(payload);
        return { statusCode: 200 };
      },
    });

    const error = new Error("Failed processing record: Synthetic Person, Example Avenue 19");
    tracker.captureRequestError(error, { method: "GET", url: "http://localhost/example", headers: {} });
    expect(await tracker.flush()).toBe(true);
    await tracker.close();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("Synthetic Person");
    expect(bodies[0]).not.toContain("Example Avenue 19");
  });

  it("does not transmit integer coordinates in request.url", async () => {
    const bodies: string[] = [];
    const tracker = createApiErrorTracker({
      dsn: `http://${"a".repeat(32)}@127.0.0.1:8080/1`,
      sendEnvelope: async (payload) => {
        bodies.push(payload);
        return { statusCode: 200 };
      },
    });

    tracker.captureRequestError(new Error("routing error"), {
      method: "GET",
      url: "http://localhost/route/v1/driving/-65,-26;-66,-27",
      headers: {},
    });
    expect(await tracker.flush()).toBe(true);
    await tracker.close();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/-65,-26|-66,-27/);
  });

  it("does not transmit a passenger name in a real PostgreSQL error", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const envelopes: string[] = [];
    const receiver = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        envelopes.push(body);
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const pool = createPool(process.env.TEST_DATABASE_URL);
    const port = (receiver.address() as { port: number }).port;
    const tracker = createApiErrorTracker({ dsn: `http://${"a".repeat(32)}@127.0.0.1:${port}/1` });
    try {
      const app = createApp({
        db: pool,
        routing: { osrm: async () => {}, vroom: async () => {} },
        errorReporter: tracker.captureRequestError,
        config: { serverEpoch: "synthetic" },
      });
      app.get("/failure", async () => {
        await pool.query("select $1::integer", ["Synthetic Passenger"]);
        return new Response();
      });
      expect((await app.request("http://localhost/failure")).status).toBe(500);
      expect(await tracker.flush()).toBe(true);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).not.toContain("Synthetic Passenger");
    } finally {
      await tracker.close();
      await pool.end();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});
