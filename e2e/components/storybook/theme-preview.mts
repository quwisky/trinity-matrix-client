import { expect, type Page } from '@playwright/test';
import {
  THEME_CATALOG,
  type ResolvedThemeMode,
  type ThemeCatalogEntry,
  type ThemeId,
  type ThemeModeCatalogEntry,
} from '@trinity/theme-foundation';

export interface StorybookThemePreview {
  readonly theme: ThemeCatalogEntry & { readonly id: ThemeId };
  readonly mode: ThemeModeCatalogEntry & {
    readonly id: ResolvedThemeMode;
    readonly previewClass: 'dark' | '';
  };
}

function themeEntry(themeId: ThemeId): StorybookThemePreview['theme'] {
  const theme = THEME_CATALOG.themes.find(({ id }) => id === themeId);
  if (!theme) throw new Error(`Theme Foundation has no Theme ${themeId}`);
  return theme;
}

function modeEntry(modeId: ResolvedThemeMode): StorybookThemePreview['mode'] {
  const mode = THEME_CATALOG.modes.find(({ id }) => id === modeId);
  if (!mode || mode.previewClass === null) {
    throw new Error(`Theme Foundation has no resolved Mode ${modeId}`);
  }
  return mode;
}

export const STORYBOOK_THEME_PREVIEWS: readonly StorybookThemePreview[] =
  THEME_CATALOG.preview.combinations.map(({ theme, mode }) => ({
    theme: themeEntry(theme),
    mode: modeEntry(mode),
  }));

const defaultMode = THEME_CATALOG.modes.find(
  ({ previewClass }) => previewClass === 'dark',
);

if (!defaultMode || defaultMode.previewClass === null) {
  throw new Error(
    'Theme Foundation must provide a dark Storybook preview Mode.',
  );
}

export const DEFAULT_STORYBOOK_THEME_PREVIEW: StorybookThemePreview = {
  theme: themeEntry(THEME_CATALOG.defaults.theme),
  mode: modeEntry(defaultMode.id),
};

export function storybookThemeGlobals(
  preview:
    | StorybookThemePreview
    | {
        readonly theme: ThemeId;
        readonly mode: ResolvedThemeMode;
      },
  density?: 'cosy' | 'compact',
): string {
  const theme =
    typeof preview.theme === 'string' ? preview.theme : preview.theme.id;
  const mode =
    typeof preview.mode === 'string' ? preview.mode : preview.mode.id;
  const values = [`mode:${mode}`, `theme:${theme}`];
  if (density) values.push(`density:${density}`);
  return encodeURIComponent(values.join(';'));
}

export async function expectStorybookThemeRoot(
  page: Page,
  preview: StorybookThemePreview,
): Promise<void> {
  await expect
    .poll(() =>
      page.locator('html').evaluate((root) => ({
        dark: root.classList.contains('dark'),
        themeCarrier: root.getAttribute('data-theme'),
      })),
    )
    .toEqual({
      dark: preview.mode.previewClass === 'dark',
      themeCarrier: preview.theme.dataTheme,
    });
}
