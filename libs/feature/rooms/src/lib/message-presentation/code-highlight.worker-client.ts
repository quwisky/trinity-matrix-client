import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  CodeHighlightClient,
  createHighlightWorker,
} from './code-highlight.client';

/** Starts the highlight worker; tests replace it with a fake or with `() => null`. */
export const HIGHLIGHT_WORKER_FACTORY = new InjectionToken<() => Worker | null>(
  'HIGHLIGHT_WORKER_FACTORY',
  {
    providedIn: 'root',
    factory: () => createHighlightWorker,
  },
);

/** One highlight worker per session, started by the first code block in a known language. */
@Injectable({ providedIn: 'root' })
export class HighlightWorker {
  private readonly create = inject(HIGHLIGHT_WORKER_FACTORY);
  private started: CodeHighlightClient | null = null;

  client(): CodeHighlightClient {
    this.started ??= new CodeHighlightClient(this.create);
    return this.started;
  }
}
