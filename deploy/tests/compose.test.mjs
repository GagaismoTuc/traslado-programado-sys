import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';

function config(project) {
  const text = execFileSync('docker', ['compose', '--project-name', `traslado-${project}`, '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, IMAGE_TAG: 'test', DEPLOY_PROJECT: project },
  });
  return JSON.parse(text);
}

test('production and staging use distinct databases, volumes and networks', () => {
  const production = config('production');
  const staging = config('staging');
  assert.notEqual(production.volumes.database.name, staging.volumes.database.name);
  assert.notEqual(production.networks.default.name, staging.networks.default.name);
  assert.equal(production.services.db.ports, undefined);
  assert.equal(staging.services.db.ports, undefined);
  assert.equal(staging.services.api.environment.MIGRATION_DATABASE_URL, undefined);
  for (const service of Object.values(staging.services)) {
    for (const volume of service.volumes ?? []) assert.doesNotMatch(volume.source ?? '', /dumps|production/i);
  }
});

test('example environment contains placeholders and image context excludes environment files', () => {
  const example = readFileSync('deploy/.env.example', 'utf8');
  assert.match(example, /POSTGRES_PASSWORD=replace-with-a-unique-secret/);
  assert.match(example, /PRODUCTION_HOST=production\.example\.invalid/);
  assert.match(example, /STAGING_HOST=staging\.example\.invalid/);
  const ignore = readFileSync('.dockerignore', 'utf8');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\*\*\/\.env\.\*$/m);
});


test('edge connects to separate ingress networks while databases stay private', () => {
  const prod = config('production');
  const stage = config('staging');
  const edge = JSON.parse(execFileSync('docker', ['compose', '--project-name', 'traslado-edge', '--env-file', 'deploy/.env.example', '-f', 'deploy/edge.compose.yaml', 'config', '--format', 'json'], { encoding: 'utf8' }));
  assert.notEqual(prod.networks.ingress.name, stage.networks.ingress.name);
  assert.equal(prod.networks.ingress.name, edge.networks.production.name);
  assert.equal(stage.networks.ingress.name, edge.networks.staging.name);
  assert.deepEqual(Object.keys(prod.services.db.networks), ['default']);
  assert.deepEqual(Object.keys(stage.services.db.networks), ['default']);
  assert.deepEqual(Object.keys(stage.services.gateway.networks).sort(), ['default', 'ingress']);
  for (const service of Object.values(stage.services)) assert.equal(service.ports, undefined);
});


test('host variables follow names specified by the issue', () => {
  const expected = ['PRODUCTION_HOST', 'STAGING_HOST'];
  for (const path of ['deploy/Caddyfile', 'deploy/Gateway.Caddyfile']) {
    const used = [...readFileSync(path, 'utf8').matchAll(/\{\$(\w+_HOST)\}/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(used)].sort(), expected);
  }
  const env = readFileSync('deploy/.env.example', 'utf8');
  const used = [...env.matchAll(/^(\w+_HOST)=/gm)].map((match) => match[1]);
  assert.deepEqual(used.sort(), expected);
});

test('the API receives TRUSTED_PROXY_CIDRS and the gateway trusts the edge', () => {
  const text = execFileSync('docker', ['compose', '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, IMAGE_TAG: 'review', TRUSTED_PROXY_CIDRS: '172.16.0.0/12' },
  });
  assert.equal(JSON.parse(text).services.api.environment.TRUSTED_PROXY_CIDRS, '172.16.0.0/12', 'API container does not receive TRUSTED_PROXY_CIDRS');
  assert.match(readFileSync('deploy/.env.example', 'utf8'), /^TRUSTED_PROXY_CIDRS=/m, '.env.example does not document TRUSTED_PROXY_CIDRS');
  assert.match(readFileSync('deploy/Gateway.Caddyfile', 'utf8'), /\btrusted_proxies\b/, 'gateway does not configure trusted_proxies');
});

test('the example trusts only the gateway and edge networks of the project', () => {
  const prod = config('production');
  const edge = JSON.parse(execFileSync('docker', ['compose', '--project-name', 'traslado-edge', '--env-file', 'deploy/.env.example', '-f', 'deploy/edge.compose.yaml', 'config', '--format', 'json'], { encoding: 'utf8' }));
  const subnet = (network) => network.ipam.config.map((entry) => entry.subnet);
  const projectNetwork = subnet(prod.networks.default);
  const ingressNetwork = subnet(edge.networks.production);
  assert.notDeepEqual(ingressNetwork, subnet(edge.networks.staging));
  assert.deepEqual(prod.services.api.environment.TRUSTED_PROXY_CIDRS.split(','), [...projectNetwork, ...ingressNetwork]);
  assert.deepEqual(prod.services.gateway.environment.INGRESS_SUBNET.split(' '), ingressNetwork);
  assert.match(readFileSync('deploy/Gateway.Caddyfile', 'utf8'), /^\s*trusted_proxies static \{\$INGRESS_SUBNET\}$/m);
  assert.doesNotMatch(readFileSync('deploy/Caddyfile', 'utf8'), /trusted_proxies/, 'the edge faces clients and trusts no proxy');
});

