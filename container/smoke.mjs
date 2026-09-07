#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from '../e2e/support/managed-command.mts';
import { join, resolve } from 'node:path';
import {
  E2E_SESSION_ENV,
  readSession,
  removeSession,
  sessionFileFor,
  writeSession,
} from '../e2e/support/session.mts';

const root = resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== '--image' ||
    !/^sha256:[a-f0-9]{64}$/.test(argv[1])
  ) {
    throw new Error(
      'Usage: node container/smoke.mjs --image <immutable sha256 image ID>',
    );
  }
  return { image: argv[1] };
}

async function command(
  name,
  args,
  { allowFailure = false, environment, timeout = 60_000, cleanup = false } = {},
) {
  const prefix = join(logDirectory, String(++commandCount).padStart(3, '0'));
  writeFileSync(prefix + '.command.txt', [name, ...args].join(' ') + '\n');
  const stdoutFile = prefix + '.stdout.log';
  const stderrFile = prefix + '.stderr.log';
  const stdout = openSync(stdoutFile, 'w');
  const stderr = openSync(stderrFile, 'w');
  let result;
  try {
    result = await runManagedCommand(name, args, {
      cwd: root,
      environment: { ...process.env, ...environment },
      timeout,
      signal: cleanup ? undefined : termination.signal,
      stdio: ['ignore', stdout, stderr],
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const output = {
    ...result,
    stdout: (await readFile(stdoutFile, 'utf8')).trim(),
    stderr: (await readFile(stderrFile, 'utf8')).trim(),
  };
  if (output.status !== 0 && !allowFailure) {
    throw new Error(
      name +
        ' failed (' +
        output.status +
        '): ' +
        (output.stderr ||
          output.stdout ||
          output.error?.message ||
          'interrupted'),
    );
  }
  return output;
}

async function inspect(container) {
  const result = await command('docker', ['inspect', container]);
  const value = JSON.parse(result.stdout)[0];
  const host = value.HostConfig;
  const config = value.Config;
  if (config.Labels?.['org.opencontainers.image.licenses'] !== 'MIT')
    throw new Error('container OCI license must be MIT');
  const image = JSON.parse(
    (await command('docker', ['image', 'inspect', value.Image])).stdout,
  )[0];
  const daemonArch = (
    await command('docker', ['info', '--format', '{{.Architecture}}'])
  ).stdout;
  if (
    image.Os !== 'linux' ||
    image.Architecture !== 'amd64' ||
    !['x86_64', 'amd64'].includes(daemonArch)
  )
    throw new Error('container smoke requires native Linux amd64');
  if (!/^(?:sws|[1-9][0-9]*)$/.test(String(config.User ?? '')))
    throw new Error(
      `container must run as non-root sws user (got ${JSON.stringify(config.User)})`,
    );
  if (host.ReadonlyRootfs !== true)
    throw new Error('container root filesystem is writable');
  if (!host.CapDrop?.some((entry) => entry === 'ALL'))
    throw new Error('container does not drop all capabilities');
  if (!host.SecurityOpt?.some((entry) => entry === 'no-new-privileges'))
    throw new Error('container does not enable no-new-privileges');
  if (
    host.Binds?.length ||
    host.Mounts?.length ||
    value.Mounts?.length ||
    Object.keys(host.Tmpfs ?? {}).length
  )
    throw new Error('container has an unexpected mount or tmpfs');
  if (value.State?.Status !== 'running')
    throw new Error(
      `container exited before readiness (${value.State?.Status ?? 'unknown'})`,
    );
  const uid = await command('docker', ['exec', container, 'id', '-u']);
  const gid = await command('docker', ['exec', container, 'id', '-g']);
  if (uid.stdout !== '1000' || gid.stdout !== '1000')
    throw new Error(
      `container must run as UID:GID 1000:1000 (got ${uid.stdout}:${gid.stdout})`,
    );
  return value;
}

async function assertStaticCaching(baseURL, manifest) {
  const fixed = new Set([
    'index.html',
    'ngsw.json',
    'ngsw-worker.js',
    'safety-worker.js',
    'worker-basic.min.js',
    'manifest.webmanifest',
    'favicon.ico',
  ]);
  for (const path of manifest.files.map((file) => file.path)) {
    if (path.startsWith('assets/icons/')) fixed.add(path);
  }
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const path of fixed) {
    if (!manifestPaths.has(path)) continue;
    const expected = await readFile(join(root, 'www', path));
    const response = await assertResponse(`${baseURL}/${path}`, 200, path);
    if (header(response, 'cache-control') !== 'no-cache')
      throw new Error(`${path} must use exact no-cache revalidation`);
    if (!Buffer.from(await response.arrayBuffer()).equals(expected))
      throw new Error(`${path} response differs from the verified renderer`);
  }
  const hashed = manifest.files.filter(
    (file) =>
      !file.path.includes('/') &&
      /\.(?:js|css)$/u.test(file.path) &&
      !fixed.has(file.path),
  );
  for (const asset of hashed) {
    if (!/^[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u.test(asset.path))
      throw new Error(`unexpected root bundle filename: ${asset.path}`);
  }
  if (!hashed.some((file) => file.path.endsWith('.js')))
    throw new Error('verified renderer has no hashed JS bundle');
  if (!hashed.some((file) => file.path.endsWith('.css')))
    throw new Error('verified renderer has no hashed CSS bundle');
  for (const asset of hashed) {
    const expected = await readFile(join(root, 'www', asset.path));
    const response = await assertResponse(
      `${baseURL}/${asset.path}`,
      200,
      asset.path,
    );
    if (
      header(response, 'cache-control') !==
      'public, max-age=31536000, immutable'
    )
      throw new Error(`${asset.path} must use exact immutable caching`);
    if (!Buffer.from(await response.arrayBuffer()).equals(expected))
      throw new Error(
        `${asset.path} response differs from the verified renderer`,
      );
  }
}

async function verifyImagePayload(container, manifest) {
  const extracted = await mkdtemp(join(root, 'dist', 'web-container-smoke-'));
  try {
    await command('docker', [
      'cp',
      `${container}:/home/sws/public/.`,
      extracted,
    ]);
    await command(process.execPath, [
      'scripts/web-bundle-manifest.mjs',
      'verify',
      'dist/web-bundle-manifest.json',
      extracted,
    ]);
  } finally {
    await rm(extracted, { force: true, recursive: true });
  }
}

function header(response, name) {
  return response.headers.get(name) ?? '';
}

async function assertResponse(url, expectedStatus, label, checks = {}) {
  const response = await fetch(url, {
    headers: checks.requestHeaders,
    signal: AbortSignal.any([termination.signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status !== expectedStatus)
    throw new Error(
      `${label}: expected ${expectedStatus}, got ${response.status}`,
    );
  for (const [name, expected] of Object.entries(checks.headers ?? {})) {
    if (header(response, name) !== expected)
      throw new Error(
        `${label}: ${name} was ${JSON.stringify(header(response, name))}, expected ${JSON.stringify(expected)}`,
      );
  }
  return response;
}

async function assertHttpContract(baseURL, indexBytes, wasmBytes) {
  const security = {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  const rootResponse = await assertResponse(`${baseURL}/`, 200, 'root', {
    headers: security,
  });
  const rootBytes = Buffer.from(await rootResponse.arrayBuffer());
  if (!rootBytes.equals(indexBytes))
    throw new Error('root response does not exactly match verified index.html');
  if (!/^no-cache(?:,|$)/.test(header(rootResponse, 'cache-control')))
    throw new Error('root must use the revalidation/no-cache cache policy');

  for (const path of [
    '/login',
    '/register',
    '/sso-callback',
    '/rooms',
    '/settings',
    '/settings/profile',
    '/settings/presence',
    '/settings/devices',
    '/settings/account',
    '/settings/appearance',
    '/settings/security',
    '/settings/notifications',
    '/settings/privacy',
    '/settings/server',
    '/settings/gifs',
    '/settings/stickers',
    '/settings/shortcuts',
    '/settings/experimental',
    '/settings/advanced',
    '/rooms/AbCd_012-xyz',
    '/encryption/setup',
    '/encryption/unlock',
    '/encryption/verify',
  ]) {
    const response = await assertResponse(`${baseURL}${path}`, 200, path, {
      headers: security,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.equals(indexBytes))
      throw new Error(`${path} does not serve the exact index.html bytes`);
  }
  for (const path of [
    '/legacy-room-link',
    '/unknown/not-a-route',
    '/settings/notreal',
    '/rooms/a/b',
    '/rooms/a.html',
    '/rooms/a.jpg',
    '/rooms/a.txt',
  ]) {
    const response = await assertResponse(`${baseURL}${path}`, 404, path, {
      headers: security,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    // SWS v2.44.0 trims custom error pages in src/error_page.rs; the copied file remains exact.
    if (bytes.toString('utf8') !== indexBytes.toString('utf8').trim())
      throw new Error(
        `${path} did not return the custom 404 application shell`,
      );
  }
  for (const path of [
    '/missing.js',
    '/assets/missing.css',
    '/assets/missing.wasm',
    '/assets/missing.png',
    '/rooms/no.js',
    '/settings/no.css',
  ])
    await assertResponse(`${baseURL}${path}`, 404, path, { headers: security });

  const wasm = await assertResponse(
    `${baseURL}/assets/crypto/matrix_sdk_crypto_wasm_bg.wasm`,
    200,
    'crypto WASM',
    { headers: security },
  );
  if (header(wasm, 'content-type') !== 'application/wasm')
    throw new Error('crypto WASM must use application/wasm');
  if (header(wasm, 'cache-control').includes('immutable'))
    throw new Error('fixed-name crypto WASM must be revalidated');
  if (!Buffer.from(await wasm.arrayBuffer()).equals(wasmBytes))
    throw new Error(
      'crypto WASM response does not match the verified renderer bytes',
    );
  for (const encoding of ['br', 'gzip', 'zstd']) {
    const response = await assertResponse(
      `${baseURL}/`,
      200,
      `${encoding} compression`,
      { requestHeaders: { 'accept-encoding': encoding } },
    );
    if (header(response, 'content-encoding') !== encoding)
      throw new Error(`${encoding} compression was not negotiated`);
  }
  // SWS's built-in health endpoint returns before the application header pipeline.
  await assertResponse(`${baseURL}/health`, 200, 'health');
}

async function runPwa(baseURL) {
  const parentSession = readSession();
  const childSessionFile = sessionFileFor(
    root,
    `${parentSession.id}-container-${process.pid}`,
  );
  writeSession(childSessionFile, {
    ...parentSession,
    endpoints: { ...parentSession.endpoints, application: baseURL },
  });
  let result;
  try {
    result = await command(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        '-c',
        'e2e/web/playwright.container.config.mts',
      ],
      {
        allowFailure: true,
        environment: { [E2E_SESSION_ENV]: childSessionFile },
        timeout: 600_000,
      },
    );
  } finally {
    removeSession(childSessionFile);
  }
  if (result.stdout) console.log(result.stdout);
  if (result.status !== 0)
    throw new Error(
      `container PWA smoke failed (${result.status})\n${result.stderr || result.stdout}`,
    );
}

const options = parseArgs(process.argv.slice(2));
const parentSession = readSession();
const logDirectory = join(
  root,
  'dist/.playwright/trinity-e2e-web',
  parentSession.id,
  'web.container',
  'host',
);
mkdirSync(logDirectory, { recursive: true });
const termination = createProcessTerminationScope();
let commandCount = 0;
const name = `trinity-container-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;
let creationAttempted = false;
let baseURL;
const manifestPath = join(root, 'dist', 'web-bundle-manifest.json');
const manifestBefore = await readFile(manifestPath);
const statusBefore = (
  await command('git', ['status', '--porcelain', '--untracked-files=all'])
).stdout;
const diffBefore = (await command('git', ['diff', '--binary', 'HEAD'])).stdout;
const stagedDiffBefore = (
  await command('git', ['diff', '--cached', '--binary', 'HEAD'])
).stdout;
const rendererProofBefore = (
  await command(process.execPath, [
    'scripts/web-bundle-manifest.mjs',
    'verify',
    manifestPath,
    'www',
  ])
).stdout;
try {
  const manifest = JSON.parse(manifestBefore);
  const indexBytes = await readFile(join(root, 'www/index.html'));
  const wasmBytes = await readFile(
    join(root, 'www', 'assets/crypto/matrix_sdk_crypto_wasm_bg.wasm'),
  );
  const requestedPort = '127.0.0.1::8080';
  // Keep the stopped container until the diagnostics block has read its logs. The finally block
  // removes it on both pass and failure, so a failed startup cannot erase the useful error.
  creationAttempted = true;
  const started = await command('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    requestedPort,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    options.image,
  ]);
  const inspected = await inspect(name);
  const publishedPort =
    inspected.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort;
  if (!publishedPort) throw new Error('container did not publish port 8080');
  baseURL = `http://127.0.0.1:${publishedPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    termination.signal.throwIfAborted();
    try {
      const response = await fetch(`${baseURL}/health`, {
        signal: AbortSignal.any([
          termination.signal,
          AbortSignal.timeout(1_000),
        ]),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (!ready)
    throw new Error(`container did not become healthy (${started.stdout})`);
  await assertHttpContract(baseURL, indexBytes, wasmBytes);
  await assertStaticCaching(baseURL, manifest);
  await verifyImagePayload(name, manifest);
  await runPwa(baseURL);
  if (!manifestBefore.equals(await readFile(manifestPath)))
    throw new Error('renderer manifest changed during container smoke');
  const statusAfter = (
    await command('git', ['status', '--porcelain', '--untracked-files=all'])
  ).stdout;
  if (statusAfter !== statusBefore)
    throw new Error('working tree changed during container smoke');
  if (
    (await command('git', ['diff', '--binary', 'HEAD'])).stdout !== diffBefore
  )
    throw new Error(
      'tracked working-tree content changed during container smoke',
    );
  if (
    (await command('git', ['diff', '--cached', '--binary', 'HEAD'])).stdout !==
    stagedDiffBefore
  )
    throw new Error(
      'staged working-tree content changed during container smoke',
    );
  const rendererProofAfter = (
    await command(process.execPath, [
      'scripts/web-bundle-manifest.mjs',
      'verify',
      manifestPath,
      'www',
    ])
  ).stdout;
  if (rendererProofAfter !== rendererProofBefore)
    throw new Error('verified renderer content changed during container smoke');
  console.log(`container smoke passed: ${options.image} (${baseURL})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (creationAttempted) {
    const logs = await command('docker', ['logs', name], {
      allowFailure: true,
      cleanup: true,
      timeout: 10_000,
    });
    if (logs.stdout || logs.stderr)
      console.error(
        `\n--- container diagnostics ---\n${logs.stdout}\n${logs.stderr}`,
      );
  }
  process.exitCode = 1;
} finally {
  if (creationAttempted) {
    // Docker may create the container before its CLI fails or is interrupted.
    // Listing succeeds with no output when creation never reached the daemon.
    const existing = await command(
      'docker',
      [
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.ID}}',
      ],
      {
        allowFailure: true,
        cleanup: true,
        timeout: 15_000,
      },
    );
    if (existing.status !== 0) {
      console.error(`failed to inspect smoke container for cleanup ${name}`);
      process.exitCode = 1;
    } else if (existing.stdout) {
      const cleanup = await command('docker', ['rm', '--force', name], {
        allowFailure: true,
        cleanup: true,
        timeout: 15_000,
      });
      if (cleanup.status !== 0) {
        console.error(`failed to clean up smoke container ${name}`);
        process.exitCode = 1;
      }
    }
  }
  termination.close();
}
