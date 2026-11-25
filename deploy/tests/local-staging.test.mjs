import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
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

// Prueba de campo (issue #146): a second local environment run by deploy/prueba-de-campo.sh. This Docker fake keeps
// the containers, volumes and networks of every Compose project, so both environments can share one PC and one root.
const fieldScript = resolve('deploy/prueba-de-campo.sh');
const fieldVolume = 'traslado-prueba-de-campo_database';
const fieldNetwork = 'traslado-local-ingress-prueba-de-campo';

function withTwoEnvironments(check) {
  const root = mkdtempSync(join(tmpdir(), 'field-test-'));
  const fake = join(root, 'fake');
  mkdirSync(join(root, 'bin'));
  mkdirSync(fake);
  writeFileSync(join(root, 'bin', 'docker'), [
    '#!/bin/sh',
    'echo "$*" >> "$LOG"',
    'all="$*"; project=; prev=',
    'for arg do [ "$prev" != --project-name ] || project=$arg; prev=$arg; done',
    'touch "$FAKE/containers" "$FAKE/volumes" "$FAKE/networks" "$FAKE/labels"',
    'drop() { awk -v item="$2" -v field="$3" \'field == 0 ? $0 != item : $field != item\' "$FAKE/$1" > "$FAKE/$1.tmp"; mv "$FAKE/$1.tmp" "$FAKE/$1"; }',
    'add() { grep -Fxq "$2" "$FAKE/$1" 2>/dev/null || echo "$2" >> "$FAKE/$1"; }',
    'case "$all" in',
    '  "ps -aq --filter label=com.docker.compose.project="*) [ "${FAIL_INSPECT-}" != 1 ] || exit 1; awk -v p="${all##*=}" \'$1 == p {print $2}\' "$FAKE/containers";;',
    '  "rm -f "*) shift 2; for id do drop containers "$id" 2; done;;',
    // $FAKE/labels holds "<volume|network> <compose project> <name>" for resources Compose labelled with a project.
    '  "volume ls --filter label=com.docker.compose.project="*|"network ls --filter label=com.docker.compose.project="*)',
    '    [ "${FAIL_INSPECT-}" != 1 ] || exit 1',
    '    awk -v k="$1" -v p="${4#label=com.docker.compose.project=}" \'$1 == k && $2 == p {print $3}\' "$FAKE/labels" | grep -Fxf "$FAKE/${1}s" || true;;',
    '  "volume ls"*) [ "${FAIL_INSPECT-}" != 1 ] || exit 1; cat "$FAKE/volumes";;',
    '  "volume rm "*) [ "${FAIL_VOLUME_RM-}" != 1 ] || exit 1; drop volumes "$3" 0; rm -f "$FAKE/office-${3%_database}";;',
    '  "network ls"*) cat "$FAKE/networks";;',
    '  "network inspect "*) grep -Fxq "$3" "$FAKE/networks" || exit 1;;',
    '  "network create "*) for arg do last=$arg; done; add networks "$last";;',
    '  "network rm "*) drop networks "$3" 0;;',
    '  compose*" up -d"*) add containers "$project $project-gateway"; add volumes "${project}_database"; add networks "${project}_default"; add ports "$project $LOCAL_GATEWAY_PORT";;',
    '  compose*"down --remove-orphans"*) drop containers "$project" 1; drop networks "${project}_default" 0;;',
    '  *"run --rm --no-deps -e SYNTHETIC_PASSWORD"*) echo synthetic-hash;;',
    '  *"db:bootstrap-office"*)',
    '    if [ -f "$FAKE/office-$project" ]; then echo "An Office account already exists" >&2; exit 1; fi',
    '    for arg do last=$arg; done; echo "$last" > "$FAKE/office-$project";;',
    '  *"exec -T db psql"*) cat > "$FAKE/sql-$project";;',
    '  *"exec -T db sh -c"*) cat > "$FAKE/seed-sql-$project";;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'cloudflared'), '#!/bin/sh\necho "$*" >> "$TUNNELS"\nif [ -e "$COUNT" ]; then host=driver; rm -f "$COUNT"; else host=office; touch "$COUNT"; fi\necho "https://$host.trycloudflare.com" >&2\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  const env = {
    ...process.env,
    DEPLOY_ROOT: root,
    IMAGE_TAG: 'test',
    FAKE: fake,
    COUNT: join(root, 'count'),
    LOG: join(root, 'docker-log'),
    TUNNELS: join(root, 'tunnels'),
    PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  };
  const run = (path, args, extraEnv) => spawnSync(shell, [path, ...args], { encoding: 'utf8', timeout: 20000, env: { ...env, ...extraEnv } });
  const field = (...args) => run(fieldScript, args);
  const staging = (...args) => run(script, args);
  const read = (name) => (existsSync(join(fake, name)) ? readFileSync(join(fake, name), 'utf8') : '');
  const log = () => (existsSync(env.LOG) ? readFileSync(env.LOG, 'utf8') : '');
  try { check({ root, env, run, field, staging, read, log }); } finally {
    run(fieldScript, ['borrar', '--confirmar']);
    run(script, ['down']);
    rmSync(root, { recursive: true, force: true });
  }
}

const stateFiles = ['.env', 'urls', 'office-password', 'driver-password', 'office.pid', 'driver.pid', 'local-staging-owned', 'local-staging-active'];
const snapshot = (dir) => Object.fromEntries(stateFiles.map((name) => [name, existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null]));
const alive = (pid) => spawnSync(shell, ['-c', `kill -0 ${pid}`]).status === 0;
const tunnelPids = (dir) => ['office', 'driver'].map((name) => readFileSync(join(dir, `${name}.pid`), 'utf8').split(' ')[0]);
const projectContainers = (text, project) => text.split('\n').filter((line) => line.startsWith(`${project} `));

test('prueba-de-campo up runs its own Compose project, state directory, subnets, port and tunnels', () => {
  withTwoEnvironments(({ root, env, field, staging, read, log }) => {
    assert.equal(staging('up').status, 0);
    const mark = log().length;
    const result = field('up');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^office: https:\/\/[a-z0-9-]+\.trycloudflare\.com\ndriver: https:\/\/[a-z0-9-]+\.trycloudflare\.com\n$/);
    const state = readFileSync(join(root, 'prueba-de-campo', '.env'), 'utf8');
    assert.match(state, /^DEPLOY_PROJECT=prueba-de-campo$/m);
    assert.match(state, /^DEPLOY_SUBNET=172\.16\.31\.0\/24$/m);
    assert.match(state, /^INGRESS_SUBNET=172\.16\.30\.0\/24$/m);
    assert.match(state, /^TRUSTED_PROXY_CIDRS=172\.16\.31\.0\/24,172\.16\.30\.0\/24$/m);
    const calls = log().slice(mark).split('\n').filter((call) => call.startsWith('compose'));
    assert.ok(calls.length > 0);
    for (const call of calls) assert.match(call, /--project-name traslado-prueba-de-campo /);
    assert.match(log(), new RegExp(`network create --subnet 172\\.16\\.30\\.0/24 ${fieldNetwork}`));
    assert.deepEqual(readFileSync(env.TUNNELS, 'utf8').trim().split('\n').slice(-2), Array(2).fill('tunnel --url http://127.0.0.1:18790'));
    assert.match(read('ports'), /^traslado-prueba-de-campo 18790$/m);
    assert.match(read('ports'), /^traslado-staging 18780$/m);
    assert.deepEqual(read('volumes').trim().split('\n').sort(), [fieldVolume, 'traslado-staging_database']);
  });
});

