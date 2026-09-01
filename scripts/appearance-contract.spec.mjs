import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the completed Appearance contraction.
 *
 * ThemeService was an incremental compatibility facade while preferences, startup, native
 * chrome and widgets moved to their capability-owned seams. Its frozen production caller count
 * reached zero before deletion. These checks keep that deletion final: old keys may be read only
 * by descriptor migration, old portable paths may be read only by the version-one importer, and
 * document carriers may be written only by the Appearance effect adapter.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter((file) => !/\.(?:spec|stories)\.ts$/u.test(file))
  .sort();
const productionTemplates = globSync(['apps/**/*.html', 'libs/**/*.html'], {
  cwd: workspaceRoot,
}).sort();

const filesContaining = (literal) =>
  productionSources.filter((file) => read(file).includes(literal));
const appearanceSettingsSources = globSync(
  [
    'libs/feature/settings/src/lib/appearance/**/*.ts',
    'libs/feature/settings/src/lib/appearance/**/*.html',
  ],
  { cwd: workspaceRoot },
)
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();
const legitimateColorPaletteFiles = new Set([
  'libs/components/foundations/src/lib/icon/trn-icon.icons.ts',
  'libs/components/foundations/src/lib/icon/trn-icon-name.ts',
  'libs/components/generic-content/src/lib/avatar/avatar.component.ts',
  'libs/feature/settings/src/lib/settings-sections.ts',
]);
const currentThemeVocabularySources = globSync(
  [
    'docs/**/*.md',
    'apps/**/*.{ts,html,scss,css,md}',
    'libs/**/*.{ts,html,scss,css,md}',
    'e2e/**/*.{ts,mts,js,mjs,md}',
    'scripts/**/*.{ts,mts,js,mjs,md}',
  ],
  { cwd: workspaceRoot },
)
  .filter((file) => !/\.spec\.ts$/u.test(file))
  .filter((file) => file !== 'scripts/appearance-contract.spec.mjs')
  .filter((file) => !legitimateColorPaletteFiles.has(file))
  .sort();

const LEGACY_STORAGE_OWNERS = new Map([
  [
    'trinity.theme',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.palette',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.text-scale',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.density',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.code-scale',
    'libs/data-access/timeline/src/lib/appearance-preferences.ts',
  ],
  [
    'trinity.code-lines',
    'libs/data-access/timeline/src/lib/appearance-preferences.ts',
  ],
]);

const CURRENT_STORAGE_OWNERS = new Map([
  [
    'trinity.appearance.mode',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.appearance.theme',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.appearance.text-size',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.appearance.density',
    'libs/application/appearance/src/lib/design-system-appearance-preferences.ts',
  ],
  [
    'trinity.appearance.code-size',
    'libs/data-access/timeline/src/lib/appearance-preferences.ts',
  ],
  [
    'trinity.appearance.code-line-presentation',
    'libs/data-access/timeline/src/lib/appearance-preferences.ts',
  ],
]);

const LEGACY_PORTABLE_PATHS = [
  'theme.mode',
  'theme.palette',
  'theme.textScale',
  'theme.density',
  'theme.codeScale',
  'theme.codeLineNumbers',
];

