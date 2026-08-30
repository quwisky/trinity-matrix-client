import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceRoot = join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(workspaceRoot, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

function withoutComments(source, preserveStrings = true) {
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

function imports(source) {
  const executableSource = withoutComments(source);
  return [
    ...executableSource.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/gu,
    ),
  ].map((match) => match[1]);
}

export function validateWebHostContract(input, errors) {
  const { project, e2eProject, main, composition, capacitor, electron, ngsw } =
    input;
  const executableMain = withoutComments(main, false);
  const executableComposition = withoutComments(composition, false);
  for (const tag of ['type:app', 'role:app', 'capability:composition']) {
    if (!project.tags?.includes(tag)) errors.push(`Web host is missing ${tag}`);
  }

  const mainLines = main.trimEnd().split('\n').length;
  if (mainLines > 60) {
    errors.push(
      `Web host main.ts must stay thin (60 lines max, found ${mainLines})`,
    );
  }
  for (const specifier of imports(main)) {
    if (/^@trinity\/(?:components|data-access|feature)\//u.test(specifier)) {
      errors.push(
        `Web host main.ts imports product implementation: ${specifier}`,
      );
    }
  }
  for (const required of [
    'provideTrinityApplication({',
    'provideServiceWorker(',
    '.then(startApplicationRuntime)',
    '!isInstalledNativePlatform()',
    '!isElectronRenderer()',
  ]) {
    if (!executableMain.includes(required)) {
      errors.push(
        `Web host main.ts is missing composition marker: ${required}`,
      );
    }
  }

  for (const required of [
    'provideBrowserGlobalErrorListeners()',
    'provide: APPLICATION_RUNTIME_ADAPTER',
    'provide: WORKSPACE_APPLICATION_SURFACE_PRESENTER',
    'applicationCapabilityProviders(options)',
  ]) {
    if (!executableComposition.includes(required)) {
      errors.push(
        `Application composition is missing ownership marker: ${required}`,
      );
    }
  }

  const build = project.targets?.build;
  if (
    build?.executor !== '@angular/build:application' ||
    build?.outputs?.[0] !== '{workspaceRoot}/www' ||
    build?.options?.outputPath?.base !== 'www' ||
    build?.options?.outputPath?.browser !== ''
  ) {
    errors.push('Web host build must emit the flat shared www artifact');
  }
  if (
    build?.configurations?.production?.serviceWorker !==
    'apps/trinity/ngsw-config.json'
  ) {
    errors.push(
      'Web host production build must emit the Angular service worker',
    );
  }
  const cryptoAsset = build?.options?.assets?.find(
    (asset) => asset.glob === 'matrix_sdk_crypto_wasm_bg.wasm',
  );
  if (cryptoAsset?.output !== 'assets/crypto') {
    errors.push('Web host build must emit crypto WASM under assets/crypto');
  }

  if (
    e2eProject.targets?.['web-e2e']?.options?.command !==
    'playwright test -c playwright.web.config.mts'
  ) {
    errors.push(
      'Web host must expose the production Web/PWA Playwright target',
    );
  }
  if (!/webDir:\s*['"]www['"]/u.test(capacitor)) {
    errors.push('Capacitor must consume the shared www artifact unchanged');
  }
  if (!/const src = join\(repoRoot, ['"]www['"]\)/u.test(electron)) {
    errors.push('Electron must consume the shared www artifact unchanged');
  }

  const appGroup = ngsw.assetGroups?.find((group) => group.name === 'app');
  const assetGroup = ngsw.assetGroups?.find((group) => group.name === 'assets');
  if (
    appGroup?.installMode !== 'prefetch' ||
    !appGroup.resources?.files?.includes('/manifest.webmanifest')
  ) {
    errors.push('Web service worker must prefetch the installable app shell');
  }
  if (
    assetGroup?.installMode !== 'prefetch' ||
    !assetGroup.resources?.files?.includes('/assets/**')
  ) {
    errors.push(
      'Web service worker must prefetch shared assets and crypto WASM',
    );
  }
}

export function validateCurrentWebHost() {
  const errors = [];
  validateWebHostContract(
    {
      project: readJson('apps/trinity/project.json'),
      e2eProject: readJson('e2e/project.json'),
      main: read('apps/trinity/src/main.ts'),
      composition: read(
        'libs/application/runtime/src/lib/composition/trinity-application.providers.ts',
      ),
      capacitor: read('capacitor.config.ts'),
      electron: read('electron/scripts/copy-www.mjs'),
      ngsw: readJson('apps/trinity/ngsw-config.json'),
    },
    errors,
  );
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  }
}

async function runCli() {
  validateCurrentWebHost();
  process.stdout.write(
    'Web host contract is valid (thin composition, shared artifact, production PWA verification).\n',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
