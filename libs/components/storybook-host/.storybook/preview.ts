// The app's global stylesheets. See `global-styles.scss` for why they are composed there
// rather than imported here.
import './global-styles.scss';

import { type Decorator, type Preview } from '@storybook/angular-vite';
import { TRINITY_PALETTES } from '@trinity/platform-native';

/**
 * The two theme axes, exposed as toolbar controls so every story can be flipped through
 * every combination.
 *
 * This is the reason Storybook is here. A palette is meant to be a data change — a block of
 * token overrides plus a registry entry — and the only way to know that held was to launch
 * the app and navigate to each surface. Two dropdowns make it something you look at.
 *
 * The palette list is read from `TRINITY_PALETTES` rather than restated, so a new palette
 * appears in the toolbar the moment it is registered. If it looks wrong here, the token layer
 * is incomplete — which is the contract, stated in the redesign epic.
 */

/** How the app itself applies the axes: a class for mode, an attribute for palette. */
function applyTheme(palette: string, mode: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  // The default palette applies NO attribute — it is the `:root` block in variables.scss.
  if (palette === 'trinity') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', palette);
  }
}

const withTheme: Decorator = (story, context) => {
  const { palette, mode } = context.globals as {
    palette: string;
    mode: 'light' | 'dark';
  };
  applyTheme(palette, mode);
  // `global-styles.scss` paints these tokens on the preview body. This decorator only changes
  // which values they resolve to, keeping theme state separate from canvas presentation.
  return story();
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    palette: {
      description: 'Colour palette',
      defaultValue: 'trinity',
      toolbar: {
        icon: 'paintbrush',
        items: TRINITY_PALETTES.map(({ id, label }) => ({
          value: id,
          title: label,
        })),
        dynamicTitle: true,
      },
    },
    mode: {
      description: 'Light / dark',
      defaultValue: 'dark',
      toolbar: {
        icon: 'contrast',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
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
