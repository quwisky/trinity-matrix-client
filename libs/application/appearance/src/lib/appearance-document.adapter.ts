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
  ROOM_LIST_PREFERENCE,
  TEXT_SIZE_OPTIONS,
} from './design-system-appearance-preferences';
import type { ResolvedAppearance } from './appearance-resolution';

const DARK_CLASS = 'dark';
const THEME_ATTRIBUTE = 'data-theme';
const DENSITY_ATTRIBUTE = 'data-density';
const ROOM_LIST_ATTRIBUTE = 'data-room-list';
const CODE_LINE_ATTRIBUTE = 'data-code-lines';
const CODE_SIZE_PROPERTY = '--trinity-code-scale';
/** iOS body text at its default Large Dynamic Type size. */
const IOS_DEFAULT_BODY_PX = 17;
const IOS_BODY_FONT = '-apple-system-body';

/**
 * A hidden element whose font is iOS body text, so its size follows Dynamic Type. Only a
 * touch-first WebKit knows `-apple-system-body`, so Mac Safari, Android and other browsers
 * get null and a scale of 1.
 */
function createDeviceTextProbe(doc: Document): HTMLElement | null {
  const win = doc.defaultView;
  if (
    !win ||
    typeof win.matchMedia !== 'function' ||
    !win.matchMedia('(hover: none) and (pointer: coarse)').matches ||
    !CSS.supports('font', IOS_BODY_FONT)
  ) {
    return null;
  }
  const probe = doc.createElement('span');
  probe.style.cssText = `font:${IOS_BODY_FONT};display:none`;
  doc.documentElement.append(probe);
  return probe;
}

/** How much larger than its default the device's text size is. */
export function deviceTextScale(probe: Element | null, win: Window): number {
  const px = probe
    ? Number.parseFloat(win.getComputedStyle(probe).fontSize)
    : 0;
  return px > 0 ? px / IOS_DEFAULT_BODY_PX : 1;
}

/** Imperative boundary that owns Appearance's document-root carriers. */
export interface AppearanceDocumentAdapter {
  apply(appearance: ResolvedAppearance): void;
}

@Injectable({ providedIn: 'root' })
export class BrowserAppearanceDocumentAdapter implements AppearanceDocumentAdapter {
  private readonly document = inject(DOCUMENT);
  private readonly root = this.document.documentElement;
  private readonly probe = createDeviceTextProbe(this.document);
  private last: ResolvedAppearance | undefined;

  constructor() {
    // WebKit fires no event for a Dynamic Type change, so read it again whenever the app
    // returns from Settings.
    if (this.probe) {
      const reapply = (): void => this.reapply();
      this.document.addEventListener('visibilitychange', reapply);
      this.document.defaultView?.addEventListener('focus', reapply);
    }
  }

  apply(appearance: ResolvedAppearance): void {
    this.last = appearance;
    this.root.classList.toggle(DARK_CLASS, appearance.mode === 'dark');
    this.applyTheme(appearance);
    this.applyTextSize(appearance);
    this.applyDensity(appearance);
    this.applyRoomList(appearance);
    this.applyCodeSize(appearance);
    this.applyCodeLines(appearance);
  }

  private reapply(): void {
    if (this.last) this.applyTextSize(this.last);
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
    const win = this.document.defaultView;
    const percent =
      (option?.percent ?? 100) * (win ? deviceTextScale(this.probe, win) : 1);
    if (percent === 100) {
      this.root.style.removeProperty('font-size');
      return;
    }
    this.root.style.setProperty('font-size', `${percent}%`);
  }

  private applyDensity(appearance: ResolvedAppearance): void {
    this.applyAttribute(
      DENSITY_ATTRIBUTE,
      appearance.density === DENSITY_PREFERENCE.defaultValue
        ? null
        : appearance.density,
    );
  }

  private applyRoomList(appearance: ResolvedAppearance): void {
    this.applyAttribute(
      ROOM_LIST_ATTRIBUTE,
      appearance.roomList === ROOM_LIST_PREFERENCE.defaultValue
        ? null
        : appearance.roomList,
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

/**
 * Appearance stamps the Mode only after preferences load, seconds into a cold start. Until
 * then the app would render light over the dark boot splash, so startup seeds it from the
 * system, the default preference. Appearance overrides it once the stored Mode is known.
 */
export function seedSystemColourMode(
  doc: Document = document,
  win: Window = window,
): void {
  // This runs before bootstrap, so a throw here would leave a blank app.
  if (typeof win.matchMedia !== 'function') return;
  doc.documentElement.classList.toggle(
    DARK_CLASS,
    win.matchMedia('(prefers-color-scheme: dark)').matches,
  );
}

export const APPEARANCE_DOCUMENT_ADAPTER =
  new InjectionToken<AppearanceDocumentAdapter>('APPEARANCE_DOCUMENT_ADAPTER', {
    providedIn: 'root',
    factory: () => inject(BrowserAppearanceDocumentAdapter),
  });
