// The native homeserver runtime (TRINITY_E2E_HOMESERVER_RUNTIME=native): Synapse from a
// pinned venv and Caddy run as detached host processes, for hosts without Docker (the
// macOS runner the iOS suite needs). Primary server only: no Dex, no federated secondary.
// Detached like Compose containers: a run that dies leaves them up, and the PID file is
// how the lease notices them and stop.mjs removes them.
import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** The Synapse the Docker stack runs (synapse/docker-compose.yml); a test keeps them equal. */
export const SYNAPSE_VERSION = '1.161.0';
export const NATIVE_SERVICES = ['homeserver', 'caddy'] as const;
export type NativeService = (typeof NATIVE_SERVICES)[number];

export interface NativePaths {
  readonly data: string;
  readonly venv: string;
  readonly python: string;
  readonly config: string;
  readonly caddyfile: string;
  readonly pidFile: string;
  readonly logs: Readonly<Record<NativeService, string>>;
  readonly caddyData: string;
  readonly caddyConfig: string;
  readonly caddyRoot: string;
}

/**
 * The venv sits beside ./data rather than in it, so stop.mjs keeps it and the next run
 * skips the pip install. Everything else is per-run state that stop.mjs deletes.
 */
export function nativePaths(stateDir: string, dataDir: string): NativePaths {
  const venv = join(stateDir, 'native-venv');
  const caddyData = join(dataDir, 'caddy-data');
  return {
    data: dataDir,
    venv,
    python: join(venv, 'bin', 'python'),
    config: join(dataDir, 'homeserver.yaml'),
    caddyfile: join(dataDir, 'Caddyfile.native'),
    pidFile: join(dataDir, 'native-pids.json'),
    logs: {
      homeserver: join(dataDir, 'synapse.out.log'),
      caddy: join(dataDir, 'caddy.log'),
    },
    caddyData,
    caddyConfig: join(dataDir, 'caddy-config'),
    // Caddy honours XDG_DATA_HOME on every OS; its local CA lives under it.
    caddyRoot: join(
      caddyData,
      'caddy',
      'pki',
      'authorities',
      'local',
      'root.crt',
    ),
  };
}

/** The process operations the runtime needs; tests substitute a fake process table. */
export interface NativeProcessApi {
  exec(
    file: string,
    args: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly stdout: string }>;
  /** Start a detached process group logging to `logFile`; returns its PID. */
  spawnDetached(
    file: string,
    args: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly logFile: string },
  ): number;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
}

const execFileAsync = promisify(execFile);

