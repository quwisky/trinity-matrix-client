import { DOCUMENT, Injectable, inject, signal } from '@angular/core';

/** KaTeX's renderer from the lazy `maths-render` chunk. */
export type MathsRenderer = typeof import('./maths-render').renderMaths;

/** The non-injected styles bundle `apps/trinity/project.json` emits for KaTeX (Task 16). */
const KATEX_STYLESHEET = 'katex.css';

/**
 * Loads KaTeX for {@link MathsDirective}, once for the app and only when asked: the
 * `maths-render` chunk with a dynamic `import()`, and the KaTeX stylesheet as one
 * `<link data-trinity-katex>`. {@link renderer} is set only when BOTH have loaded, so maths is
 * never drawn without its styles. If either fails, the sender's fallback stays and the next
 * {@link load} retries: a failed stylesheet's `<link>` is removed, a loaded one is kept.
 */
@Injectable({ providedIn: 'root' })
export class MathsLoader {
  private readonly doc = inject(DOCUMENT);
  private readonly loaded = signal<MathsRenderer | null>(null);
  private requested = false;
  private stylesheet: Promise<void> | null = null;

  readonly renderer = this.loaded.asReadonly();

  load(): void {
    if (this.requested) {
      return;
    }
    this.requested = true;
    Promise.all([this.importRenderer(), this.loadStylesheet()]).then(
      ([render]) => this.loaded.set(render),
      () => (this.requested = false),
    );
  }

  /** The chunk's file name is matched by `apps/trinity/ngsw-config.json`; keep `maths-render`. */
  protected importRenderer(): Promise<MathsRenderer> {
    return import('./maths-render').then((module) => module.renderMaths);
  }

  private loadStylesheet(): Promise<void> {
    this.stylesheet ??= new Promise<void>((resolve, reject) => {
      const link = this.doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = KATEX_STYLESHEET;
      link.setAttribute('data-trinity-katex', '');
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener(
        'error',
        () => {
          link.remove();
          this.stylesheet = null;
          reject(new Error('The KaTeX stylesheet did not load.'));
        },
        { once: true },
      );
      this.doc.head.append(link);
    });
    return this.stylesheet;
  }
}
