import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
