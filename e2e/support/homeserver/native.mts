// The native homeserver runtime (TRINITY_E2E_HOMESERVER_RUNTIME=native): Synapse from a
// pinned venv and Caddy run as detached host processes, for hosts without Docker (the
// macOS runner the iOS suite needs). Dex joins them when a `dex` binary is on PATH
// (`brew install dexidp`), which turns SSO on, and Mailpit when a `mailpit` binary is
// (`brew install mailpit`), which turns mail on; with mail, Sydent from its own pinned
// venv turns the identity server on. Primary server only: no federated secondary.
// Detached like Compose containers: a run that dies leaves them up, and the PID file is
// how the lease notices them and stop.mjs removes them.
import { execFile, execFileSync, spawn } from 'node:child_process';
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
import { offsetPorts, PORT_OFFSET, PORTS } from './constants.mjs';

/** The Synapse the Docker stack runs (synapse/docker-compose.yml); a test keeps them equal. */
export const SYNAPSE_VERSION = '1.164.1';
/** The Sydent the Docker stack runs (synapse/docker-compose.yml); a test keeps them equal. */
export const SYDENT_VERSION = '2.6.1';
export const NATIVE_SERVICES = [
  'homeserver',
  'caddy',
  'dex',
  'mailpit',
  'sydent',
] as const;
export type NativeService = (typeof NATIVE_SERVICES)[number];

export interface NativePaths {
  readonly data: string;
  readonly venv: string;
  readonly python: string;
  /** Sydent's own venv, kept between runs like the Synapse one. */
  readonly sydentVenv: string;
  readonly sydentPython: string;
  readonly config: string;
  readonly caddyfile: string;
  /** The shared dex.yaml, bound to loopback; written only when Dex runs. */
  readonly dexConfig: string;
  readonly pidFile: string;
  readonly logs: Readonly<Record<NativeService, string>>;
  /** Synapse's own file log (its generated log config), beside homeserver.yaml. */
  readonly homeserverLog: string;
  /** Caddy's request log for the 8448 site (no headers). */
  readonly caddyAccessLog: string;
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
  const sydentVenv = join(stateDir, 'native-sydent-venv');
  const caddyData = join(dataDir, 'caddy-data');
  return {
    data: dataDir,
    venv,
    python: join(venv, 'bin', 'python'),
    sydentVenv,
    sydentPython: join(sydentVenv, 'bin', 'python'),
    config: join(dataDir, 'homeserver.yaml'),
    caddyfile: join(dataDir, 'Caddyfile.native'),
    dexConfig: join(dataDir, 'dex.native.yaml'),
    pidFile: join(dataDir, 'native-pids.json'),
    logs: {
      homeserver: join(dataDir, 'synapse.out.log'),
      caddy: join(dataDir, 'caddy.log'),
      dex: join(dataDir, 'dex.log'),
      mailpit: join(dataDir, 'mailpit.log'),
      sydent: join(dataDir, 'sydent.log'),
    },
    homeserverLog: join(dataDir, 'homeserver.log'),
    caddyAccessLog: join(dataDir, 'caddy-access.log'),
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
    options?: { readonly signal?: AbortSignal; readonly cwd?: string },
  ): Promise<{ readonly stdout: string }>;
  /** Start a detached process group logging to `logFile`; returns its PID. */
  spawnDetached(
    file: string,
    args: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly logFile: string },
  ): number;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /** The full command line of a live process; '' when it is gone or unreadable. */
  commandOf(pid: number): string;
}

const execFileAsync = promisify(execFile);

