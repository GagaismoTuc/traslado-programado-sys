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
