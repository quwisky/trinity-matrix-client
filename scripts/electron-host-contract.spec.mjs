import { describe, expect, it } from 'vitest';
import {
  validateCurrentElectronHost,
  validateElectronHostContract,
} from './electron-host-contract.mjs';

function validInput() {
  return {
    project: {
      name: 'trinity-desktop',
      projectType: 'application',
      tags: ['type:app', 'scope:matrix', 'role:app', 'capability:composition'],
      implicitDependencies: ['trinity'],
      targets: {
        'install-dependencies': {
          cache: false,
          options: {
            command: 'pnpm -C electron install --frozen-lockfile',
          },
        },
        install: {
          cache: false,
          dependsOn: ['install-dependencies'],
          options: { command: 'pnpm -C electron run ensure:binary' },
        },
        build: {
          cache: false,
          dependsOn: ['install', { projects: ['trinity'], target: 'build' }],
          options: {
            command:
              'pnpm -C electron run build && pnpm -C electron run sign:dev',
          },
        },
        'build-prebuilt': {
          cache: false,
          dependsOn: ['install'],
          options: {
            command:
              'pnpm -C electron run build && pnpm -C electron run sign:dev',
          },
        },
        'build-release': {
          cache: false,
          dependsOn: [
            'install-dependencies',
            { projects: ['trinity'], target: 'build' },
          ],
          options: { command: 'pnpm -C electron run build' },
        },
        lint: {
          dependsOn: ['install-dependencies'],
          options: { command: 'pnpm exec eslint electron' },
        },
        typecheck: {
          dependsOn: ['install-dependencies'],
          options: { command: 'pnpm -C electron run typecheck' },
        },
        compile: {
          dependsOn: ['install-dependencies'],
          options: { command: 'pnpm -C electron run compile' },
        },
        start: {
          cache: false,
          dependsOn: ['build'],
          options: { command: 'pnpm -C electron run start' },
        },
        test: {
          dependsOn: ['install-dependencies'],
          options: { command: 'pnpm -C electron run test' },
          configurations: {
            watch: { command: 'pnpm -C electron exec vitest' },
          },
        },
        'sign-dev': {
          cache: false,
          dependsOn: ['install'],
          options: { command: 'pnpm -C electron run sign:dev' },
        },
        verify: {
          options: { command: 'node scripts/electron-host-contract.mjs' },
        },
        e2e: {
          cache: false,
          parallelism: false,
          dependsOn: ['build'],
          options: {
            command:
              'node e2e/support/run-playwright.mts --config=e2e/playwright.electron.config.mts --resource=electron --resource=synapse',
          },
        },
        'e2e-smoke': {
          cache: false,
          parallelism: false,
          dependsOn: ['build'],
          options: {
            command:
              'node e2e/support/run-playwright.mts --config=e2e/playwright.electron.smoke.config.mts --resource=electron',
          },
        },
        package: {
          cache: false,
          dependsOn: ['build'],
          options: { command: 'pnpm -C electron run package' },
        },
        'package-linux': {
          cache: false,
          dependsOn: ['build-release'],
          options: { command: 'pnpm -C electron run package:linux' },
        },
        'package-mac': {
          cache: false,
          dependsOn: ['build'],
          options: { command: 'pnpm -C electron run package:mac' },
        },
        'package-mac-signed': {
          cache: false,
          dependsOn: ['build-release'],
          options: { command: 'pnpm -C electron run package:mac:signed' },
        },
        'package-win': {
          cache: false,
          dependsOn: ['build-release'],
          options: { command: 'pnpm -C electron run package:win' },
        },
        'package-all': {
          cache: false,
          dependsOn: ['build-release'],
          options: { command: 'pnpm -C electron run package:all' },
        },
      },
    },
    packageJson: {
      scripts: {
        'electron:install': 'nx run trinity-desktop:install',
        'electron:compile': 'nx run trinity-desktop:compile',
        'electron:typecheck': 'nx run trinity-desktop:typecheck',
        'electron:test': 'nx run trinity-desktop:test',
        'electron:verify': 'nx run trinity-desktop:verify',
        'electron:build': 'nx run trinity-desktop:build',
        'electron:build:prebuilt': 'nx run trinity-desktop:build-prebuilt',
        'electron:build:release': 'nx run trinity-desktop:build-release',
        'electron:start': 'nx run trinity-desktop:start',
        'electron:package': 'nx run trinity-desktop:package',
        'electron:package:mac': 'nx run trinity-desktop:package-mac',
        'electron:package:mac:signed':
          'nx run trinity-desktop:package-mac-signed',
        'electron:package:linux': 'nx run trinity-desktop:package-linux',
        'electron:package:win': 'nx run trinity-desktop:package-win',
        'electron:package:all': 'nx run trinity-desktop:package-all',
        'electron:sign:dev': 'nx run trinity-desktop:sign-dev',
        'electron:e2e': 'nx run trinity-desktop:e2e',
        'electron:e2e:smoke': 'nx run trinity-desktop:e2e-smoke',
      },
    },
    shellPackage: { nx: { includedScripts: [] } },
    copyWww: [
      "const src = join(repoRoot, 'www')",
      "const dest = join(electronRoot, 'www')",
    ].join('\n'),
    window: [
      'contents.setWindowOpenHandler(',
      "contents.on('will-navigate'",
      "contents.on('will-attach-webview'",
      'contextIsolation: true',
      'nodeIntegration: false',
      'sandbox: true',
      'webSecurity: true',
    ].join('\n'),
    hostCapabilities: [
      'export const HOST_PROTOCOL_VERSION = 1',
      'ipcMain.handle(',
      'event.sender !== win.webContents',
      'negotiateHostCapabilities(',
    ].join('\n'),
    preload: [
      'contextBridge.exposeInMainWorld(',
      'ipcRenderer.invoke(',
      'acceptNegotiation(',
      'grantedOperations.has(',
      'generation === negotiationGeneration',
    ].join('\n'),
    builder: [
      'asar: true',
      'afterPack: ./afterPack.cjs',
      'protocols:',
      '  - eu.qwky.trinity',
    ].join('\n'),
  };
}

