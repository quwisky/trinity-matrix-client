import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceRoot = join(import.meta.dirname, '..');
const requiredTags = [
  'type:app',
  'scope:matrix',
  'role:app',
  'capability:composition',
];
const packageTargets = {
  package: 'pnpm -C electron run package',
  'package-mac': 'pnpm -C electron run package:mac',
  'package-mac-signed': 'pnpm -C electron run package:mac:signed',
  'package-linux': 'pnpm -C electron run package:linux',
  'package-win': 'pnpm -C electron run package:win',
  'package-all': 'pnpm -C electron run package:all',
};
const packageScripts = {
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
  'electron:package:mac:signed': 'nx run trinity-desktop:package-mac-signed',
  'electron:package:linux': 'nx run trinity-desktop:package-linux',
  'electron:package:win': 'nx run trinity-desktop:package-win',
  'electron:package:all': 'nx run trinity-desktop:package-all',
  'electron:sign:dev': 'nx run trinity-desktop:sign-dev',
  'electron:e2e': 'nx run trinity-desktop:e2e',
  'electron:e2e:smoke': 'nx run trinity-desktop:e2e-smoke',
};

function read(path) {
  return readFileSync(join(workspaceRoot, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

function withoutComments(source, preserveStrings = false) {
  let result = '';
  let index = 0;
  let quote;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      result += preserveStrings ? character : character === '\n' ? '\n' : ' ';
      if (character === '\\') {
        result += preserveStrings ? (next ?? '') : next === '\n' ? '\n' : ' ';
        index += 2;
        continue;
      }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      result += preserveStrings ? character : ' ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] === '\n') result += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function withoutYamlComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/u, ''))
    .join('\n');
}

function dependsOnProjectTarget(target, project, dependencyTarget) {
  return target?.dependsOn?.some(
    (dependency) =>
      typeof dependency === 'object' &&
      dependency.target === dependencyTarget &&
      (dependency.projects === project ||
        dependency.projects?.includes(project)),
  );
}

export function validateElectronHostContract(input, errors) {
  const { project } = input;
  const targets = project.targets ?? {};
  if (
    project.name !== 'trinity-desktop' ||
    project.projectType !== 'application'
  ) {
    errors.push('Electron must be a first-class Nx application');
  }
  if (
    targets['build-release']?.options?.command !==
      'pnpm -C electron run build' ||
    targets['build-release']?.cache !== false ||
    !targets['build-release']?.dependsOn?.includes('install-dependencies') ||
    !dependsOnProjectTarget(targets['build-release'], 'trinity', 'build')
  ) {
    errors.push(
      'Electron release build must package the shared renderer without development signing',
    );
  }
  for (const tag of requiredTags) {
    if (!project.tags?.includes(tag)) {
      errors.push(`Electron host is missing ${tag}`);
    }
  }
  if (!project.implicitDependencies?.includes('trinity')) {
    errors.push('Electron host must consume the shared Trinity renderer');
  }

  if (
    targets['install-dependencies']?.options?.command !==
      'pnpm -C electron install --frozen-lockfile' ||
    targets['install-dependencies']?.cache !== false ||
    targets.install?.options?.command !==
      'pnpm -C electron run ensure:binary' ||
    targets.install?.cache !== false ||
    !targets.install?.dependsOn?.includes('install-dependencies')
  ) {
    errors.push(
      'Electron install must use the pinned standalone shell workspace',
    );
  }
  if (
    targets.build?.options?.command !==
      'pnpm -C electron run build && pnpm -C electron run sign:dev' ||
    targets.build?.cache !== false ||
    !targets.build?.dependsOn?.includes('install') ||
    !dependsOnProjectTarget(targets.build, 'trinity', 'build')
  ) {
    errors.push('Electron build must package the shared production renderer');
  }
  if (
    targets['build-prebuilt']?.options?.command !==
      'pnpm -C electron run build && pnpm -C electron run sign:dev' ||
    targets['build-prebuilt']?.cache !== false ||
    !targets['build-prebuilt']?.dependsOn?.includes('install')
  ) {
    errors.push(
      'Electron prebuilt build must package an already-verified shared renderer',
    );
  }
  for (const [targetName, command] of [
    ['lint', 'pnpm exec eslint electron'],
    ['typecheck', 'pnpm -C electron run typecheck'],
    ['test', 'pnpm -C electron run test'],
    ['compile', 'pnpm -C electron run compile'],
  ]) {
    const target = targets[targetName];
    if (
      target?.options?.command !== command ||
      !target?.dependsOn?.includes('install-dependencies')
    ) {
      errors.push(
        `Electron ${targetName} must run through the pinned standalone shell workspace`,
      );
    }
  }
  if (
    targets.test?.configurations?.watch?.command !==
    'pnpm -C electron exec vitest'
  ) {
    errors.push('Electron watch tests must stay inside the standalone shell');
  }
  if (
    targets.start?.options?.command !== 'pnpm -C electron run start' ||
    targets.start?.cache !== false ||
    !targets.start?.dependsOn?.includes('build')
  ) {
    errors.push('Electron start must launch the built desktop shell');
  }
  if (
    targets['sign-dev']?.options?.command !== 'pnpm -C electron run sign:dev' ||
    targets['sign-dev']?.cache !== false ||
    !targets['sign-dev']?.dependsOn?.includes('install')
  ) {
    errors.push('Electron development signing must use the installed shell');
  }
  if (
    targets.verify?.options?.command !==
    'node scripts/electron-host-contract.mjs'
  ) {
    errors.push('Electron verify must execute the desktop host contract');
  }
  if (
    targets.e2e?.options?.command !==
      'pnpm exec nx run trinity-e2e-electron:full' ||
    targets.e2e?.cache !== false ||
    targets.e2e?.parallelism !== false ||
    targets.e2e?.dependsOn !== undefined
  ) {
    errors.push(
      'Electron e2e must delegate only to the uncached lifecycle-owned full suite',
    );
  }
  if (
    targets['e2e-smoke']?.options?.command !==
      'pnpm exec nx run trinity-e2e-electron:smoke' ||
    targets['e2e-smoke']?.cache !== false ||
    targets['e2e-smoke']?.parallelism !== false ||
    targets['e2e-smoke']?.dependsOn !== undefined
  ) {
    errors.push(
      'Electron smoke must delegate only to the uncached lifecycle-owned smoke suite',
    );
  }
  for (const [targetName, command] of Object.entries(packageTargets)) {
    const target = targets[targetName];
    if (
      target?.options?.command !== command ||
      target?.cache !== false ||
      !target?.dependsOn?.includes(
        [
          'package-mac-signed',
          'package-linux',
          'package-win',
          'package-all',
        ].includes(targetName)
          ? 'build-release'
          : 'build',
      )
    ) {
      const shellCommand = command.slice('pnpm -C electron run '.length);
      errors.push(
        `Electron ${targetName} must delegate to the shell ${shellCommand} command`,
      );
    }
  }
  for (const [script, command] of Object.entries(packageScripts)) {
    if (input.packageJson.scripts?.[script] !== command) {
      errors.push(`${script} must delegate to its Nx desktop target`);
    }
  }
  if (
    !Array.isArray(input.shellPackage.nx?.includedScripts) ||
    input.shellPackage.nx.includedScripts.length !== 0
  ) {
    errors.push(
      'Electron package scripts must not create duplicate inferred Nx targets',
    );
  }

  const copyCode = withoutComments(input.copyWww, true);
  for (const marker of [
    "const src = join(repoRoot, 'www')",
    "const dest = join(electronRoot, 'www')",
  ]) {
    if (!copyCode.includes(marker)) {
      errors.push(`Electron shared-artifact copy is missing: ${marker}`);
    }
  }

  const windowCode = withoutComments(input.window);
  const windowExecutable = withoutComments(input.window, true);
  for (const marker of [
    'contextIsolation: true',
    'nodeIntegration: false',
    'sandbox: true',
    'webSecurity: true',
    'contents.setWindowOpenHandler(',
  ]) {
    if (!windowCode.includes(marker)) {
      errors.push(`Electron window is missing security marker: ${marker}`);
    }
  }
  for (const marker of [
    "contents.on('will-navigate'",
    "contents.on('will-attach-webview'",
  ]) {
    if (!windowExecutable.includes(marker)) {
      errors.push(`Electron window is missing navigation guard: ${marker}`);
    }
  }

  const hostCode = withoutComments(input.hostCapabilities);
  for (const marker of [
    'HOST_PROTOCOL_VERSION = 1',
    'ipcMain.handle(',
    'negotiateHostCapabilities(',
  ]) {
    if (!hostCode.includes(marker)) {
      errors.push(`Electron bridge is missing protocol marker: ${marker}`);
    }
  }
  if (!hostCode.includes('event.sender !== win.webContents')) {
    errors.push(
      'Electron bridge must validate the IPC sender before negotiation',
    );
  }
  const preloadCode = withoutComments(input.preload);
  for (const marker of [
    'contextBridge.exposeInMainWorld(',
    'ipcRenderer.invoke(',
    'acceptNegotiation(',
    'grantedOperations.has(',
    'generation === negotiationGeneration',
  ]) {
    if (!preloadCode.includes(marker)) {
      errors.push(
        `Electron preload is missing bounded bridge marker: ${marker}`,
      );
    }
  }

  const builder = withoutYamlComments(input.builder);
  if (!/^asar:\s*true$/mu.test(builder) || !builder.includes('afterPack:')) {
    errors.push('Electron package must keep ASAR and fuse hardening');
  }
  if (
    !builder.includes('protocols:') ||
    !/^\s*-\s+eu\.qwky\.trinity$/mu.test(builder)
  ) {
    errors.push('Electron package must register the authentication protocol');
  }
}

export function validateCurrentElectronHost() {
  const errors = [];
  validateElectronHostContract(
    {
      project: readJson('electron/project.json'),
      packageJson: readJson('package.json'),
      shellPackage: readJson('electron/package.json'),
      copyWww: read('electron/scripts/copy-www.mjs'),
      window: read('electron/src/window.ts'),
      hostCapabilities: read('electron/src/host-capabilities.ts'),
      preload: read('electron/src/preload.ts'),
      builder: read('electron/electron-builder.yml'),
    },
    errors,
  );
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  }
}

async function runCli() {
  validateCurrentElectronHost();
  process.stdout.write(
    'Electron host contract is valid (first-class Nx application, shared renderer, versioned secure bridge, packaging and serialized journeys).\n',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
