import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  CODE_LINE_PRESENTATION_PREFERENCE,
  CODE_SIZE_OPTIONS,
  CODE_SIZE_PREFERENCE,
} from '@trinity/data-access/timeline';
import { THEME_CATALOG } from '@trinity/theme-foundation';
import {
  DENSITY_PREFERENCE,
  TEXT_SIZE_OPTIONS,
  TEXT_SIZE_PREFERENCE,
} from './design-system-appearance-preferences';
import type { ResolvedAppearance } from './appearance-resolution';

const DARK_CLASS = 'dark';
const THEME_ATTRIBUTE = 'data-theme';
const DENSITY_ATTRIBUTE = 'data-density';
const CODE_LINE_ATTRIBUTE = 'data-code-lines';
const CODE_SIZE_PROPERTY = '--trinity-code-scale';

/** Imperative boundary that owns Appearance's document-root carriers. */
export interface AppearanceDocumentAdapter {
  apply(appearance: ResolvedAppearance): void;
}

@Injectable({ providedIn: 'root' })
export class BrowserAppearanceDocumentAdapter implements AppearanceDocumentAdapter {
  private readonly root = inject(DOCUMENT).documentElement;

  apply(appearance: ResolvedAppearance): void {
    this.root.classList.toggle(DARK_CLASS, appearance.mode === 'dark');
    this.applyTheme(appearance);
    this.applyTextSize(appearance);
    this.applyDensity(appearance);
    this.applyCodeSize(appearance);
    this.applyCodeLines(appearance);
  }

  private applyTheme(appearance: ResolvedAppearance): void {
    const carrier = THEME_CATALOG.themes.find(
      ({ id }) => id === appearance.theme,
    )?.dataTheme;
    this.applyAttribute(THEME_ATTRIBUTE, carrier ?? null);
  }

  private applyTextSize(appearance: ResolvedAppearance): void {
    const option = TEXT_SIZE_OPTIONS.find(
      ({ id }) => id === appearance.textSize,
    );
    if (!option || option.id === TEXT_SIZE_PREFERENCE.defaultValue) {
      this.root.style.removeProperty('font-size');
      return;
    }
    this.root.style.setProperty('font-size', `${option.percent}%`);
  }

  private applyDensity(appearance: ResolvedAppearance): void {
    this.applyAttribute(
      DENSITY_ATTRIBUTE,
      appearance.density === DENSITY_PREFERENCE.defaultValue
        ? null
        : appearance.density,
    );
  }

  private applyCodeSize(appearance: ResolvedAppearance): void {
    const option = CODE_SIZE_OPTIONS.find(
      ({ id }) => id === appearance.codeSize,
    );
    if (!option || option.id === CODE_SIZE_PREFERENCE.defaultValue) {
      this.root.style.removeProperty(CODE_SIZE_PROPERTY);
      return;
    }
    this.root.style.setProperty(CODE_SIZE_PROPERTY, String(option.factor));
  }

  private applyCodeLines(appearance: ResolvedAppearance): void {
    this.applyAttribute(
      CODE_LINE_ATTRIBUTE,
      appearance.codeLinePresentation ===
        CODE_LINE_PRESENTATION_PREFERENCE.defaultValue
        ? null
        : appearance.codeLinePresentation,
    );
  }

  private applyAttribute(name: string, value: string | null): void {
    if (value === null) {
      this.root.removeAttribute(name);
    } else {
      this.root.setAttribute(name, value);
    }
  }
}

export const APPEARANCE_DOCUMENT_ADAPTER =
  new InjectionToken<AppearanceDocumentAdapter>('APPEARANCE_DOCUMENT_ADAPTER', {
    providedIn: 'root',
    factory: () => inject(BrowserAppearanceDocumentAdapter),
  });
