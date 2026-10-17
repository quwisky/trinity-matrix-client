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
 * Theme, Mode and density as toolbar controls, so every story can be flipped through every
 * combination. Choices come from Theme Foundation's read-only catalog. If a Theme looks wrong
 * here, the token layer is incomplete.
 */

/** How the app applies these axes: a class for Mode and attributes for Theme/density. */
function applyAppearance(
  themeId: ThemeId,
  modeId: ResolvedThemeMode,
  density: 'cosy' | 'compact' | 'spacious',
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
    density: 'cosy' | 'compact' | 'spacious';
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
          { value: 'spacious', title: 'Spacious' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    controls: { expanded: true },
    // Not a substitute for the contrast spec (which measures token values): this catches what
    // a component does with them, e.g. an icon-only button with no name.
    a11y: { test: 'error' },
  },
};

export default preview;
