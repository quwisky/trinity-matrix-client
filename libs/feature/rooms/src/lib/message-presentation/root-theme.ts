import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** The root attributes Appearance writes for the Mode (`dark` on the class list) and the Theme. */
const THEME_ATTRIBUTES = ['class', 'data-theme'];

/**
 * The current theme as a signal, for render-leaf code that must re-check what it painted.
 * Feature code cannot import `application/appearance`, so this watches its result: one
 * `MutationObserver` on the document root for the app's lifetime, publishing a key that changes
 * only when the mode or the theme does.
 */
@Injectable({ providedIn: 'root' })
export class RootThemeObserver {
  private readonly root = inject(DOCUMENT).documentElement;
  private readonly current = signal(themeKey(this.root));

  /** `'<dark|light>|<data-theme>'`; equal keys mean the same Mode and Theme. */
  readonly key = this.current.asReadonly();

  constructor() {
    const observer = new MutationObserver(() =>
      this.current.set(themeKey(this.root)),
    );
    observer.observe(this.root, {
      attributes: true,
      attributeFilter: THEME_ATTRIBUTES,
    });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}

function themeKey(root: Element): string {
  return `${root.classList.contains('dark') ? 'dark' : 'light'}|${root.getAttribute('data-theme') ?? ''}`;
}
