const { join } = require('node:path');

/**
 * Tailwind config for the spartan.ng ("helm") components in @trinity/ui-spartan.
 *
 * Coexistence with Ionic:
 *  - `preflight` is OFF so Tailwind's global reset never fights Ionic's own base
 *    styles. Helm components that need a border therefore also carry `border-solid`
 *    (preflight is what normally sets `border-style`).
 *  - Dark mode is keyed off `.ion-palette-dark` — the exact class ThemeService
 *    toggles on <html> — so spartan tokens flip with the rest of the app, no extra
 *    wiring. `hsl(var(--x))` tokens are defined in apps/trinity/src/theme/spartan.css.
 */
module.exports = {
  darkMode: ['selector', '.ion-palette-dark'],
  content: [
    join(__dirname, 'apps/**/*.{html,ts}'),
    join(__dirname, 'libs/**/*.{html,ts}'),
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};