export const nodeProcessApi: NativeProcessApi = {
  async exec(file, args, options = {}) {
    const { stdout } = await execFileAsync(file, [...args], {
      signal: options.signal,
      cwd: options.cwd,
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
  commandOf(pid) {
    try {
      // `ps -o command= -p` behaves the same on Linux and macOS.
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  },
};

// authlib comes with the `oidc` extra; a venv from before it had none, so it reinstalls.
// The package metadata, not `synapse.__version__`: inside a git checkout (this one) Synapse
// appends the branch and commit to that, which never equals the pin.
const SYNAPSE_VERSION_PROBE =
  'import authlib; from importlib.metadata import version; print(version("matrix-synapse"))';

// Sydent 2.6.1 signs and verifies requests whose `method` is bytes, which canonicaljson 2
// refuses: the pin is its own lockfile's. It imports prometheus_client unconditionally,
// which only its `prometheus` extra installs.
const SYDENT_CANONICALJSON = '1.5.0';
const SYDENT_VERSION_PROBE =
  'import prometheus_client; from importlib.metadata import version; print(version("matrix-sydent"), version("canonicaljson"))';

interface VenvOptions {
  readonly signal?: AbortSignal;
  readonly log: (message: string) => void;
}

/** Create a venv once and (re)install its package only when the pin changed. */
async function ensureVenv(
  api: NativeProcessApi,
  venv: { readonly dir: string; readonly python: string },
  pin: {
    readonly name: string;
    readonly version: string;
    readonly probe: string;
    /** What the probe prints once the pins are installed. */
    readonly installed: string;
    readonly requirements: readonly string[];
  },
  { signal, log }: VenvOptions,
): Promise<void> {
  if (!existsSync(venv.python)) {
    log(`creating the ${pin.name} venv at ${venv.dir}…`);
    await api.exec('python3', ['-m', 'venv', venv.dir], { signal });
  }
  const installed = await api
    .exec(venv.python, ['-c', pin.probe], { signal })
    .then(
      ({ stdout }) => stdout.trim(),
      () => '',
    );
  if (installed === pin.installed) return;
  log(`installing ${pin.name} ${pin.version} (found ${installed || 'none'})…`);
  await api.exec(
    venv.python,
    ['-m', 'pip', 'install', '--quiet', ...pin.requirements],
    { signal },
  );
}

/** Create the venv once and (re)install Synapse only when the pin changed. */
export function ensureSynapseVenv(
  paths: NativePaths,
  api: NativeProcessApi,
  options: VenvOptions,
): Promise<void> {
  return ensureVenv(
    api,
    { dir: paths.venv, python: paths.python },
    {
      name: 'Synapse',
      version: SYNAPSE_VERSION,
      probe: SYNAPSE_VERSION_PROBE,
      installed: SYNAPSE_VERSION,
      // url-preview: the shared config patch enables previews, which need lxml. oidc: the
      // Dex provider block, which Synapse refuses to load without authlib.
      requirements: [`matrix-synapse[url-preview,oidc]==${SYNAPSE_VERSION}`],
    },
    options,
  );
}

/** The same for Sydent, in its own venv: its pins conflict with nothing of Synapse's. */
export function ensureSydentVenv(
  paths: NativePaths,
  api: NativeProcessApi,
  options: VenvOptions,
): Promise<void> {
  return ensureVenv(
    api,
    { dir: paths.sydentVenv, python: paths.sydentPython },
    {
      name: 'Sydent',
      version: SYDENT_VERSION,
      probe: SYDENT_VERSION_PROBE,
      installed: `${SYDENT_VERSION} ${SYDENT_CANONICALJSON}`,
      requirements: [
        `matrix-sydent[prometheus]==${SYDENT_VERSION}`,
        `canonicaljson==${SYDENT_CANONICALJSON}`,
      ],
    },
    options,
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
    // Synapse bakes `homeserver.log` into the log config relative to its cwd, not the
    // config: run in the data directory so the log lands where nativePaths says.
    { signal, cwd: paths.data },
  );
}

/**
 * The shared Caddyfile's https://localhost:8448, identity server (8452) and link-preview
 * (:8080) sites, verbatim but for TRINITY_E2E_PORT_OFFSET, under native-only global options;
 * `default_bind` keeps them on loopback. The other sites serve the secondary server and federation, which do not run
 * natively, and :443 cannot be bound unprivileged on Linux.
 */
export function nativeCaddyfile(shared: string, accessLog: string): string {
  const siteOf = (address: string, label = address): string => {
    const escaped = address.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
    const found = new RegExp(`^${escaped} \\{\\n[\\s\\S]*?^\\}$`, 'mu').exec(
      shared,
    )?.[0];
    if (!found) throw new Error(`the shared Caddyfile has no ${label} site`);
    return found;
  };
  const site = siteOf('https://localhost:8448');
  const preview = siteOf(':8080', ':8080 link-preview');
  const identity = siteOf('https://localhost:8452');
  return offsetPorts(
    [
      '# Generated by e2e/support/homeserver/native.mts from the shared Caddyfile.',
      '{',
      // Another Caddy (another worktree) may own the default :2019 admin port.
      '\tadmin off',
      // Never touch the host trust store; the iOS runner trusts the root in the Simulator.
      '\tskip_install_trust',
      // Go logs failed or abandoned TLS handshakes ("TLS handshake error from …") at debug.
      '\tdebug',
      '\tauto_https disable_redirects',
      // As in the shared Caddyfile: Synapse calls the identity server without SNI.
      '\tdefault_sni localhost',
      // Docker publishes 127.0.0.1:8448 only; the LAN must not reach the admin API.
      '\tdefault_bind 127.0.0.1 [::1]',
      // TCP only, as Docker publishes it: HTTP/3 advertised over Alt-Svc makes WebKit race QUIC.
      '\tservers {',
      '\t\tprotocols h1 h2',
      '\t}',
      '}',
      '',
      site.replace(
        /\{\n/u,
        // Method, URI, status and duration only: no headers, so no bearer tokens.
        `{\n\tlog {\n\t\toutput file ${accessLog}\n\t\tformat filter {\n\t\t\twrap json\n\t\t\tfields {\n\t\t\t\trequest>headers delete\n\t\t\t\tresp_headers delete\n\t\t\t}\n\t\t}\n\t}\n`,
      ),
      '',
      identity,
      '',
      preview,
      '',
    ].join('\n'),
  );
}

/** The Caddy TLS port a homeserver.yaml was set up for, or null when it names none yet. */
export function configuredTlsPort(config: string): number | null {
  const port = /^public_baseurl: "https:\/\/localhost:(\d+)\/"$/mu.exec(
    config,
  )?.[1];
  return port === undefined ? null : Number(port);
}

/** The installed Dex's version line, or null when there is no `dex` on PATH. */
export async function nativeDexVersion(
  api: NativeProcessApi,
  signal?: AbortSignal,
): Promise<string | null> {
  return api.exec('dex', ['version'], { signal }).then(
    ({ stdout }) => /^Dex Version: (.+)$/mu.exec(stdout)?.[1]?.trim() ?? null,
    () => null,
  );
}

/** The installed Mailpit's version, or null when there is no `mailpit` on PATH. */
export async function nativeMailpitVersion(
  api: NativeProcessApi,
  signal?: AbortSignal,
): Promise<string | null> {
  // Without the flag it asks GitHub for the latest release, and fails when offline.
  return api
    .exec('mailpit', ['version', '--no-release-check'], { signal })
    .then(
      ({ stdout }) => /\b(v\d+\.\d+\.\d+\S*)/u.exec(stdout)?.[1] ?? 'unknown',
      () => null,
    );
}

/**
 * The shared dex.yaml, served on loopback only: Docker publishes 127.0.0.1:5556, and a
 * host process listening on every interface would put the test provider on the LAN.
 *
 * `mock` adds Dex's `mockCallback` connector, which signs in as its fixed identity
 * without a form (Synapse is pointed at /auth/mock). The password form stays reachable.
 */
export function nativeDexConfig(
  shared: string,
  { mock = false }: { readonly mock?: boolean } = {},
): string {
  const bound = shared.replace(
    /^([ \t]*http:[ \t]*)0\.0\.0\.0:5556[ \t]*$/mu,
    (_line, key: string) => `${key}127.0.0.1:5556`,
  );
  if (bound === shared)
    throw new Error('the shared dex.yaml has no `http: 0.0.0.0:5556` listener');
  if (mock && /^connectors:/mu.test(bound))
    throw new Error('the shared dex.yaml already lists connectors');
  const config = mock
    ? `${bound.replace(/\n*$/u, '\n')}\nconnectors:\n  - type: mockCallback\n    id: mock\n    name: Mock\n`
    : bound;
  return `# Generated by e2e/support/homeserver/native.mts from the shared dex.yaml.\n${offsetPorts(config)}`;
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw unreadable(pidFile);
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

// A PID file that outlives a crash or reboot can name a reused PID, so a live PID only
// counts as ours when its command line is the service we spawned.
const IDENTITY: Record<NativeService, RegExp> = {
  homeserver: /synapse\.app\.homeserver/u,
  caddy: /\bcaddy\b.*\brun\b/u,
  dex: /\bdex\b.*\bserve\b/u,
  mailpit: /\bmailpit\b.*--smtp\b/u,
  sydent: /\bsydent\/launch\.py\b/u,
};

function isOurs(
  api: NativeProcessApi,
  service: NativeService,
  pid: number,
): boolean {
  return isAlive(api, pid) && IDENTITY[service].test(api.commandOf(pid));
}

export function runningNativeServices(
  pidFile: string,
  api: NativeProcessApi,
): NativeService[] {
  return Object.entries(readNativePids(pidFile))
    .filter(([service, pid]) => isOurs(api, service as NativeService, pid))
    .map(([service]) => service as NativeService);
}

/**
 * Spawn Synapse, then Caddy, then Dex, Mailpit and Sydent if asked, recording each PID as
 * soon as it exists. `sydent` is the path of its config.
 */
export function startNativeServices(
  paths: NativePaths,
  api: NativeProcessApi,
  env: NodeJS.ProcessEnv,
  {
    dex = false,
    mailpit = false,
    sydent,
  }: {
    readonly dex?: boolean;
    readonly mailpit?: boolean;
    readonly sydent?: string;
  } = {},
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
        TRINITY_E2E_HOMESERVER_UPSTREAM: `localhost:${PORTS.homeserver}`,
      },
      logFile: paths.logs.caddy,
    },
  );
  record();
  if (dex) {
    pids.dex = api.spawnDetached('dex', ['serve', paths.dexConfig], {
      env,
      logFile: paths.logs.dex,
    });
    record();
  }
  if (mailpit) {
    // Loopback only, on the ports Docker publishes; Synapse sends to localhost there.
    pids.mailpit = api.spawnDetached(
      'mailpit',
      [
        '--listen',
        `127.0.0.1:${PORTS.mailpit}`,
        '--smtp',
        `127.0.0.1:${PORTS.smtp}`,
      ],
      { env, logFile: paths.logs.mailpit },
    );
    record();
  }
  if (sydent) {
    pids.sydent = api.spawnDetached(
      paths.sydentPython,
      [join(import.meta.dirname, 'sydent', 'launch.py')],
      {
        env: {
          ...env,
          SYDENT_CONF: sydent,
          // Sydent federates to the homeserver `localhost` on 8448 unless told otherwise.
          ...(PORT_OFFSET
            ? { TRINITY_E2E_FEDERATION_PORT: String(PORTS.tls) }
            : {}),
        },
        logFile: paths.logs.sydent,
      },
    );
    record();
  }
}

/** SIGTERM each recorded process group, SIGKILL what outlives the grace period. */
export async function stopNativeServices(
  pidFile: string,
  api: NativeProcessApi,
  {
    graceMs = 10_000,
    pollMs = 100,
    signal,
    log = () => undefined,
  }: {
    readonly graceMs?: number;
    readonly pollMs?: number;
    readonly signal?: AbortSignal;
    readonly log?: (message: string) => void;
  } = {},
): Promise<void> {
  const pids: number[] = [];
  for (const [service, pid] of Object.entries(readNativePids(pidFile))) {
    if (isOurs(api, service as NativeService, pid)) pids.push(pid);
    else if (isAlive(api, pid)) {
      log(
        `PID ${pid} (${service}) in ${pidFile} is another process; not signalling it`,
      );
    }
  }
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