test('the API receives VAPID keys and a non-empty default VAPID_SUBJECT when VAPID_SUBJECT is unset', () => {
  const envWithoutSubject = { ...process.env, IMAGE_TAG: 'review', VAPID_PUBLIC_KEY: 'pub-key', VAPID_PRIVATE_KEY: 'priv-key' };
  delete envWithoutSubject.VAPID_SUBJECT;
  const withoutSubject = JSON.parse(execFileSync('docker', ['compose', '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: envWithoutSubject,
  }));
  assert.equal(withoutSubject.services.api.environment.VAPID_PUBLIC_KEY, 'pub-key');
  assert.equal(withoutSubject.services.api.environment.VAPID_PRIVATE_KEY, 'priv-key');
  assert.equal(withoutSubject.services.api.environment.VAPID_SUBJECT, 'mailto:soporte@traslado.com');

  const withSubject = JSON.parse(execFileSync('docker', ['compose', '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...envWithoutSubject, VAPID_SUBJECT: 'mailto:ops@example.invalid' },
  }));
  assert.equal(withSubject.services.api.environment.VAPID_SUBJECT, 'mailto:ops@example.invalid');
});

test('local staging runs the offline prototype from the already-pulled API image, read-only and unpublished', () => {
  const text = execFileSync('docker', ['compose', '--project-name', 'traslado-staging', '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml', '-f', 'deploy/local-staging.compose.yaml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, IMAGE_TAG: 'test', DEPLOY_PROJECT: 'staging' },
  });
  const { services } = JSON.parse(text);
  const prototype = services['offline-prototype'];
  assert.equal(prototype.image, services.api.image);
  assert.deepEqual(prototype.command, ['node', '/prototype/server.mjs']);
  assert.equal(prototype.ports, undefined);
  assert.equal(prototype.environment, undefined, 'the prototype gets no database URL or secret');
  assert.deepEqual(prototype.volumes.map((volume) => ({ target: volume.target, readOnly: volume.read_only, source: volume.source.replaceAll('\\', '/').endsWith('/prototypes/offline-pwa') })),
    [{ target: '/prototype', readOnly: true, source: true }]);
  assert.deepEqual(Object.keys(prototype.networks), ['default']);
});

test('the local gateway keeps the office, driver and API routes and serves the prototype only on the office host', async () => {
  const name = `traslado-gateway-test-${process.pid}`;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
  const containers = [];
  const run = (alias, args) => { containers.push(`${name}-${alias}`); docker('run', '-d', '--name', `${name}-${alias}`, '--network', name, ...args); };
  const stub = (alias, port) => run(alias, ['--network-alias', alias, 'caddy:2-alpine', 'sh', '-c',
    `printf '%s\\n' ':${port} {' 'respond "${alias} {uri}"' '}' > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile`]);
  const get = (port, host, path) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(`${response.statusCode} ${response.headers.location ?? body}`));
    }).on('error', reject).end();
  });
  docker('network', 'create', name);
  try {
    stub('office', 80);
    stub('driver', 80);
    stub('api', 3000);
    stub('offline-prototype', 8080);
    run('gateway', ['-e', 'LOCAL_DRIVER_HOST=driver.test', '-e', 'INGRESS_SUBNET=172.16.20.0/24',
      '-v', `${resolve('deploy/LocalGateway.Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-p', '127.0.0.1::80', 'caddy:2-alpine']);
    const port = Number(docker('port', `${name}-gateway`, '80').split('\n')[0].split(':').pop());
    const ready = Date.now() + 15000;
    while ((await get(port, 'office.test', '/').catch(() => '')) !== '200 office /') {
      assert.ok(Date.now() < ready, 'gateway and stubs did not start');
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(await get(port, 'office.test', '/passengers'), '200 office /passengers');
    assert.equal(await get(port, 'office.test', '/api/health'), '200 api /health');
    assert.equal(await get(port, 'driver.test', '/'), '200 driver /');
    assert.equal(await get(port, 'driver.test', '/api/health'), '200 api /health');
    assert.equal(await get(port, 'office.test', '/offline-prototype/sw.js'), '200 offline-prototype /sw.js');
    assert.equal(await get(port, 'office.test', '/offline-prototype'), '308 /offline-prototype/');
    assert.equal(await get(port, 'driver.test', '/offline-prototype/sw.js'), '200 driver /offline-prototype/sw.js');
  } finally {
    for (const container of containers) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    execFileSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  }
});
