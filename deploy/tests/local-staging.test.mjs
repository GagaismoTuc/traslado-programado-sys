import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
const script = resolve('deploy/local-staging.sh');

function withFakeStaging(check) {
  const root = mkdtempSync(join(tmpdir(), 'local-staging-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'docker'), [
    '#!/bin/sh',
    'echo "$*" >> "$LOG"',
    'case "$*" in',
    '  *"--profile tools pull"*) [ "${FAIL_PULL-}" != 1 ] || exit 1;;',
    '  *"down --remove-orphans"*) [ "${FAIL_DOWN-}" != 1 ] || exit 1;;',
    '  *"volume inspect"*|*"network inspect"*) exit 1;;',
    '  *"run --rm --no-deps -e SYNTHETIC_PASSWORD"*) echo synthetic-hash;;',
    '  *"db:bootstrap-office"*)',
    '    if [ -n "${OFFICE_BOOTSTRAP_FAIL-}" ]; then echo "$OFFICE_BOOTSTRAP_FAIL" >&2; exit 1; fi',
    '    if [ -z "${BOOTSTRAP_OFFICE_PASSWORD-}" ]; then echo "BOOTSTRAP_OFFICE_PASSWORD is required" >&2; exit 1; fi',
    '    printf "%s" "$BOOTSTRAP_OFFICE_PASSWORD" > "$OFFICE_PW_ENV"',
    '    printf "%s" "${DEPLOY_PROJECT-}" > "$OFFICE_PROJECT_ENV"',
    '    if [ -f "$OFFICE_DB" ]; then echo "An Office account already exists" >&2; exit 1; fi',
    '    for arg do last=$arg; done',
    '    printf "%s:%s\n" "$last" "$BOOTSTRAP_OFFICE_PASSWORD" >> "$OFFICE_DB"',
    '    echo "Created initial Office account: $last"',
    '    ;;',
    '  *"db:break-glass-office"*)',
    '    printf "break-glass:%s\n" "${BOOTSTRAP_OFFICE_PASSWORD-}" > "$OFFICE_DB"',
    '    ;;',
    '  *"exec -T db psql"*) cat > "$SQL";;',
    '  *"exec -T db sh -c"*) cat > "$SEED_SQL";;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'cloudflared'), '#!/bin/sh\necho tunnel >> "$TUNNELS"\nif [ -e "$COUNT" ]; then host=driver; rm -f "$COUNT"; else host=office; touch "$COUNT"; fi\necho "https://$host.trycloudflare.com" >&2\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  const env = {
    ...process.env,
    DEPLOY_ROOT: root,
    IMAGE_TAG: 'test',
    COUNT: join(root, 'count'),
    LOG: join(root, 'docker-log'),
    SQL: join(root, 'sql'),
    SEED_SQL: join(root, 'seed-sql'),
    TUNNELS: join(root, 'tunnels'),
    OFFICE_DB: join(root, 'office-db'),
    OFFICE_PW_ENV: join(root, 'office-pw-env'),
    OFFICE_PROJECT_ENV: join(root, 'office-project-env'),
    PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  };
  const run = (action, extraEnv) => spawnSync(shell, [script, action], { encoding: 'utf8', timeout: 20000, env: extraEnv ? { ...env, ...extraEnv } : env });
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

test('bootstraps synthetic office account demo-oficina via db:bootstrap-office and env var', () => {
  withFakeStaging(({ root, env, run }) => {
    const result = run('up');
    assert.equal(result.status, 0, result.stderr);
    const officePasswordPath = join(root, 'staging', 'office-password');
    assert.equal(existsSync(officePasswordPath), true);
    const password = readFileSync(officePasswordPath, 'utf8').trim();
    const calls = readFileSync(join(root, 'docker-log'), 'utf8').split('\n');
    const migrateIdx = calls.findIndex((call) => /run --rm --no-deps migrate$/.test(call));
    const bootstrapOfficeIdx = calls.findIndex((call) =>
      /run --rm --no-deps -e BOOTSTRAP_OFFICE_PASSWORD bootstrap pnpm --filter @traslado\/api db:bootstrap-office demo-oficina$/.test(call),
    );
    const upAllIdx = calls.findIndex((call) => /up -d --pull never$/.test(call));
    assert.ok(bootstrapOfficeIdx > migrateIdx && migrateIdx >= 0, 'db:bootstrap-office must run after migrate');
    assert.ok(bootstrapOfficeIdx < upAllIdx, 'db:bootstrap-office must run before starting the full stack');
    assert.equal(readFileSync(join(root, 'office-pw-env'), 'utf8'), password);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), `demo-oficina:${password}\n`);
    assert.equal(calls.join('\n').includes(password), false, 'password must never be passed on command line');
    if (process.platform !== 'win32') {
      assert.equal(statSync(officePasswordPath).mode & 0o777, 0o600);
    }
  });

  withFakeStaging(({ root, env, run }) => {
    env.OFFICE_BOOTSTRAP_FAIL = 'Database connection refused';
    const result = run('up');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Database connection refused/);
    assert.equal(existsSync(join(root, 'staging', 'office-password')), false);
    assert.equal(existsSync(join(root, 'staging', 'office-password.tmp')), false);
    assert.equal(existsSync(join(root, 'office-db')), false);
  });
});

