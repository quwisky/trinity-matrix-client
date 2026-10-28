import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  SYDENT_VERSION,
  SYNAPSE_VERSION,
  ensureSydentVenv,
  ensureSynapseVenv,
  generateSynapseConfig,
  configuredTlsPort,
  nativeCaddyfile,
  nativeDexConfig,
  nativeDexVersion,
  nativeMailpitVersion,
  nativePaths,
  readNativePids,
  runningNativeServices,
  startNativeServices,
  stopNativeServices,
  type NativePaths,
  type NativeProcessApi,
} from './native.mts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function layout(): NativePaths {
  const state = mkdtempSync(join(tmpdir(), 'trinity-native-'));
  directories.push(state);
  const paths = nativePaths(state, join(state, 'data'));
  mkdirSync(paths.data, { recursive: true });
  return paths;
}

interface Spawned {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly logFile: string;
}

/** A process table: spawn adds a PID, SIGTERM/SIGKILL remove it, kill(pid, 0) probes it. */
function fakeProcesses(
  options: {
    installed?: string;
    ignoreTerm?: ReadonlySet<number>;
    failSpawn?: string;
  } = {},
) {
  const live = new Set<number>();
  const commands = new Map<number, string>();
  const execCalls: string[][] = [];
  const spawns: Spawned[] = [];
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  let nextPid = 4100;
  const api: NativeProcessApi = {
    async exec(file, args) {
      execCalls.push([file, ...args]);
      if (args[0] === '-c') {
        if (!options.installed) throw new Error('No module named synapse');
        return { stdout: `${options.installed}\n` };
      }
      return { stdout: '' };
    },
    spawnDetached(file, args, spawnOptions) {
      if (file === options.failSpawn)
        throw new Error(`could not start ${file}`);
      const pid = nextPid++;
      live.add(pid);
      commands.set(pid, [file, ...args].join(' '));
      spawns.push({ file, args, ...spawnOptions });
      return pid;
    },
    commandOf: (pid) => (live.has(pid) ? (commands.get(pid) ?? '') : ''),
    kill(pid, signal) {
      signals.push([pid, signal]);
      const target = Math.abs(pid);
      if (!live.has(target)) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      if (
        signal === 'SIGKILL' ||
        (signal === 'SIGTERM' && !options.ignoreTerm?.has(target))
      ) {
        live.delete(target);
      }
    },
  };
  return { api, live, commands, execCalls, spawns, signals };
}

