import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
const script = resolve('deploy/local-staging.sh');

function withFakeStaging(check) {
  const root = mkdtempSync(join(tmpdir(), 'local-staging-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'docker'), '#!/bin/sh\necho "$*" >> "$LOG"\ncase "$*" in *"--profile tools pull"*) [ "${FAIL_PULL-}" != 1 ] || exit 1;; *"down --remove-orphans"*) [ "${FAIL_DOWN-}" != 1 ] || exit 1;; *"volume inspect"*|*"network inspect"*) exit 1;; *"run --rm --no-deps -e SYNTHETIC_PASSWORD"*) echo synthetic-hash;; *"exec -T db psql"*) cat > "$SQL";; *"exec -T db sh -c"*) cat > "$SEED_SQL";; esac\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'cloudflared'), '#!/bin/sh\necho tunnel >> "$TUNNELS"\nif [ -e "$COUNT" ]; then host=driver; else host=office; touch "$COUNT"; fi\necho "https://$host.trycloudflare.com" >&2\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  const env = { ...process.env, DEPLOY_ROOT: root, IMAGE_TAG: 'test', COUNT: join(root, 'count'), LOG: join(root, 'docker-log'), SQL: join(root, 'sql'), SEED_SQL: join(root, 'seed-sql'), TUNNELS: join(root, 'tunnels'), PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  const run = (action) => spawnSync(shell, [script, action], { encoding: 'utf8', timeout: 20000, env });
  try { check({ root, env, run }); } finally {
    run('down');
    rmSync(root, { recursive: true, force: true });
  }
}

test('rejects production before starting containers or tunnels', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-staging-'));
  try {
    mkdirSync(join(root, 'staging'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'staging', '.env'), 'DEPLOY_PROJECT=production\n');
    for (const name of ['docker', 'cloudflared']) {
      writeFileSync(join(root, 'bin', name), '#!/bin/sh\necho invoked >> "$LOG"\n', { mode: 0o755 });
    }
    const log = join(root, 'calls');
    const result = spawnSync(shell, [script, 'up'], {
      encoding: 'utf8', env: { ...process.env, DEPLOY_ROOT: root, LOG: log, PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local staging only runs the staging project/);
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to adopt an unmanaged staging environment or database', () => {
  withFakeStaging(({ root, run }) => {
    mkdirSync(join(root, 'staging'));
    writeFileSync(join(root, 'staging', '.env'), 'DEPLOY_PROJECT=staging\nDATABASE_URL=postgresql://production.example/db\n');
    const result = run('up');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not owned by local staging/);
    const calls = readFileSync(join(root, 'docker-log'), 'utf8');
    assert.doesNotMatch(calls, /pull|compose|network create/);
    assert.equal(existsSync(join(root, 'tunnels')), false);
  });
});

test('fails before tunnels when Docker is not running', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-staging-'));
  try {
    mkdirSync(join(root, 'staging'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'staging', '.env'), 'DEPLOY_PROJECT=staging\n');
    writeFileSync(join(root, 'bin', 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'cloudflared'), '#!/bin/sh\necho invoked >> "$LOG"\n', { mode: 0o755 });
    const log = join(root, 'calls');
    const result = spawnSync(shell, [script, 'up'], {
      encoding: 'utf8', env: { ...process.env, DEPLOY_ROOT: root, LOG: log, PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Docker is not running: start Docker Desktop/);
    assert.equal(existsSync(log), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails before containers when cloudflared is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-staging-'));
  try {
    mkdirSync(join(root, 'staging'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'staging', '.env'), 'DEPLOY_PROJECT=staging\n');
    writeFileSync(join(root, 'bin', 'docker'), '#!/bin/sh\necho "$*" >> "$LOG"\nexit 0\n', { mode: 0o755 });
    const systemPath = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin;C:/Program Files/Git/bin' : '/usr/bin:/bin';
    const result = spawnSync(shell, [script, 'up'], {
      encoding: 'utf8', env: { ...process.env, DEPLOY_ROOT: root, LOG: join(root, 'docker-log'), 'ProgramFiles(x86)': root, PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${systemPath}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cloudflared/);
    assert.equal(readFileSync(join(root, 'docker-log'), 'utf8').trim(), 'info');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('down is harmless before staging has ever started', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-staging-'));
  try {
    const result = spawnSync(shell, [script, 'down'], {
      encoding: 'utf8', env: { ...process.env, DEPLOY_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('starts staging and prints two HTTPS tunnel URLs', () => {
  withFakeStaging(({ root, run }) => {
    const result = run('up');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^office: https:\/\/[a-z0-9-]+\.trycloudflare\.com\ndriver: https:\/\/[a-z0-9-]+\.trycloudflare\.com\n$/);
    const calls = readFileSync(join(root, 'docker-log'), 'utf8');
    for (const image of ['api:test', 'office:test', 'driver:test', 'osrm:tucuman-260101-osrm26.4.0-r1']) {
      assert.ok(calls.includes(`pull ghcr.io/gagaismotuc/traslado-${image}`), image);
    }
    assert.match(calls, /run --rm --no-deps migrate/);
    assert.match(calls, /exec -T db sh -c/);
    assert.match(readFileSync(join(root, 'seed-sql'), 'utf8'), /Synthetic Passenger 001/);
    assert.match(readFileSync(join(root, 'sql'), 'utf8'), /INSERT INTO drivers/);
  });
});

test('up pulls all compose images including tools before starting services', () => {
  withFakeStaging(({ root, run }) => {
    const result = run('up');
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(root, 'docker-log'), 'utf8').split('\n');
    const pull = calls.findIndex((call) => /compose .* --profile tools pull$/.test(call));
    const start = calls.findIndex((call) => /compose .* up /.test(call));
    assert.ok(pull >= 0, 'missing compose pull for all profiles');
    assert.ok(pull < start, 'images must be pulled before starting services');
  });
});

test('fails before starting services or tunnels when compose pull fails', () => {
  withFakeStaging(({ root, env, run }) => {
    env.FAIL_PULL = '1';
    const result = run('up');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Compose image pull failed/);
    assert.doesNotMatch(readFileSync(join(root, 'docker-log'), 'utf8'), /network create|compose .* up /);
    assert.equal(existsSync(join(root, 'tunnels')), false);
  });
});

test('rejects unsafe persisted network and proxy settings', () => {
  for (const [key, unsafe] of [['DEPLOY_SUBNET', '0.0.0.0/0'], ['INGRESS_SUBNET', '0.0.0.0/0'], ['TRUSTED_PROXY_CIDRS', '0.0.0.0/0']]) {
    withFakeStaging(({ root, run }) => {
      assert.equal(run('up').status, 0);
      assert.equal(run('down').status, 0);
      const path = join(root, 'staging', '.env');
      const text = readFileSync(path, 'utf8');
      writeFileSync(path, text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${unsafe}`));
      const result = run('up');
      assert.notEqual(result.status, 0, key);
      assert.match(result.stderr, /Invalid local staging env/);
    });
  }
});

test('keeps generated secrets and tunnel state outside the repository', () => {
  withFakeStaging(({ root, run }) => {
    const result = run('up');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resolve(root).startsWith(resolve('.') + (process.platform === 'win32' ? '\\' : '/')), false);
    assert.match(readFileSync(join(root, 'staging', 'driver-password'), 'utf8'), /^[0-9a-f]{24}\s*$/);
    assert.ok(existsSync(join(root, 'staging', '.env')));
    assert.ok(existsSync(join(root, 'staging', 'office.pid')));
  });
});

test('wires the exact tunnel origins and driver host before starting the API', () => {
  withFakeStaging(({ root, run }) => {
    const result = run('up');
    assert.equal(result.status, 0, result.stderr);
    const env = readFileSync(join(root, 'staging', '.env'), 'utf8');
    assert.match(env, /^AUTH_ALLOWED_ORIGINS=https:\/\/office\.trycloudflare\.com,https:\/\/driver\.trycloudflare\.com$/m);
    assert.match(env, /^LOCAL_DRIVER_HOST=driver\.trycloudflare\.com$/m);
    const gateway = readFileSync('deploy/LocalGateway.Caddyfile', 'utf8');
    assert.match(gateway, /@driver host \{\$LOCAL_DRIVER_HOST\}/);
    assert.match(gateway, /reverse_proxy api:3000/);
  });
});

test('repeated up reuses tunnels and down keeps staging state', () => {
  withFakeStaging(({ root, run }) => {
    const first = run('up');
    assert.equal(first.status, 0, first.stderr);
    const second = run('up');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.equal(readFileSync(join(root, 'tunnels'), 'utf8').trim().split('\n').length, 2);
    const down = run('down');
    assert.equal(down.status, 0, down.stderr);
    assert.equal(existsSync(join(root, 'staging', '.env')), true);
    assert.equal(existsSync(join(root, 'staging', 'driver-password')), true);
    assert.equal(run('down').status, 0);
  });
});

test('retains cleanup state when stopping containers fails', () => {
  withFakeStaging(({ root, env, run }) => {
    assert.equal(run('up').status, 0);
    env.FAIL_DOWN = '1';
    try {
      assert.notEqual(run('down').status, 0);
      assert.equal(existsSync(join(root, 'staging', 'local-staging-active')), true);
    } finally {
      delete env.FAIL_DOWN;
    }
  });
});

test('refuses to discard unrecognizable tunnel state', () => {
  withFakeStaging(({ root, run }) => {
    assert.equal(run('up').status, 0);
    const path = join(root, 'staging', 'office.pid');
    const original = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, 'unrecognizable\n');
      assert.notEqual(run('down').status, 0);
      assert.equal(existsSync(join(root, 'staging', 'local-staging-active')), true);
    } finally {
      writeFileSync(path, original);
    }
  });
});

test('local compose exposes only the gateway on loopback', () => {
  const result = spawnSync('docker', ['compose', '--project-name', 'traslado-staging', '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml', '-f', 'deploy/local-staging.compose.yaml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, IMAGE_TAG: 'test', DEPLOY_PROJECT: 'staging' },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== 'gateway') assert.equal(service.ports, undefined, name);
  }
  assert.equal(config.services.gateway.ports.length, 1);
  assert.equal(config.services.gateway.ports[0].host_ip, '127.0.0.1');
});
