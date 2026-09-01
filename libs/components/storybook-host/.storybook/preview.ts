// App globals stay composed in SCSS so their shared dependencies load once. The preview head
// establishes the cascade before this bundle because Tailwind hoists its imported output.
import './global-styles.scss';

import { type Decorator, type Preview } from '@storybook/angular-vite';
import {
  THEME_CATALOG,
  type ResolvedThemeMode,
  type ThemeId,
} from '@trinity/theme-foundation';

const previewModes = THEME_CATALOG.modes.filter(
  ({ previewClass }) => previewClass !== null,
);
const defaultPreviewMode = THEME_CATALOG.modes.find(
  ({ previewClass }) => previewClass === 'dark',
);

if (!defaultPreviewMode) {
  throw new Error(
    'Theme Foundation must provide a dark Storybook preview Mode.',
  );
}

/**
 * Theme, Mode and density, exposed as toolbar controls so every story can be flipped through
 * every combination.
 *
 * This is the reason Storybook is here. A palette is meant to be a data change — a block of
 * token overrides plus a registry entry — and the only way to know that held was to launch
 * the app and navigate to each surface. Three dropdowns make it something you look at.
 *
 * Theme and Mode choices come from Theme Foundation's read-only catalog, so preview metadata
 * has the same single owner as the application selector. If a Theme looks wrong here, the
 * token layer is incomplete — which is the contract, stated in the redesign epic.
 */

/** How the app applies these axes: a class for Mode and attributes for Theme/density. */
function applyAppearance(
  themeId: ThemeId,
  modeId: ResolvedThemeMode,
  density: 'cosy' | 'compact',
): void {
  const theme = THEME_CATALOG.themes.find(({ id }) => id === themeId);
  const mode = previewModes.find(({ id }) => id === modeId);
  if (!theme || !mode) {
    throw new Error(`Unknown Storybook appearance: ${themeId}/${modeId}`);
  }

  const root = document.documentElement;
  root.classList.toggle('dark', mode.previewClass === 'dark');
  // The default Theme applies NO attribute — its catalog carrier is intentionally absent.
  if (theme.dataTheme === null) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme.dataTheme);
  }
  if (density === 'cosy') {
    root.removeAttribute('data-density');
  } else {
    root.setAttribute('data-density', density);
  }
}

const withTheme: Decorator = (story, context) => {
  const { theme, mode, density } = context.globals as {
    theme: ThemeId;
    mode: ResolvedThemeMode;
    density: 'cosy' | 'compact';
  };
  applyAppearance(theme, mode, density);
  // `global-styles.scss` paints these tokens on the preview body. This decorator only changes
  // which values they resolve to, keeping theme state separate from canvas presentation.
  return story();
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Theme',
      defaultValue: THEME_CATALOG.defaults.theme,
      toolbar: {
        icon: 'paintbrush',
        items: THEME_CATALOG.themes.map(({ id, label }) => ({
          value: id,
          title: label,
        })),
        dynamicTitle: true,
      },
    },
    mode: {
      description: 'Light / dark',
      defaultValue: defaultPreviewMode.id,
      toolbar: {
        icon: 'contrast',
        items: previewModes.map(({ id, label }) => ({
          value: id,
          title: label,
        })),
        dynamicTitle: true,
      },
    },
    density: {
      description: 'Component density',
      defaultValue: 'cosy',
      toolbar: {
        icon: 'component',
        items: [
          { value: 'cosy', title: 'Cosy' },
          { value: 'compact', title: 'Compact' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    controls: { expanded: true },
    // Not a substitute for the contrast spec — that measures the token values themselves.
    // This catches what a component does with them: an icon-only button with no name, a
    // control whose label is not associated with it.
    a11y: { test: 'error' },
  },
};

export default preview;
