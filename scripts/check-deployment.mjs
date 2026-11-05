/** Verify the deployment contract with synthetic variables; no daemon or live data. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'clc-deployment-contract-'));
const emptyEnv = join(fixture, 'fixture.env');
writeFileSync(emptyEnv, '');
// Do not inherit a real .env, Compose overrides or credentials from the caller.
const environment = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const secrets = { JWT_SECRET: 'fixture-only-jwt-0123456789abcdef0123456789abcdef',
  PRINT_STATION_TOKEN: 'fixture-only-station-0123456789abcdef0123456789abcdef',
  MANASYNC_BRIDGE_KEY: 'fixture-only-bridge-key', SMTP_PASS: 'fixture-only-mail-password' };

function configuration(overrides = {}, composeFile = join(root, 'docker-compose.yml')) {
  const reply = spawnSync('docker', ['compose', '--project-name', 'clc-contract', '--env-file', emptyEnv,
    '--file', composeFile, 'config', '--format', 'json'], {
    cwd: fixture, env: { ...environment, ...secrets, ...overrides }, encoding: 'utf8', timeout: 20_000,
  });
  if (reply.error || reply.status !== 0) throw new Error('Compose contract check failed; install Docker Compose v2+ and rerun npm run check:deployment');
  return JSON.parse(reply.stdout).services['card-list-compare'];
}
let expectedCreatePath;
function safety(service) {
  assert.equal(service.build, undefined, 'A registry deployment must not build/tag local source implicitly');
  assert.equal(service.pull_policy, undefined, 'Do not force a host-only image or implicit image pulls');
  assert.equal(service.stop_grace_period, '30s');
  assert.equal(service.labels['com.centurylinklabs.watchtower.enable'], 'false');
  assert.equal(service.environment.DB_PATH, '/app/data/cardlistcompare.db');
  assert.equal(service.volumes.length, 1);
  assert.equal(service.volumes[0].type, 'bind');
  assert.equal(service.volumes[0].target, '/app/data');
  // Compose versions serialize boolean defaults differently. Compare against a
  // minimal explicit-false reference rendered by this same CLI, then prove the
  // opposite (auto-creating) fixture cannot satisfy this check.
  assert.equal(service.volumes[0].bind?.create_host_path, expectedCreatePath,
    'A typo must not silently create a fresh data directory');
  for (const [key, value] of Object.entries(secrets)) assert.equal(service.environment[key], value);
}
try {
  const reference = join(fixture, 'safe-bind.yaml');
  writeFileSync(reference, 'services:\n  card-list-compare:\n    image: busybox:unused\n    volumes:\n      - type: bind\n        source: ${CLC_DATA_DIR}\n        target: /app/data\n        bind:\n          create_host_path: false\n');
  expectedCreatePath = configuration({ CLC_DATA_DIR: fixture }, reference).volumes[0].bind?.create_host_path;
  const defaults = configuration();
  safety(defaults);
  assert.equal(defaults.image, 'ghcr.io/cruv/card-list-compare:latest');
  assert.equal(defaults.environment.PRINT_ENABLED, 'true');
  assert.equal(defaults.environment.PRINT_STORAGE_MAX_MB, '10240');
  assert.equal(defaults.environment.PRINT_ALLOWED_USER_IDS, '');
  assert.equal(defaults.ports[0].published, '8080');

  const data = join(fixture, 'existing data with spaces');
  mkdirSync(data);
  const existing = configuration({ CLC_DATA_DIR: data, CLC_CONTAINER_NAME: 'FixtureExistingCLC',
    CLC_PORT: '18083', TZ: 'America/Indiana/Indianapolis', PUID: '1001', PGID: '1002',
    PRINT_ALLOWED_USER_IDS: '2,4', PRINT_STORAGE_MAX_MB: '20480', APP_URL: 'https://clc.example.test' });
  safety(existing);
  assert.equal(existing.volumes[0].source, data);
  assert.equal(existing.container_name, 'FixtureExistingCLC');
  assert.equal(existing.ports[0].published, '18083');
  assert.equal(existing.environment.TZ, 'America/Indiana/Indianapolis');
  assert.equal(existing.environment.PUID, '1001');
  assert.equal(existing.environment.PGID, '1002');
  assert.equal(existing.environment.PRINT_ALLOWED_USER_IDS, '2,4');
  assert.equal(existing.environment.PRINT_STORAGE_MAX_MB, '20480');
  assert.equal(existing.environment.APP_URL, 'https://clc.example.test');

  const image = `ghcr.io/cruv/card-list-compare@sha256:${'a'.repeat(64)}`;
  const pinned = configuration({ CLC_IMAGE: image, CLC_DATA_DIR: data });
  safety(pinned);
  assert.equal(pinned.image, image);
  const unsafeFile = join(fixture, 'unsafe-compose.yaml');
  const source = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  assert.ok(source.includes('create_host_path: false'), 'The canonical contract must explicitly disable directory creation');
  writeFileSync(unsafeFile, source.replace('create_host_path: false', 'create_host_path: true'));
  assert.throws(() => safety(configuration({ CLC_DATA_DIR: data }, unsafeFile)), /must not silently create/,
    'The checker must reject an unsafe auto-creating bind on every Compose version');
  console.log('Deployment contract passed: defaults, existing data/configuration, exact registry digest, unsafe bind rejected. No live services accessed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