export const nodeProcessApi: NativeProcessApi = {
  async exec(file, args, options = {}) {
    const { stdout } = await execFileAsync(file, [...args], {
      signal: options.signal,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout };
  },
  spawnDetached(file, args, { env, logFile }) {
    const log = openSync(logFile, 'a');
    try {
      const child = spawn(file, [...args], {
        detached: true,
        env,
        stdio: ['ignore', log, log],
      });
      // A missing executable reports asynchronously; the undefined pid is the signal here.
      child.once('error', () => undefined);
      if (child.pid === undefined) throw new Error(`could not start ${file}`);
      child.unref();
      return child.pid;
    } finally {
      closeSync(log);
    }
  },
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

const SYNAPSE_VERSION_PROBE = 'import synapse; print(synapse.__version__)';

/** Create the venv once and (re)install Synapse only when the pin changed. */
export async function ensureSynapseVenv(
  paths: NativePaths,
  api: NativeProcessApi,
  {
    signal,
    log,
  }: { readonly signal?: AbortSignal; readonly log: (message: string) => void },
): Promise<void> {
  if (!existsSync(paths.python)) {
    log(`creating the Synapse venv at ${paths.venv}…`);
    await api.exec('python3', ['-m', 'venv', paths.venv], { signal });
  }
  const installed = await api
    .exec(paths.python, ['-c', SYNAPSE_VERSION_PROBE], { signal })
    .then(
      ({ stdout }) => stdout.trim(),
      () => '',
    );
  if (installed === SYNAPSE_VERSION) return;
  log(`installing Synapse ${SYNAPSE_VERSION} (found ${installed || 'none'})…`);
  // url-preview: the shared config patch enables previews, which need lxml.
  await api.exec(
    paths.python,
    [
      '-m',
      'pip',
      'install',
      '--quiet',
      `matrix-synapse[url-preview]==${SYNAPSE_VERSION}`,
    ],
    { signal },
  );
}

/** Synapse's own `--generate-config`, the native counterpart of the image's `generate`. */
export async function generateSynapseConfig(
  paths: NativePaths,
  serverName: string,
  api: NativeProcessApi,
  signal?: AbortSignal,
): Promise<void> {
  await api.exec(
    paths.python,
    [
      '-m',
      'synapse.app.homeserver',
      '--server-name',
      serverName,
      '--config-path',
      paths.config,
      '--data-directory',
      paths.data,
      '--generate-config',
      '--report-stats=no',
    ],
    { signal },
  );
}

/**
 * The shared Caddyfile's https://localhost:8448 site, verbatim, under native-only global
 * options. The other sites serve the secondary server, federation and the link-preview
 * page, none of which run natively, and :443 cannot be bound unprivileged on Linux.
 */
export function nativeCaddyfile(shared: string): string {
  const site = /^https:\/\/localhost:8448 \{\n[\s\S]*?^\}$/mu.exec(shared)?.[0];
  if (!site)
    throw new Error('the shared Caddyfile has no https://localhost:8448 site');
  return [
    '# Generated by e2e/support/homeserver/native.mts from the shared Caddyfile.',
    '{',
    // Another Caddy (another worktree) may own the default :2019 admin port.
    '\tadmin off',
    // Never touch the host trust store; the iOS runner trusts the root in the Simulator.
    '\tskip_install_trust',
    '\tauto_https disable_redirects',
    '}',
    '',
    site,
    '',
  ].join('\n');
}

const unreadable = (pidFile: string): Error =>
  new Error(
    `unreadable native PID file ${pidFile}; stop the processes it named, then delete it`,
  );

/** The recorded PIDs; {} when there is no PID file. A malformed file is an error. */
export function readNativePids(
  pidFile: string,
): Partial<Record<NativeService, number>> {
  let text: string;
  try {
    text = readFileSync(pidFile, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable(pidFile);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unreadable(pidFile);
  }
  const pids: Partial<Record<NativeService, number>> = {};
  for (const service of NATIVE_SERVICES) {
    const pid = (parsed as Record<string, unknown>)[service];
    if (pid === undefined) continue;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      throw unreadable(pidFile);
    }
    pids[service] = pid;
  }
  return pids;
}

function isAlive(api: NativeProcessApi, pid: number): boolean {
  try {
    api.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ponytail: a PID file that outlives a reboot can name a reused PID; the lease error names
// the file, and deleting it is the fix. Store process start times if that ever bites.
export function runningNativeServices(
  pidFile: string,
  api: NativeProcessApi,
): NativeService[] {
  return Object.entries(readNativePids(pidFile))
    .filter(([, pid]) => pid !== undefined && isAlive(api, pid))
    .map(([service]) => service as NativeService);
}

/** Spawn Synapse, then Caddy, recording each PID as soon as it exists. */
export function startNativeServices(
  paths: NativePaths,
  api: NativeProcessApi,
  env: NodeJS.ProcessEnv,
): void {
  const pids: Partial<Record<NativeService, number>> = {};
  const record = (): void =>
    writeFileSync(paths.pidFile, `${JSON.stringify(pids)}\n`);
  pids.homeserver = api.spawnDetached(
    paths.python,
    ['-m', 'synapse.app.homeserver', '-c', paths.config],
    { env, logFile: paths.logs.homeserver },
  );
  record();
  pids.caddy = api.spawnDetached(
    'caddy',
    ['run', '--config', paths.caddyfile, '--adapter', 'caddyfile'],
    {
      env: {
        ...env,
        XDG_DATA_HOME: paths.caddyData,
        XDG_CONFIG_HOME: paths.caddyConfig,
        TRINITY_E2E_HOMESERVER_UPSTREAM: 'localhost:8008',
      },
      logFile: paths.logs.caddy,
    },
  );
  record();
}

/** SIGTERM each recorded process group, SIGKILL what outlives the grace period. */
export async function stopNativeServices(
  pidFile: string,
  api: NativeProcessApi,
  {
    graceMs = 10_000,
    pollMs = 100,
    signal,
  }: {
    readonly graceMs?: number;
    readonly pollMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  const pids = Object.values(readNativePids(pidFile)).filter(
    (pid): pid is number => pid !== undefined,
  );
  const signalGroups = (name: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        api.kill(-pid, name);
      } catch {
        /* the group already exited */
      }
    }
  };
  const anyAlive = (): boolean => pids.some((pid) => isAlive(api, pid));
  const waitForExit = async (ms: number, abortable: boolean): Promise<void> => {
    const deadline = Date.now() + ms;
    while (
      anyAlive() &&
      Date.now() < deadline &&
      !(abortable && signal?.aborted)
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  if (pids.length > 0) {
    signalGroups('SIGTERM');
    await waitForExit(graceMs, true);
    if (anyAlive()) {
      signalGroups('SIGKILL');
      await waitForExit(2_000, false);
    }
    const survivors = pids.filter((pid) => isAlive(api, pid));
    if (survivors.length > 0) {
      throw new Error(
        `native homeserver processes survived SIGKILL: ${survivors.join(', ')}`,
      );
    }
  }
  rmSync(pidFile, { force: true });
}

/** The last lines a native service wrote — the evidence a readiness timeout is missing. */
export function nativeLogTail(
  paths: NativePaths,
  service: string,
  lines = 80,
): string {
  const file = (paths.logs as Record<string, string | undefined>)[service];
  if (!file || !existsSync(file)) return `(no ${service} log)`;
  return readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .slice(-lines)
    .join('\n');
}