describe('native homeserver runtime', () => {
  it('runs the same Synapse as the Docker stack', () => {
    const compose = readFileSync(
      join(import.meta.dirname, 'synapse/docker-compose.yml'),
      'utf8',
    );
    const images = [
      ...compose.matchAll(/ghcr\.io\/element-hq\/synapse:v([\d.]+)/gu),
    ].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    expect(new Set(images)).toEqual(new Set([SYNAPSE_VERSION]));
  });

  it('runs the same Sydent as the Docker stack', () => {
    const compose = readFileSync(
      join(import.meta.dirname, 'synapse/docker-compose.yml'),
      'utf8',
    );
    expect(compose).toContain(`matrixdotorg/sydent:v${SYDENT_VERSION}`);
  });

  it('installs the pinned Sydent into its own venv', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    await ensureSydentVenv(paths, fake.api, { log: () => undefined });
    expect(paths.sydentVenv).not.toBe(paths.venv);
    expect(fake.execCalls[0]).toEqual([
      'python3',
      '-m',
      'venv',
      paths.sydentVenv,
    ]);
    expect(fake.execCalls[2]).toEqual([
      paths.sydentPython,
      '-m',
      'pip',
      'install',
      '--quiet',
      `matrix-sydent[prometheus]==${SYDENT_VERSION}`,
      'canonicaljson==1.5.0',
    ]);
  });

  it('reinstalls a Sydent venv whose canonicaljson is not the pinned one', async () => {
    const paths = layout();
    mkdirSync(dirname(paths.sydentPython), { recursive: true });
    writeFileSync(paths.sydentPython, '');
    const current = fakeProcesses({ installed: `${SYDENT_VERSION} 1.5.0` });
    await ensureSydentVenv(paths, current.api, { log: () => undefined });
    expect(current.execCalls).toHaveLength(1);
    const drifted = fakeProcesses({ installed: `${SYDENT_VERSION} 2.0.0` });
    await ensureSydentVenv(paths, drifted.api, { log: () => undefined });
    expect(drifted.execCalls.at(-1)).toContain('canonicaljson==1.5.0');
  });

  it('creates the venv and installs the pinned Synapse', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    await ensureSynapseVenv(paths, fake.api, { log: () => undefined });
    expect(fake.execCalls).toEqual([
      ['python3', '-m', 'venv', paths.venv],
      [
        paths.python,
        '-c',
        'import authlib; from importlib.metadata import version; print(version("matrix-synapse"))',
      ],
      [
        paths.python,
        '-m',
        'pip',
        'install',
        '--quiet',
        `matrix-synapse[url-preview,oidc]==${SYNAPSE_VERSION}`,
      ],
    ]);
  });

  it('reuses a venv that already holds the pinned Synapse', async () => {
    const paths = layout();
    mkdirSync(dirname(paths.python), { recursive: true });
    writeFileSync(paths.python, '');
    const fake = fakeProcesses({ installed: SYNAPSE_VERSION });
    await ensureSynapseVenv(paths, fake.api, { log: () => undefined });
    expect(fake.execCalls).toEqual([
      [
        paths.python,
        '-c',
        'import authlib; from importlib.metadata import version; print(version("matrix-synapse"))',
      ],
    ]);
  });

  it('starts Synapse and Caddy detached and records both PIDs', () => {
    const paths = layout();
    const fake = fakeProcesses();
    startNativeServices(paths, fake.api, { PATH: '/bin' });
    expect(fake.spawns[0]).toMatchObject({
      file: paths.python,
      args: ['-m', 'synapse.app.homeserver', '-c', paths.config],
      logFile: paths.logs.homeserver,
    });
    expect(fake.spawns[1]).toMatchObject({
      file: 'caddy',
      args: ['run', '--config', paths.caddyfile, '--adapter', 'caddyfile'],
      logFile: paths.logs.caddy,
    });
    expect(fake.spawns[1]!.env).toMatchObject({
      PATH: '/bin',
      XDG_DATA_HOME: paths.caddyData,
      XDG_CONFIG_HOME: paths.caddyConfig,
      TRINITY_E2E_HOMESERVER_UPSTREAM: 'localhost:8008',
    });
    expect(JSON.parse(readFileSync(paths.pidFile, 'utf8'))).toEqual({
      homeserver: 4100,
      caddy: 4101,
    });
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([
      'homeserver',
      'caddy',
    ]);
  });

  it('starts Dex third when asked, on the loopback config, and records its PID', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    startNativeServices(paths, fake.api, { PATH: '/bin' }, { dex: true });
    expect(fake.spawns[2]).toMatchObject({
      file: 'dex',
      args: ['serve', paths.dexConfig],
      logFile: paths.logs.dex,
      env: { PATH: '/bin' },
    });
    expect(JSON.parse(readFileSync(paths.pidFile, 'utf8'))).toEqual({
      homeserver: 4100,
      caddy: 4101,
      dex: 4102,
    });
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([
      'homeserver',
      'caddy',
      'dex',
    ]);
    await stopNativeServices(paths.pidFile, fake.api, {
      graceMs: 50,
      pollMs: 1,
    });
    expect(fake.signals).toContainEqual([-4102, 'SIGTERM']);
    expect(fake.live.size).toBe(0);
  });

  it('starts Mailpit on loopback when asked, and stops it with the rest', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    startNativeServices(paths, fake.api, { PATH: '/bin' }, { mailpit: true });
    expect(fake.spawns[2]).toMatchObject({
      file: 'mailpit',
      args: ['--listen', '127.0.0.1:8025', '--smtp', '127.0.0.1:1025'],
      logFile: paths.logs.mailpit,
    });
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([
      'homeserver',
      'caddy',
      'mailpit',
    ]);
    await stopNativeServices(paths.pidFile, fake.api, {
      graceMs: 50,
      pollMs: 1,
    });
    expect(fake.live.size).toBe(0);
  });

  it('starts Sydent through the launcher with its config, and stops it with the rest', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    startNativeServices(
      paths,
      fake.api,
      { PATH: '/bin' },
      { mailpit: true, sydent: '/data/sydent/sydent.conf' },
    );
    expect(fake.spawns[3]).toMatchObject({
      file: paths.sydentPython,
      args: [join(import.meta.dirname, 'sydent', 'launch.py')],
      env: { PATH: '/bin', SYDENT_CONF: '/data/sydent/sydent.conf' },
      logFile: paths.logs.sydent,
    });
    expect(fake.spawns[3]?.env).not.toHaveProperty(
      'TRINITY_E2E_FEDERATION_PORT',
    );
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([
      'homeserver',
      'caddy',
      'mailpit',
      'sydent',
    ]);
    await stopNativeServices(paths.pidFile, fake.api, {
      graceMs: 50,
      pollMs: 1,
    });
    expect(fake.live.size).toBe(0);
  });

  it('reads the installed Mailpit version, or null without a mailpit on PATH', async () => {
    const versionOf = (exec: NativeProcessApi['exec']) =>
      nativeMailpitVersion({ ...fakeProcesses().api, exec });
    await expect(
      versionOf(async () => ({
        stdout:
          '/opt/homebrew/bin/mailpit v1.31.4 compiled with go1.25.1 on darwin/arm64\n',
      })),
    ).resolves.toBe('v1.31.4');
    await expect(
      versionOf(async () => {
        throw Object.assign(new Error('spawn mailpit ENOENT'), {
          code: 'ENOENT',
        });
      }),
    ).resolves.toBeNull();
  });

  it('serves the shared dex.yaml on loopback only', () => {
    const shared = readFileSync(join(import.meta.dirname, 'dex.yaml'), 'utf8');
    const native = nativeDexConfig(shared);
    expect(native).toMatch(/^\s*http: 127\.0\.0\.1:5556$/mu);
    expect(native).not.toContain('0.0.0.0');
    // Everything else is the shared provider: issuer, client and static users.
    expect(native).toContain('issuer: http://localhost:5556/dex');
    expect(native).toContain('username: sso-reset-e2e');
    expect(() => nativeDexConfig('issuer: x\n')).toThrow(
      /no `http: 0.0.0.0:5556`/,
    );
  });

  it("appends Dex's form-free mock connector only when asked, keeping the password form", () => {
    const shared = readFileSync(join(import.meta.dirname, 'dex.yaml'), 'utf8');
    expect(nativeDexConfig(shared)).not.toContain('connectors:');
    expect(nativeDexConfig(shared, { mock: false })).not.toContain(
      'connectors:',
    );
    const mock = parse(nativeDexConfig(shared, { mock: true })) as {
      connectors: unknown;
      oauth2: { passwordConnector: string };
    };
    expect(mock.connectors).toEqual([
      { type: 'mockCallback', id: 'mock', name: 'Mock' },
    ]);
    expect(mock.oauth2.passwordConnector).toBe('local');
  });

  it('reads the installed Dex version, or null without a dex on PATH', async () => {
    const versionOf = (exec: NativeProcessApi['exec']) =>
      nativeDexVersion({ ...fakeProcesses().api, exec });
    await expect(
      versionOf(async () => ({
        stdout: 'Dex Version: 2.46.0\nGo Version: go1.27.1\n',
      })),
    ).resolves.toBe('2.46.0');
    await expect(
      versionOf(async () => {
        throw Object.assign(new Error('spawn dex ENOENT'), { code: 'ENOENT' });
      }),
    ).resolves.toBeNull();
  });

  it('records Synapse even when Caddy cannot start', () => {
    const paths = layout();
    const fake = fakeProcesses({ failSpawn: 'caddy' });
    expect(() => startNativeServices(paths, fake.api, {})).toThrow(
      /could not start caddy/,
    );
    expect(JSON.parse(readFileSync(paths.pidFile, 'utf8'))).toEqual({
      homeserver: 4100,
    });
  });

  it('reports nothing running without a PID file, and ignores dead PIDs', () => {
    const paths = layout();
    const fake = fakeProcesses();
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([]);
    writeFileSync(paths.pidFile, JSON.stringify({ homeserver: 9999 }));
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([]);
  });

  it('rejects an unreadable PID file instead of guessing', () => {
    const paths = layout();
    const fake = fakeProcesses();
    writeFileSync(paths.pidFile, 'not json');
    expect(() => runningNativeServices(paths.pidFile, fake.api)).toThrow(
      /unreadable native PID file/,
    );
    writeFileSync(paths.pidFile, JSON.stringify({ homeserver: -3 }));
    expect(() => runningNativeServices(paths.pidFile, fake.api)).toThrow(
      /unreadable native PID file/,
    );
  });

  it('rejects a PID file that exists but cannot be read', () => {
    const paths = layout();
    const fake = fakeProcesses();
    mkdirSync(paths.pidFile); // reading a directory fails with EISDIR, not ENOENT
    expect(() => readNativePids(paths.pidFile)).toThrow(
      /unreadable native PID file/,
    );
    expect(() => runningNativeServices(paths.pidFile, fake.api)).toThrow(
      paths.pidFile,
    );
  });

  it('stops both process groups and removes the PID file', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    startNativeServices(paths, fake.api, {});
    await stopNativeServices(paths.pidFile, fake.api, {
      graceMs: 50,
      pollMs: 1,
    });
    expect(fake.signals).toContainEqual([-4100, 'SIGTERM']);
    expect(fake.signals).toContainEqual([-4101, 'SIGTERM']);
    expect(fake.live.size).toBe(0);
    expect(existsSync(paths.pidFile)).toBe(false);
    await stopNativeServices(paths.pidFile, fake.api); // no PID file: a no-op
  });

  it('escalates to SIGKILL for a process that ignores SIGTERM', async () => {
    const paths = layout();
    const fake = fakeProcesses({ ignoreTerm: new Set([4100]) });
    startNativeServices(paths, fake.api, {});
    await stopNativeServices(paths.pidFile, fake.api, {
      graceMs: 20,
      pollMs: 1,
    });
    expect(fake.signals).toContainEqual([-4100, 'SIGKILL']);
    expect(fake.live.size).toBe(0);
  });

  it('neither reports nor signals a reused PID that runs something else', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    fake.live.add(777);
    fake.commands.set(777, '/usr/bin/vim notes.txt');
    startNativeServices(paths, fake.api, {});
    const pids = JSON.parse(readFileSync(paths.pidFile, 'utf8'));
    writeFileSync(paths.pidFile, JSON.stringify({ ...pids, caddy: 777 }));
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([
      'homeserver',
    ]);
    const messages: string[] = [];
    await stopNativeServices(paths.pidFile, fake.api, {
      graceMs: 50,
      pollMs: 1,
      log: (m) => messages.push(m),
    });
    expect(
      fake.signals.filter(([pid, sig]) => sig !== 0 && Math.abs(pid) === 777),
    ).toEqual([]);
    expect(fake.live.has(777)).toBe(true);
    expect(fake.live.has(4100)).toBe(false);
    expect(messages.join('\n')).toMatch(/777/);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('removes a stale PID file whose PIDs are all foreign, signalling nothing', async () => {
    const paths = layout();
    const fake = fakeProcesses();
    fake.live.add(888);
    fake.commands.set(888, 'sshd: me');
    writeFileSync(paths.pidFile, JSON.stringify({ homeserver: 888 }));
    expect(runningNativeServices(paths.pidFile, fake.api)).toEqual([]);
    await stopNativeServices(paths.pidFile, fake.api, { graceMs: 5 });
    expect(
      fake.signals.filter(([pid, sig]) => sig !== 0 && Math.abs(pid) === 888),
    ).toEqual([]);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('serves the 8448, identity server and link-preview sites, without the admin API or a trust-store install', () => {
    const shared = readFileSync(join(import.meta.dirname, 'Caddyfile'), 'utf8');
    const caddyfile = nativeCaddyfile(shared, '/data/caddy-access.log');
    expect(caddyfile).toContain('https://localhost:8448 {');
    expect(caddyfile).toContain('respond /.well-known/matrix/client 200');
    for (const option of [
      'admin off',
      'skip_install_trust',
      '\tdebug\n',
      'auto_https disable_redirects',
      'default_bind 127.0.0.1 [::1]',
      'protocols h1 h2',
      'default_sni localhost',
    ]) {
      expect(caddyfile).toContain(option);
    }
    // Access log without headers (bearer tokens), inside the 8448 site.
    expect(caddyfile).toContain('output file /data/caddy-access.log');
    expect(caddyfile).toContain('request>headers delete');
    expect(caddyfile).not.toContain('https://localhost {');
    expect(caddyfile).not.toContain('9448');
    expect(caddyfile).toContain('https://localhost:8452 {');
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:8090');
    expect(caddyfile).toContain(':8080 {');
    expect(caddyfile).toContain('respond @og 200');
    expect(() => nativeCaddyfile(':8080 {\n}\n', '/x')).toThrow(
      /no https:\/\/localhost:8448 site/,
    );
    expect(() =>
      nativeCaddyfile('https://localhost:8448 {\n}\n', '/x'),
    ).toThrow(/no :8080 link-preview site/);
  });
});

describe('native Synapse config generation', () => {
  it('runs in the data directory so homeserver.log lands there', async () => {
    const paths = layout();
    let cwd: string | undefined;
    await generateSynapseConfig(paths, 'localhost', {
      async exec(_file, _args, options) {
        cwd = options?.cwd;
        return { stdout: '' };
      },
    } as NativeProcessApi);
    expect(cwd).toBe(paths.data);
  });
});

describe('leftover native state', () => {
  it('reads the TLS port a config was set up for, and none before it was patched', () => {
    expect(
      configuredTlsPort('a: 1\npublic_baseurl: "https://localhost:8548/"\n'),
    ).toBe(8548);
    expect(configuredTlsPort('server_name: "localhost"\n')).toBeNull();
  });
});

describe('native runtime at TRINITY_E2E_PORT_OFFSET=100', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function offsetRuntime(): Promise<typeof import('./native.mts')> {
    vi.stubEnv('TRINITY_E2E_PORT_OFFSET', '100');
    vi.resetModules();
    return import('./native.mts');
  }

  it('moves every Caddy and Dex listener and the URLs they serve', async () => {
    const { nativeCaddyfile, nativeDexConfig } = await offsetRuntime();
    const caddyfile = nativeCaddyfile(
      readFileSync(join(import.meta.dirname, 'Caddyfile'), 'utf8'),
      '/data/caddy-access.log',
    );
    expect(caddyfile).toContain('https://localhost:8548 {');
    expect(caddyfile).toContain('"base_url":"https://localhost:8548"');
    expect(caddyfile).toContain('"m.server":"localhost:8548"');
    expect(caddyfile).toContain('https://localhost:8552 {');
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:8190');
    expect(caddyfile).toContain(':8180 {');
    expect(caddyfile).not.toMatch(/:(8008|8448|8452|8090|8080)\b/);

    const dex = parse(
      nativeDexConfig(
        readFileSync(join(import.meta.dirname, 'dex.yaml'), 'utf8'),
      ),
    );
    expect(dex.issuer).toBe('http://localhost:5656/dex');
    expect(dex.web.http).toBe('127.0.0.1:5656');
    expect(dex.staticClients[0].redirectURIs).toEqual([
      'https://localhost:8548/_synapse/client/oidc/callback',
      'https://localhost:8548/_matrix/client/unstable/login/sso/callback/trinity-e2e',
    ]);
  });

  it('starts Caddy, Mailpit and Sydent on the offset ports', async () => {
    const { startNativeServices } = await offsetRuntime();
    const paths = layout();
    const fake = fakeProcesses();
    startNativeServices(
      paths,
      fake.api,
      {},
      { mailpit: true, sydent: '/data/sydent/sydent.conf' },
    );
    expect(fake.spawns[1]?.env['TRINITY_E2E_HOMESERVER_UPSTREAM']).toBe(
      'localhost:8108',
    );
    expect(fake.spawns[2]?.args).toEqual([
      '--listen',
      '127.0.0.1:8125',
      '--smtp',
      '127.0.0.1:1125',
    ]);
    expect(fake.spawns[3]?.env['TRINITY_E2E_FEDERATION_PORT']).toBe('8548');
  });
});
