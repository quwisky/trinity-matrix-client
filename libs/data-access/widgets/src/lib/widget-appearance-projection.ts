import { InjectionToken, type Signal } from '@angular/core';
import type { ResolvedThemeMode } from '@trinity/theme-foundation';

/** Read-only application projection widgets may disclose to an external integration. */
export interface WidgetAppearanceProjection {
  readonly resolved: Signal<{ readonly mode: ResolvedThemeMode } | undefined>;
}

export const WIDGET_APPEARANCE_PROJECTION =
  new InjectionToken<WidgetAppearanceProjection>(
    'WIDGET_APPEARANCE_PROJECTION',
  );