describe('Electron host contract', () => {
  it('validates the checked-in desktop host', () => {
    expect(validateCurrentElectronHost).not.toThrow();
  });

  it('rejects a desktop shell outside the classified application graph', () => {
    const input = validInput();
    input.project.tags = [];
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain('Electron host is missing type:app');
    expect(errors).toContain('Electron host is missing role:app');
  });

  it('rejects a build detached from the shared renderer', () => {
    const input = validInput();
    input.project.targets.build.dependsOn = ['install'];
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron build must package the shared production renderer',
    );
  });

  it('rejects release signing chained through a local development identity', () => {
    const input = validInput();
    input.project.targets['package-mac-signed'].dependsOn = ['build'];
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron package-mac-signed must delegate to the shell package:mac:signed command',
    );
  });

  it('rejects a desktop watch target that escapes the standalone shell', () => {
    const input = validInput();
    input.project.targets.test.configurations.watch.command = 'vitest';
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron watch tests must stay inside the standalone shell',
    );
  });

  it('rejects cached or parallel desktop journeys', () => {
    const input = validInput();
    input.project.targets.e2e.cache = true;
    input.project.targets.e2e.parallelism = true;
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron e2e must launch the uncached serialized built desktop app',
    );
  });

  it('rejects a smoke journey coupled to the Synapse-backed config', () => {
    const input = validInput();
    input.project.targets['e2e-smoke'].options.command =
      'pnpm exec playwright test -c e2e/playwright.electron.config.mts app.electron.spec.mts';
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron smoke must launch the uncached serialized Docker-independent shell journey',
    );
  });

  it('rejects a no-op platform package target', () => {
    const input = validInput();
    input.project.targets['package-linux'].options.command = 'true';
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron package-linux must delegate to the shell package:linux command',
    );
  });

  it('rejects duplicate package-script target inference', () => {
    const input = validInput();
    input.shellPackage.nx.includedScripts = ['test'];
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron package scripts must not create duplicate inferred Nx targets',
    );
  });

  it('rejects security and sender checks hidden in comments', () => {
    const input = validInput();
    input.window = input.window.replace(
      'contextIsolation: true',
      '// contextIsolation: true',
    );
    input.hostCapabilities = input.hostCapabilities.replace(
      'event.sender !== win.webContents',
      '// event.sender !== win.webContents',
    );
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron window is missing security marker: contextIsolation: true',
    );
    expect(errors).toContain(
      'Electron bridge must validate the IPC sender before negotiation',
    );
  });

  it('rejects a preload that exposes operations without negotiated grants', () => {
    const input = validInput();
    input.preload = input.preload.replace(
      'grantedOperations.has(',
      '// grantedOperations.has(',
    );
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron preload is missing bounded bridge marker: grantedOperations.has(',
    );
  });

  it('rejects commented-out protocol packaging', () => {
    const input = validInput();
    input.builder = input.builder.replace(
      '  - eu.qwky.trinity',
      '  # - eu.qwky.trinity',
    );
    const errors = [];

    validateElectronHostContract(input, errors);

    expect(errors).toContain(
      'Electron package must register the authentication protocol',
    );
  });
});
