export type ProjectionTraceKind =
  'activate' | 'invalidate' | 'publish' | 'stale-drop' | 'release';

export interface ProjectionTraceEvent {
  readonly kind: ProjectionTraceKind;
  readonly id: string;
  readonly scope: string | null;
  readonly generation: number;
}

export type ProjectionTraceSink = (event: ProjectionTraceEvent) => void;

const FLAG = 'trinity.debug.projections';
let sink: ProjectionTraceSink | null = null;

/** Route trace events to a test or debugging sink instead of the console. */
export function setProjectionTraceSink(next: ProjectionTraceSink | null): void {
  sink = next;
}

function flagged(): boolean {
  try {
    return globalThis.localStorage?.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

/**
 * Development-only lifetime trace (#927). Call sites wrap it in `ngDevMode`, so production
 * builds drop both the calls and this module; in development it stays silent unless
 * `localStorage['trinity.debug.projections'] = '1'`.
 */
export function traceProjection(event: ProjectionTraceEvent): void {
  if (sink) {
    sink(event);
    return;
  }
  if (flagged()) {
    console.debug(
      '[projection]',
      event.kind,
      event.id,
      event.scope ?? '-',
      `gen ${event.generation}`,
    );
  }
}