test('second up is idempotent when office-password and office account already exist', () => {
  withFakeStaging(({ root, run }) => {
    const first = run('up');
    assert.equal(first.status, 0, first.stderr);
    const officePasswordPath = join(root, 'staging', 'office-password');
    const firstPassword = readFileSync(officePasswordPath, 'utf8');
    const persistedOfficeBefore = readFileSync(join(root, 'office-db'), 'utf8');
    assert.equal(persistedOfficeBefore, `demo-oficina:${firstPassword.trim()}\n`);

    const whileRunning = run('up');
    assert.equal(whileRunning.status, 0, whileRunning.stderr);
    assert.equal(readFileSync(officePasswordPath, 'utf8'), firstPassword);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), persistedOfficeBefore);

    assert.equal(run('down').status, 0);
    const afterDown = run('up');
    assert.equal(afterDown.status, 0, afterDown.stderr);
    assert.equal(readFileSync(officePasswordPath, 'utf8'), firstPassword);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), persistedOfficeBefore);
    assert.deepEqual(readFileSync(join(root, 'office-db'), 'utf8').trim().split('\n'), [`demo-oficina:${firstPassword.trim()}`]);
  });
});

test('generates office-password with openssl rand -hex 12 format and never prints it', () => {
  withFakeStaging(({ root, run }) => {
    const result = run('up');
    assert.equal(result.status, 0, result.stderr);
    const officePasswordPath = join(root, 'staging', 'office-password');
    const raw = readFileSync(officePasswordPath, 'utf8');
    assert.match(raw, /^[0-9a-f]{24}\r?\n$/);
    const password = raw.trim();
    const driverPassword = readFileSync(join(root, 'staging', 'driver-password'), 'utf8').trim();
    assert.notEqual(password, driverPassword);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), `demo-oficina:${password}\n`);
    assert.equal(result.stdout.includes(password), false);
    assert.equal(result.stderr.includes(password), false);
  });
});