test('prueba-de-campo compose publishes only its gateway on its own loopback port, network and volume', () => {
  withTwoEnvironments(({ root, field }) => {
    assert.equal(field('up').status, 0);
    const result = spawnSync('docker', ['compose', '--project-name', 'traslado-prueba-de-campo', '--env-file', join(root, 'prueba-de-campo', '.env'), '-f', 'deploy/compose.yaml', '-f', 'deploy/local-staging.compose.yaml', 'config', '--format', 'json'], {
      encoding: 'utf8', env: { ...process.env, LOCAL_GATEWAY_PORT: '18790' },
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    for (const [name, service] of Object.entries(config.services)) {
      if (name !== 'gateway') assert.equal(service.ports, undefined, name);
    }
    assert.deepEqual(config.services.gateway.ports.map(({ host_ip, published }) => [host_ip, String(published)]), [['127.0.0.1', '18790']]);
    assert.equal(config.volumes.database.name, fieldVolume);
    assert.equal(config.networks.ingress.name, fieldNetwork);
    assert.equal(config.networks.default.ipam.config[0].subnet, '172.16.31.0/24');
  });
});

test('local-staging up and down keep the staging project, port, subnets and synthetic seed', () => {
  withTwoEnvironments(({ root, env, staging, read, log }) => {
    const up = staging('up');
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /^office: https:\/\/office\.trycloudflare\.com\ndriver: https:\/\/driver\.trycloudflare\.com\n$/);
    for (const call of log().split('\n').filter((line) => line.startsWith('compose'))) assert.match(call, /--project-name traslado-staging /);
    assert.match(log(), /network create --subnet 172\.16\.20\.0\/24 traslado-local-ingress-staging/);
    assert.equal(readFileSync(env.TUNNELS, 'utf8'), 'tunnel --url http://127.0.0.1:18780\n'.repeat(2));
    assert.match(read('ports'), /^traslado-staging 18780$/m);
    const state = readFileSync(join(root, 'staging', '.env'), 'utf8');
    assert.match(state, /^DEPLOY_PROJECT=staging$/m);
    assert.match(state, /^TRUSTED_PROXY_CIDRS=172\.16\.21\.0\/24,172\.16\.20\.0\/24$/m);
    assert.match(read('seed-sql-traslado-staging'), /Synthetic Passenger 001/);
    assert.match(read('sql-traslado-staging'), /Synthetic Driver 001/);
    assert.equal(read('office-traslado-staging').trim(), 'demo-oficina');
    const down = staging('down');
    assert.equal(down.status, 0, down.stderr);
    assert.equal(down.stdout, '');
    assert.deepEqual(read('volumes').trim().split('\n'), ['traslado-staging_database']);
    assert.ok(existsSync(join(root, 'staging', 'driver-password')));
    const usage = staging('borrar');
    assert.equal(usage.status, 2);
    assert.equal(usage.stderr, 'Usage: local-staging.sh <up|down>\n');
  });
});

test('prueba-de-campo up reuses the ownership check and office account and loads no staging seed', () => {
  withTwoEnvironments(({ root, env, field, read }) => {
    writeFileSync(join(env.FAKE, 'volumes'), `${fieldVolume}\n`);
    const unowned = field('up');
    assert.equal(unowned.status, 1);
    assert.match(unowned.stderr, /Existing prueba-de-campo resources are not owned by Prueba de campo/);
    assert.equal(existsSync(env.TUNNELS), false);
    rmSync(join(env.FAKE, 'volumes'));
    rmSync(join(root, 'prueba-de-campo'), { recursive: true });
    const up = field('up');
    assert.equal(up.status, 0, up.stderr);
    assert.equal(read('office-traslado-prueba-de-campo').trim(), 'demo-oficina');
    assert.match(readFileSync(join(root, 'prueba-de-campo', 'office-password'), 'utf8'), /^[0-9a-f]{24}\r?\n$/);
    assert.equal(read('sql-traslado-prueba-de-campo'), '');
    assert.equal(read('seed-sql-traslado-prueba-de-campo'), '');
    assert.equal(existsSync(join(root, 'prueba-de-campo', 'driver-password')), false);
  });
});

test('each script refuses the env file of the other project without touching anything', () => {
  for (const other of ['staging', 'production']) {
    withTwoEnvironments(({ root, env, field }) => {
      mkdirSync(join(root, 'prueba-de-campo'));
      const file = join(root, 'prueba-de-campo', '.env');
      writeFileSync(file, `DEPLOY_PROJECT=${other}\n`);
      for (const args of [['up'], ['down'], ['borrar'], ['borrar', '--confirmar']]) {
        const result = field(...args);
        assert.equal(result.status, 1, `${other} ${args.join(' ')}`);
        assert.equal(result.stderr, 'Prueba de campo only runs the prueba-de-campo project\n');
      }
      assert.equal(existsSync(env.LOG), false);
      assert.equal(existsSync(env.TUNNELS), false);
      assert.equal(readFileSync(file, 'utf8'), `DEPLOY_PROJECT=${other}\n`);
      rmSync(join(root, 'prueba-de-campo'), { recursive: true });
    });
  }
  withTwoEnvironments(({ root, env, staging }) => {
    mkdirSync(join(root, 'staging'));
    writeFileSync(join(root, 'staging', '.env'), 'DEPLOY_PROJECT=prueba-de-campo\n');
    for (const action of ['up', 'down']) {
      const result = staging(action);
      assert.equal(result.status, 1, action);
      assert.equal(result.stderr, 'local staging only runs the staging project\n');
    }
    assert.equal(existsSync(env.LOG), false);
    assert.equal(existsSync(env.TUNNELS), false);
    rmSync(join(root, 'staging'), { recursive: true });
  });
});

test('borrar never deletes the staging volume or directory, even when pointed at them', () => {
  withTwoEnvironments(({ root, run, read, log }) => {
    assert.equal(run(script, ['up']).status, 0);
    const stagingState = join(root, 'staging');
    const before = snapshot(stagingState);
    const mark = log().length;
    const pointed = run(fieldScript, ['borrar', '--confirmar'], { COMPOSE_PROJECT_NAME: 'traslado-staging', DEPLOY_PROJECT: 'staging' });
    assert.equal(pointed.status, 0, pointed.stderr);
    assert.equal(pointed.stdout, 'Nothing to delete: the Prueba de campo is already deleted\n');
    symlinkSync(stagingState, join(root, 'prueba-de-campo'), 'junction');
    for (const args of [['borrar'], ['borrar', '--confirmar']]) {
      const linked = run(fieldScript, args);
      assert.equal(linked.status, 1, args.join(' '));
      assert.match(linked.stderr, /only uses its own directory|only runs the prueba-de-campo project/);
    }
    rmSync(join(root, 'prueba-de-campo'));
    assert.deepEqual(snapshot(stagingState), before);
    assert.match(read('volumes'), /^traslado-staging_database$/m);
    assert.equal(projectContainers(read('containers'), 'traslado-staging').length, 1);
    assert.doesNotMatch(log().slice(mark), /^(rm -f|volume rm|network rm)/m);
    assert.deepEqual(tunnelPids(stagingState).map(alive), [true, true]);
  });
});

test('borrar without --confirmar deletes nothing and prints what it would delete and how to confirm', () => {
  withTwoEnvironments(({ root, field, read }) => {
    assert.equal(field('up').status, 0);
    const state = join(root, 'prueba-de-campo');
    const before = [snapshot(state), read('containers'), read('volumes'), read('networks')];
    const result = field('borrar');
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.equal(lines[0], 'borrar --confirmar would delete:');
    assert.deepEqual(lines.slice(1, 7), [
      '  containers of traslado-prueba-de-campo: traslado-prueba-de-campo-gateway',
      `  database volume ${fieldVolume}`,
      '  network traslado-prueba-de-campo_default',
      `  network ${fieldNetwork}`,
      '  cloudflared office tunnel',
      '  cloudflared driver tunnel',
    ]);
    assert.match(lines[7], /^  state directory .*prueba-de-campo$/);
    assert.equal(lines[8], 'Nothing was deleted. To delete it, run: sh deploy/prueba-de-campo.sh borrar --confirmar');
    assert.deepEqual([snapshot(state), read('containers'), read('volumes'), read('networks')], before);
    assert.deepEqual(tunnelPids(state).map(alive), [true, true]);
  });
});

test('borrar --confirmar deletes containers, database volume, ingress network and state, stops the tunnels, and can run twice', () => {
  withTwoEnvironments(({ root, field, read, log }) => {
    assert.equal(field('up').status, 0);
    const state = join(root, 'prueba-de-campo');
    const pids = tunnelPids(state);
    const result = field('borrar', '--confirmar');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Deleted:\n  containers of traslado-prueba-de-campo: traslado-prueba-de-campo-gateway\n/);
    assert.match(result.stdout, new RegExp(`\n  database volume ${fieldVolume}\n`));
    assert.match(result.stdout, new RegExp(`\n  network ${fieldNetwork}\n`));
    assert.match(result.stdout, /\n  state directory .*prueba-de-campo\nThe Prueba de campo is deleted\.\n$/);
    assert.match(log(), new RegExp(`^volume rm ${fieldVolume}$`, 'm'));
    assert.equal(read('containers').trim(), '');
    assert.equal(read('volumes').trim(), '');
    assert.equal(read('networks').trim(), '');
    assert.equal(existsSync(state), false);
    assert.deepEqual(pids.map(alive), [false, false]);
    const again = field('borrar', '--confirmar');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, 'Nothing to delete: the Prueba de campo is already deleted\n');
  });
});