describe('Appearance contraction', () => {
  it('keeps the compatibility facade deleted after its caller count reached zero', () => {
    expect(
      existsSync(
        join(workspaceRoot, 'libs/platform-native/src/lib/theme.service.ts'),
      ),
    ).toBe(false);
    expect(
      productionSources.filter((file) =>
        /\bThemeService\b|theme[.]service/u.test(read(file)),
      ),
    ).toEqual([]);
  });

  it('does not restore the legacy public Appearance API', () => {
    const legacyPublicApi =
      /\b(?:ThemePreference|ResolvedTheme|Palette|TextScale|Density|CodeScale|CodeLineMode|DEFAULT_PALETTE|DEFAULT_TEXT_SCALE|DEFAULT_DENSITY|DEFAULT_CODE_SCALE|DEFAULT_CODE_LINE_MODE|DEFAULT_THEME_PREFERENCE|TRINITY_TEXT_SCALES|TRINITY_DENSITIES|TRINITY_CODE_SCALES|TRINITY_CODE_LINE_MODES|isThemePreference|isPalette|isTextScale|isDensity|isCodeScale|isCodeLineMode)\b/u;
    expect(
      productionSources.filter((file) => legacyPublicApi.test(read(file))),
    ).toEqual([]);
  });

  it('keeps predecessor storage keys in read-only migration metadata', () => {
    const ledger = 'libs/platform-native/src/lib/config-schema.ts';
    for (const [key, owner] of LEGACY_STORAGE_OWNERS) {
      expect(filesContaining(`'${key}'`)).toEqual([owner, ledger].sort());
      expect(read(owner)).toMatch(
        new RegExp(
          `legacyKeys:\\s*\\[[^\\]]*'${key.replaceAll('.', '[.]')}'`,
          'u',
        ),
      );
    }
  });

  it('keeps current storage keys behind their descriptors', () => {
    const ledger = 'libs/platform-native/src/lib/config-schema.ts';
    for (const [key, owner] of CURRENT_STORAGE_OWNERS) {
      expect(filesContaining(`'${key}'`)).toEqual([owner, ledger].sort());
    }
  });

  it('keeps version-one Theme paths inside the one-way importer only', () => {
    const importer = 'libs/platform-native/src/lib/config-plan.ts';
    for (const path of LEGACY_PORTABLE_PATHS) {
      expect(filesContaining(path)).toEqual([importer]);
    }
  });

  it('uses Mode and Theme vocabulary throughout current code, UI and documentation', () => {
    expect(
      appearanceSettingsSources.filter((file) =>
        /\bpalette\b|palette-|Palette/u.test(read(file)),
      ),
    ).toEqual([]);
    expect(
      currentThemeVocabularySources.filter((file) =>
        /\bpalettes?\b/iu.test(
          read(file)
            .replaceAll('trinity.palette', '')
            .replaceAll('theme.palette', '')
            .replaceAll('TRINITY_PALETTES', '')
            .replaceAll('(?:PALETTES|THEME_MODES)', '(?:THEME_MODES)'),
        ),
      ),
    ).toEqual([]);
  });

  it('gives one adapter ownership of every document-root Appearance carrier', () => {
    const adapter =
      'libs/application/appearance/src/lib/appearance-document.adapter.ts';
    for (const carrier of [
      'data-theme',
      'data-density',
      'data-code-lines',
      '--trinity-code-scale',
    ]) {
      expect(filesContaining(`'${carrier}'`)).toEqual([adapter]);
    }
    expect(filesContaining("'font-size'")).toEqual([adapter]);
    expect(filesContaining('documentElement')).toEqual([adapter]);
    expect(filesContaining('DARK_CLASS')).toEqual([adapter]);
    expect(filesContaining('classList.toggle(DARK_CLASS')).toEqual([adapter]);
    expect(filesContaining('BrowserAppearanceDocumentAdapter')).toEqual([
      adapter,
    ]);
    expect(filesContaining('APPEARANCE_DOCUMENT_ADAPTER')).toEqual([
      adapter,
      'libs/application/appearance/src/lib/appearance-effects.ts',
    ]);

    const templateWritesRootCarrier = (file) => {
      const source = read(file);
      const hasBoundCarrier =
        /\[(?:attr\.)?(?:data-theme|data-density|data-code-lines)\]|\[style\.(?:font-size|--trinity-code-scale)\]|\[class\.dark\]|\[(?:class|ngClass)\]\s*=\s*["'][^"']*\bdark\b/iu.test(
          source,
        );
      const hasStaticDarkCarrier = Array.from(
        source.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gsu),
        ([, , classes]) => classes.split(/\s+/u).includes('dark'),
      ).some(Boolean);
      return hasBoundCarrier || hasStaticDarkCarrier;
    };
    expect(productionTemplates.filter(templateWritesRootCarrier)).toEqual([]);
  });

  it('keeps native chrome behind the resolved-Mode adapter', () => {
    expect(filesContaining('StatusBar.setStyle')).toEqual([
      'libs/platform-native/src/lib/native-appearance-chrome.adapter.ts',
    ]);
  });

  it('gives Application Runtime sole ownership of the Appearance effect lifetime', () => {
    expect(filesContaining('appearanceEffects.run()')).toEqual([
      'libs/application/runtime/src/lib/composition/trinity-application-runtime.adapter.ts',
    ]);
  });

  it('keeps widget Appearance behind its read-only projection boundary', () => {
    const provider =
      'libs/application/runtime/src/lib/composition/application-capability.providers.ts';
    const projection =
      'libs/data-access/widgets/src/lib/widget-appearance-projection.ts';
    const consumer = 'libs/data-access/widgets/src/lib/widgets.service.ts';

    expect(filesContaining('WIDGET_APPEARANCE_PROJECTION')).toEqual(
      [provider, projection, consumer].sort(),
    );
    expect(filesContaining('inject(WIDGET_APPEARANCE_PROJECTION)')).toEqual([
      consumer,
    ]);
    expect(read(provider)).toContain(
      'resolved: inject(AppearanceEffects).resolved',
    );
  });
});