test('fails without overwriting when office-password is missing but office account already exists', () => {
  withFakeStaging(({ root, run }) => {
    assert.equal(run('up').status, 0);
    const officePasswordPath = join(root, 'staging', 'office-password');
    const originalPassword = readFileSync(officePasswordPath, 'utf8').trim();
    const persistedOfficeBefore = readFileSync(join(root, 'office-db'), 'utf8');
    const driverPasswordBefore = readFileSync(join(root, 'staging', 'driver-password'), 'utf8');
    assert.equal(persistedOfficeBefore, `demo-oficina:${originalPassword}\n`);

    rmSync(officePasswordPath);
    const whileRunning = run('up');
    assert.notEqual(whileRunning.status, 0);
    assert.match(whileRunning.stderr, /local staging state/i);
    assert.match(whileRunning.stderr, /db:break-glass-office/);
    assert.equal(existsSync(officePasswordPath), false);
    assert.equal(existsSync(`${officePasswordPath}.tmp`), false);
    assert.notEqual(readFileSync(join(root, 'office-pw-env'), 'utf8'), originalPassword);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), persistedOfficeBefore);
    assert.equal(readFileSync(join(root, 'staging', 'driver-password'), 'utf8'), driverPasswordBefore);
    assert.doesNotMatch(readFileSync(join(root, 'docker-log'), 'utf8'), /db:break-glass-office/);
    assert.doesNotMatch(readFileSync(join(root, 'sql'), 'utf8'), /demo-oficina|'office'/i);

    const afterDown = run('up');
    assert.notEqual(afterDown.status, 0);
    assert.match(afterDown.stderr, /local staging state/i);
    assert.match(afterDown.stderr, /db:break-glass-office/);
    assert.equal(existsSync(officePasswordPath), false);
    assert.equal(existsSync(`${officePasswordPath}.tmp`), false);
    assert.notEqual(readFileSync(join(root, 'office-pw-env'), 'utf8'), originalPassword);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), persistedOfficeBefore);
    assert.equal(readFileSync(join(root, 'staging', 'driver-password'), 'utf8'), driverPasswordBefore);
    assert.doesNotMatch(readFileSync(join(root, 'docker-log'), 'utf8'), /db:break-glass-office/);
    assert.doesNotMatch(readFileSync(join(root, 'sql'), 'utf8'), /demo-oficina|'office'/i);
  });
});

test('never creates office-password or bootstraps office outside DEPLOY_PROJECT=staging', () => {
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
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_ROOT: root, DEPLOY_PROJECT: 'production', LOG: log, PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local staging only runs the staging project/);
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '');
    assert.equal(existsSync(join(root, 'staging', 'office-password')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  withFakeStaging(({ root: stagingRoot, run }) => {
    const result = run('up', { DEPLOY_PROJECT: 'production' });
    assert.equal(result.status, 0, result.stderr);
    const officePassword = readFileSync(join(stagingRoot, 'staging', 'office-password'), 'utf8').trim();
    assert.match(readFileSync(join(stagingRoot, 'staging', '.env'), 'utf8'), /^DEPLOY_PROJECT=staging$/m);
    assert.equal(readFileSync(join(stagingRoot, 'office-project-env'), 'utf8'), 'staging');
    assert.equal(readFileSync(join(stagingRoot, 'office-db'), 'utf8'), `demo-oficina:${officePassword}\n`);
  });
});

test('down stops staging while keeping office-password, driver-password and env state', () => {
  withFakeStaging(({ root, run }) => {
    assert.equal(run('up').status, 0);
    const officePasswordPath = join(root, 'staging', 'office-password');
    const original = readFileSync(officePasswordPath, 'utf8');
    const driverPasswordBefore = readFileSync(join(root, 'staging', 'driver-password'), 'utf8');
    const persistedOfficeBefore = readFileSync(join(root, 'office-db'), 'utf8');
    assert.equal(persistedOfficeBefore, `demo-oficina:${original.trim()}\n`);
    const down = run('down');
    assert.equal(down.status, 0, down.stderr);
    assert.equal(existsSync(join(root, 'staging', 'local-staging-active')), false);
    assert.equal(existsSync(join(root, 'staging', '.env')), true);
    assert.equal(readFileSync(join(root, 'staging', 'driver-password'), 'utf8'), driverPasswordBefore);
    assert.equal(readFileSync(officePasswordPath, 'utf8'), original);
    assert.equal(readFileSync(join(root, 'office-db'), 'utf8'), persistedOfficeBefore);
  });
});