test('borrar --confirmar fails and says what is left when something cannot be deleted', () => {
  withTwoEnvironments(({ root, run, read }) => {
    assert.equal(run(fieldScript, ['up']).status, 0);
    const state = join(root, 'prueba-de-campo');
    const unreadable = run(fieldScript, ['borrar', '--confirmar'], { FAIL_INSPECT: '1' });
    assert.equal(unreadable.status, 1);
    assert.equal(unreadable.stderr, 'Cannot inspect the Prueba de campo in Docker; nothing was deleted\n');
    assert.ok(existsSync(join(state, 'office-password')));
    assert.match(read('volumes'), new RegExp(`^${fieldVolume}$`, 'm'));
    const failed = run(fieldScript, ['borrar', '--confirmar'], { FAIL_VOLUME_RM: '1' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, new RegExp(`still left:\n  database volume ${fieldVolume}\n  state directory .*prueba-de-campo\n`));
    assert.match(failed.stderr, /run sh deploy\/prueba-de-campo\.sh borrar --confirmar again/);
    assert.ok(existsSync(join(state, 'office-password')));
    const retry = run(fieldScript, ['borrar', '--confirmar']);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(read('volumes').trim(), '');
    assert.equal(existsSync(state), false);
  });
});

test('borrar --confirmar fails and names an extra project volume that survives volume rm', () => {
  const root = mkdtempSync(join(tmpdir(), 'field-test-'));
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'docker'), '#!/bin/sh\necho "$*" >> "$LOG"\ncase "$1 $2" in\n  "volume ls") echo traslado-prueba-de-campo_extra ;;\nesac\n', { mode: 0o755 });
    const log = join(root, 'docker-log');
    const result = spawnSync(shell, [fieldScript, 'borrar', '--confirmar'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, DEPLOY_ROOT: root, LOG: log, PATH: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'borrar could not delete everything; still left:\n  volume traslado-prueba-de-campo_extra\nFix the cause and run sh deploy/prueba-de-campo.sh borrar --confirmar again\n');
    assert.match(readFileSync(log, 'utf8'), /^volume rm traslado-prueba-de-campo_extra$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('borrar lists and deletes every volume and network of the Prueba de campo Compose project', () => {
  withTwoEnvironments(({ root, env, field, read, log }) => {
    assert.equal(field('up').status, 0);
    writeFileSync(join(env.FAKE, 'volumes'), `${read('volumes')}traslado-prueba-de-campo_extra\n`);
    writeFileSync(join(env.FAKE, 'networks'), `${read('networks')}traslado-prueba-de-campo-extra-net\n`);
    writeFileSync(join(env.FAKE, 'labels'), 'network traslado-prueba-de-campo traslado-prueba-de-campo-extra-net\n');
    const before = [read('volumes'), read('networks')];
    const listed = field('borrar');
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.split('\n').slice(0, 7), [
      'borrar --confirmar would delete:',
      '  containers of traslado-prueba-de-campo: traslado-prueba-de-campo-gateway',
      `  database volume ${fieldVolume}`,
      '  volume traslado-prueba-de-campo_extra',
      '  network traslado-prueba-de-campo-extra-net',
      '  network traslado-prueba-de-campo_default',
      `  network ${fieldNetwork}`,
    ]);
    assert.deepEqual([read('volumes'), read('networks')], before);
    assert.doesNotMatch(log(), /^(rm -f|volume rm|network rm)/m);
    const result = field('borrar', '--confirmar');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\n  volume traslado-prueba-de-campo_extra\n  network traslado-prueba-de-campo-extra-net\n/);
    assert.match(log(), /^volume rm traslado-prueba-de-campo_extra$/m);
    assert.match(log(), /^network rm traslado-prueba-de-campo-extra-net$/m);
    assert.equal(read('volumes').trim(), '');
    assert.equal(read('networks').trim(), '');
  });
});

test('borrar never lists or deletes a staging volume or network, even labelled with the Prueba de campo project', () => {
  withTwoEnvironments(({ root, env, field, staging, read, log }) => {
    assert.equal(staging('up').status, 0);
    assert.equal(field('up').status, 0);
    writeFileSync(join(env.FAKE, 'labels'), [
      'volume traslado-prueba-de-campo traslado-staging_database',
      'network traslado-prueba-de-campo traslado-staging_default',
      'network traslado-prueba-de-campo traslado-local-ingress-staging',
      '',
    ].join('\n'));
    const listed = field('borrar');
    assert.equal(listed.status, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /staging/);
    const mark = log().length;
    const result = field('borrar', '--confirmar');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /staging/);
    assert.doesNotMatch(log().slice(mark), /^(rm -f|volume rm|network rm) .*staging/m);
    assert.match(read('volumes'), /^traslado-staging_database$/m);
    assert.match(read('networks'), /^traslado-staging_default$/m);
    assert.match(read('networks'), /^traslado-local-ingress-staging$/m);
    assert.ok(existsSync(join(root, 'staging', '.env')));
  });
});

