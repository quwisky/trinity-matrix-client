/** Metadata used to activate and preview one bundled Theme without copying CSS values. */
export interface ThemeCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** Absent for Trinity so the default Theme leaves no carrier on the document root. */
  readonly dataTheme: string | null;
}

/** A user-selectable Mode. `system` resolves to one of the two previewable Modes. */
export interface ThemeModeCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** The root class for a fixed preview, or null when the OS resolves the Mode. */
  readonly previewClass: 'dark' | '' | null;
}

const themes = Object.freeze([
  Object.freeze({ id: 'trinity', label: 'Trinity', dataTheme: null }),
  Object.freeze({ id: 'amethyst', label: 'Amethyst', dataTheme: 'amethyst' }),
  Object.freeze({ id: 'onyx', label: 'Onyx', dataTheme: 'onyx' }),
] as const satisfies readonly ThemeCatalogEntry[]);

const modes = Object.freeze([
  Object.freeze({
    id: 'system',
    label: 'Use system setting',
    previewClass: null,
  }),
  Object.freeze({ id: 'light', label: 'Light', previewClass: '' }),
  Object.freeze({ id: 'dark', label: 'Dark', previewClass: 'dark' }),
] as const satisfies readonly ThemeModeCatalogEntry[]);

/** The named visual token set selected independently from Mode. */
export type ThemeId = (typeof themes)[number]['id'];
/** The user's Mode choice, including following the operating system. */
export type ThemeMode = (typeof modes)[number]['id'];
/** A fixed Mode after `system` has resolved. */
export type ResolvedThemeMode = Exclude<ThemeMode, 'system'>;

const previewCombinations = Object.freeze(
  themes.flatMap((theme) =>
    modes.flatMap((mode) =>
      mode.previewClass === null
        ? []
        : [Object.freeze({ theme: theme.id, mode: mode.id })],
    ),
  ),
) as readonly Readonly<{
  theme: ThemeId;
  mode: ResolvedThemeMode;
}>[];

const colorRoles = Object.freeze([
  '--trinity-rail',
  '--trinity-sidebar',
  '--trinity-sidebar-header',
  '--trinity-chat',
  '--trinity-members',
  '--trinity-hover',
  '--trinity-active',
  '--trinity-divider',
  '--trinity-surface',
  '--trinity-surface-frame',
  '--trinity-surface-navigation',
  '--trinity-surface-navigation-header',
  '--trinity-surface-workspace',
  '--trinity-surface-raised',
  '--trinity-surface-floating',
  '--trinity-surface-panel',
  '--trinity-surface-canvas',
  '--trinity-surface-card',
  '--trinity-surface-popover',
  '--trinity-surface-control',
  '--trinity-border-subtle',
  '--trinity-border-strong',
  '--trinity-border-control',
  '--trinity-text',
  '--trinity-text-muted',
  '--trinity-text-bright',
  '--trinity-control-foreground',
  '--trinity-control-secondary-foreground',
  '--trinity-control-accent-foreground',
  '--trinity-control-muted-foreground',
  '--trinity-accent',
  '--trinity-accent-hover',
  '--trinity-accent-foreground',
  '--trinity-link',
  '--trinity-green',
  '--trinity-green-foreground',
  '--trinity-danger',
  '--trinity-danger-solid',
  '--trinity-danger-solid-foreground',
  '--trinity-danger-tint-10',
  '--trinity-danger-tint-20',
  '--trinity-danger-tint-30',
  '--trinity-status-danger-surface',
  '--trinity-status-danger-surface-foreground',
  '--trinity-status-success-surface',
  '--trinity-status-success-surface-foreground',
  '--trinity-status-warning-surface',
  '--trinity-status-warning-surface-foreground',
  '--trinity-status-neutral-surface',
  '--trinity-status-neutral-foreground',
  '--trinity-state-hover-surface',
  '--trinity-state-hover-foreground',
  '--trinity-state-pressed-surface',
  '--trinity-state-pressed-foreground',
  '--trinity-state-selected-surface',
  '--trinity-state-selected-foreground',
  '--trinity-state-selected-hover-surface',
  '--trinity-state-selected-hover-foreground',
  '--trinity-state-attention-surface',
  '--trinity-state-attention-foreground',
  '--trinity-focus-ring',
  '--trinity-focus-ring-on-attention',
  '--trinity-focus-ring-halo',
  '--trinity-tooltip-surface',
  '--trinity-tooltip-foreground',
  '--trinity-camera-scrim',
  '--trinity-qr-surface',
  '--trinity-media-matte',
  '--trinity-syntax-plain',
  '--trinity-syntax-keyword',
  '--trinity-syntax-string',
  '--trinity-syntax-number',
  '--trinity-syntax-comment',
  '--trinity-syntax-function',
  '--trinity-syntax-type',
  '--trinity-syntax-variable',
  '--trinity-syntax-punctuation',
] as const);

const elevationRoles = Object.freeze([
  '--trinity-shadow-raised',
  '--trinity-shadow-floating',
  '--trinity-shadow-overlay',
] as const);

/**
 * Theme Foundation's only TypeScript catalog.
 *
 * It intentionally contains identity, carrier and preview metadata, never resolved CSS
 * values. Theme authors may override only the governed semantic color and elevation roles;
 * fonts, assets, arbitrary selectors and Helm/Tailwind mappings stay implementation details.
 */
export const THEME_CATALOG = Object.freeze({
  themes,
  modes,
  defaults: Object.freeze({ theme: 'trinity', mode: 'system' } as const),
  preview: Object.freeze({
    combinations: previewCombinations,
    swatches: Object.freeze([
      '--trinity-surface-workspace',
      '--trinity-accent',
      '--trinity-text',
    ] as const),
  }),
  authoring: Object.freeze({ colorRoles, elevationRoles }),
});
