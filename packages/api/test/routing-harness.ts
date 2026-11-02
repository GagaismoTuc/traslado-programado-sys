import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const repositoryRoot = resolve(import.meta.dirname, "../../..");
export const osrmRecipe = join(repositoryRoot, "infra/osrm");
export const composeFile = join(repositoryRoot, "compose.yaml");
const syntheticExtract = join(import.meta.dirname, "fixtures/routing/synthetic-grid.osm");

export type RoutingStack = {
  osrmImage: string;
  osrmUrl: string;
  vroomUrl: string;
  artifactVersion: string;
  logs: (service: "osrm" | "vroom") => Promise<string>;
  stop: () => Promise<void>;
};

export async function readRecipe(): Promise<Record<string, string>> {
  const text = await readFile(join(osrmRecipe, "source.env"), "utf8");
  const recipe: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).filter((candidate) => /^[A-Z_]+=/.test(candidate))) {
    const value = line.slice(line.indexOf("=") + 1);
    recipe[line.slice(0, line.indexOf("="))] = value.replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => recipe[name] ?? "");
  }
  return recipe;
}

export async function composeConfig(): Promise<{ services: Record<string, { image: string; command: string[] | null; entrypoint: string[] | null }> }> {
  const { stdout } = await run("docker", ["compose", "-f", composeFile, "config", "--format", "json"]);
  return JSON.parse(stdout);
}

// Holds every listener open until all ports are known, so the ports are distinct.
async function freePorts(count: number) {
  const servers = await Promise.all(
    Array.from({ length: count }, () => new Promise<ReturnType<typeof createServer>>((resolveServer, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveServer(server));
    })),
  );
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise((closed) => server.close(closed))));
  return ports;
}

// C2 seam: builds the serving image from the small synthetic extract with the production recipe,
// then starts the Compose routing services with that image in a throwaway project.
export async function startRoutingStack(): Promise<RoutingStack> {
  const id = randomBytes(4).toString("hex");
  const project = `traslado-c2-${id}`;
  const image = `traslado-osrm-c2:${id}`;
  const artifactVersion = `synthetic-${id}`;
  const work = await mkdtemp(join(tmpdir(), "traslado-c2-"));
  const [osrmPort, vroomPort] = await freePorts(2);
  const env = { ...process.env, OSRM_IMAGE: image, OSRM_PORT: String(osrmPort), VROOM_PORT: String(vroomPort) };
  const compose = (...args: string[]) => run("docker", ["compose", "-f", composeFile, "-p", project, ...args], { env });

  const stop = async () => {
    await compose("down", "-v", "--remove-orphans").catch(() => undefined);
    await run("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  };

  try {
    const { OSRM_IMAGE } = await readRecipe();
    await mkdir(join(work, "image"));
    await copyFile(syntheticExtract, join(work, "synthetic-grid.osm"));
    // Same as build.sh: on Linux the container writes as the host user, so the files stay readable and removable.
    const user = process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
    await run("docker", [
      "run", "--rm", ...user, "-v", `${work}:/work`, "-v", `${osrmRecipe}:/recipe:ro`, "--entrypoint", "sh", OSRM_IMAGE,
      "/recipe/preprocess.sh", "/work/synthetic-grid.osm", "/work/image/data", artifactVersion,
    ]);
    await copyFile(join(osrmRecipe, "Dockerfile"), join(work, "image/Dockerfile"));
    await copyFile(join(osrmRecipe, "serve.sh"), join(work, "image/serve.sh"));
    await run("docker", ["build", "-q", "--build-arg", `OSRM_IMAGE=${OSRM_IMAGE}`, "-t", image, join(work, "image")]);
    await compose("up", "-d", "--wait");
  } catch (error) {
    // A cleanup failure must not hide the startup error.
    await stop().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`C2 routing harness requires Docker with Compose; startup failed: ${detail}`, { cause: error });
  }

  return {
    osrmImage: image,
    osrmUrl: `http://127.0.0.1:${osrmPort}`,
    vroomUrl: `http://127.0.0.1:${vroomPort}`,
    artifactVersion,
    logs: async (service) => (await compose("logs", "--no-color", service)).stdout,
    stop,
  };
}