test('prueba-de-campo down keeps the database and reminds that it holds real Posiciones', () => {
  withTwoEnvironments(({ root, field, read }) => {
    assert.equal(field('up').status, 0);
    const state = join(root, 'prueba-de-campo');
    const password = readFileSync(join(state, 'office-password'), 'utf8');
    const pids = tunnelPids(state);
    const down = field('down');
    assert.equal(down.status, 0, down.stderr);
    assert.equal(down.stdout, 'The Prueba de campo database keeps real Posiciones: when the test ends, run sh deploy/prueba-de-campo.sh borrar --confirmar\n');
    assert.equal(read('containers').trim(), '');
    assert.match(read('volumes'), new RegExp(`^${fieldVolume}$`, 'm'));
    assert.deepEqual(pids.map(alive), [false, false]);
    const again = field('up');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(state, 'office-password'), 'utf8'), password);
  });
});

test('with staging up, up, down and borrar of the Prueba de campo leave staging untouched, and the other way round', () => {
  withTwoEnvironments(({ root, field, staging, read, log }) => {
    assert.equal(staging('up').status, 0);
    const stagingState = join(root, 'staging');
    const before = [snapshot(stagingState), projectContainers(read('containers'), 'traslado-staging')];
    const mark = log().length;
    for (const args of [['up'], ['down'], ['up'], ['borrar', '--confirmar']]) assert.equal(field(...args).status, 0, args.join(' '));
    assert.doesNotMatch(log().slice(mark), /traslado-staging|ingress-staging/);
    assert.deepEqual([snapshot(stagingState), projectContainers(read('containers'), 'traslado-staging')], before);
    assert.match(read('volumes'), /^traslado-staging_database$/m);
    assert.match(read('networks'), /^traslado-local-ingress-staging$/m);
    assert.deepEqual(tunnelPids(stagingState).map(alive), [true, true]);

    const fieldUp = field('up');
    assert.equal(fieldUp.status, 0, fieldUp.stderr);
    const fieldState = join(root, 'prueba-de-campo');
    const fieldBefore = [snapshot(fieldState), projectContainers(read('containers'), 'traslado-prueba-de-campo')];
    const fieldMark = log().length;
    for (const action of ['down', 'up', 'down']) assert.equal(staging(action).status, 0, action);
    assert.doesNotMatch(log().slice(fieldMark), /prueba-de-campo/);
    assert.deepEqual([snapshot(fieldState), projectContainers(read('containers'), 'traslado-prueba-de-campo')], fieldBefore);
    assert.match(read('volumes'), new RegExp(`^${fieldVolume}$`, 'm'));
    assert.deepEqual(tunnelPids(fieldState).map(alive), [true, true]);
  });
});

test('the demo seed runs against the state that prueba-de-campo up writes', () => {
  withTwoEnvironments(({ root, env, field }) => {
    assert.equal(field('up').status, 0);
    const urls = join(root, 'prueba-de-campo', 'urls');
    writeFileSync(urls, readFileSync(urls, 'utf8').replace(/^office: .*$/m, 'office: https://127.0.0.1:9'));
    const result = spawnSync(shell, [resolve('deploy/seed-demo.sh'), '2099-12-05'], { encoding: 'utf8', timeout: 20000, env: { ...env, DEPLOY_PROJECT: 'prueba-de-campo' } });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'levantá la Prueba de campo con prueba-de-campo.sh up');
    assert.equal(existsSync(join(root, 'prueba-de-campo', 'office-totp-secret')), false);
  });
});
