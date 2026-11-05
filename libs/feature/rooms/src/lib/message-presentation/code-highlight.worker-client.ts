import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import {
  CodeHighlightClient,
  createHighlightWorker,
} from './code-highlight.client';
import type { CodeLanguage } from './code-languages';

/** Starts the highlight worker; tests replace it with a fake or with `() => null`. */
export const HIGHLIGHT_WORKER_FACTORY = new InjectionToken<() => Worker | null>(
  'HIGHLIGHT_WORKER_FACTORY',
  {
    providedIn: 'root',
    factory: () => createHighlightWorker,
  },
);

/** How long a block whose grammar failed to load waits before it is sent again. */
export const RETRY_DELAY_MS = 5_000;

/** One highlight worker per session, started by the first code block in a known language. */
@Injectable({ providedIn: 'root' })
export class HighlightWorker {
  private readonly create = inject(HIGHLIGHT_WORKER_FACTORY);
  private readonly retries = signal(0);
  private started: CodeHighlightClient | null = null;
  private retryScheduled = false;

  /** The text each block was last sent with, so a re-render does not resend it. */
  readonly sent = new WeakMap<Element, string>();
  /** Changes when blocks waiting for a retry may be sent again; effects read it to re-run. */
  readonly retryTick = this.retries.asReadonly();

  client(): CodeHighlightClient {
    this.started ??= new CodeHighlightClient(this.create);
    return this.started;
  }

  /** Forget `code` was sent and send it again after the retry delay. */
  retryLater(code: Element): void {
    this.sent.delete(code);
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    setTimeout(() => {
      this.retryScheduled = false;
      this.retries.update((n) => n + 1);
    }, RETRY_DELAY_MS);
  }
}

type Highlighter = typeof import('./code-highlight');

/**
 * The main-thread path: highlight.js core and each grammar, loaded once per session. Used where
 * the worker cannot start, or after it fails.
 */
@Injectable({ providedIn: 'root' })
export class HighlightFallback {
  private readonly loaded = signal<Highlighter | null>(null);
  private readonly ready = signal<ReadonlySet<string>>(new Set());
  private readonly inFlight = new Set<string>();
  private coreRequested = false;

  readonly core = this.loaded.asReadonly();
  /** Language ids whose grammar is registered; replaced, never mutated, so effects re-run. */
  readonly registered = this.ready.asReadonly();

  /** Fetch highlight.js core once; a failed fetch allows a retry on the next render. */
  loadCore(): void {
    if (this.coreRequested) return;
    this.coreRequested = true;
    import('./code-highlight').then(
      (module) => this.loaded.set(module),
      () => (this.coreRequested = false),
    );
  }

  /** Fetch one grammar once; a failed fetch is forgotten so a later render retries it. */
  loadLanguage(highlighter: Highlighter, language: CodeLanguage): void {
    if (this.inFlight.has(language.id) || this.ready().has(language.id)) {
      return;
    }
    this.inFlight.add(language.id);
    language.load().then(
      (module) => {
        this.inFlight.delete(language.id);
        highlighter.registerLanguage(language.id, module.default);
        this.ready.update((ids) => new Set(ids).add(language.id));
      },
      () => this.inFlight.delete(language.id),
    );
  }
}
