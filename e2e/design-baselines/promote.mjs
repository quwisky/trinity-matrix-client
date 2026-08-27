import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform, release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { DESIGN_VIEWPORTS } from '../playwright/support/design-viewports.mts';

if (platform() !== 'linux') {
  throw new Error('Current-interface archives can only be promoted on Linux.');
}

const root = resolve(import.meta.dirname, '../..');
const captureRoot = join(root, 'dist/.playwright/current-baselines/captures');
const archiveRoot = join(root, 'e2e/design-baselines/archive');
const temporaryRoot = `${archiveRoot}.tmp-${process.pid}`;
const backupRoot = `${archiveRoot}.backup-${process.pid}`;
const archivedSurfaces = {
  'desktop-wide': [
    'login',
    'room-shell',
    'appearance-settings',
    'encryption-setup',
  ],
  'desktop-compact': ['room-shell', 'appearance-settings'],
  'phone-pixel-5': [
    'login',
    'room-shell',
    'appearance-settings',
    'encryption-setup',
  ],
};
const expected = Object.entries(archivedSurfaces).flatMap(
  ([profile, surfaces]) =>
    surfaces.map((surface) => `${surface}-${profile}-linux.png`),
);

const missing = expected.filter(
  (filename) => !existsSync(join(captureRoot, filename)),
);
if (missing.length > 0) {
  throw new Error(
    `Refusing to promote an incomplete capture set. Missing: ${missing.join(', ')}`,
  );
}

rmSync(temporaryRoot, { force: true, recursive: true });
rmSync(backupRoot, { force: true, recursive: true });
mkdirSync(temporaryRoot, { recursive: true });
for (const filename of expected) {
  copyFileSync(join(captureRoot, filename), join(temporaryRoot, filename));
}

const require = createRequire(import.meta.url);
const playwrightVersion = require('@playwright/test/package.json').version;
const browser = await chromium.launch({ headless: true });
const chromiumVersion = browser.version();
await browser.close();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const profiles = Object.fromEntries(
  Object.keys(archivedSurfaces).map((name) => {
    const profile = DESIGN_VIEWPORTS[name];
    return [name, { viewport: profile.viewport, screen: profile.screen }];
  }),
);
const manifest = {
  purpose:
    'Archival Phase 0 evidence of the pre-redesign application, not visual-regression baselines.',
  sourceCommit,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: platform(),
    kernel: release(),
    architecture: process.arch,
    node: process.version,
    playwright: playwrightVersion,
    chromium: chromiumVersion,
  },
  rendering: {
    colorScheme: 'dark',
    locale: 'en-US',
    timezone: 'UTC',
    reducedMotion: true,
    fontPolicy: 'Application system font; no replacement font injected.',
    normalizedText: [
      'message timestamps become 09:41',
      'settings build label becomes Trinity current baseline',
    ],
  },
  profiles,
  files: expected,
};
writeFileSync(
  join(temporaryRoot, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

try {
  if (existsSync(archiveRoot)) renameSync(archiveRoot, backupRoot);
  renameSync(temporaryRoot, archiveRoot);
  rmSync(backupRoot, { force: true, recursive: true });
} catch (error) {
  if (!existsSync(archiveRoot) && existsSync(backupRoot)) {
    renameSync(backupRoot, archiveRoot);
  }
  rmSync(temporaryRoot, { force: true, recursive: true });
  throw error;
}

console.log(
  `[current baselines] promoted ${expected.length} files to ${basename(archiveRoot)}/`,
);
