import { Subject, defer, firstValueFrom, filter, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticBundle } from '../diagnostic-bundle';
import type { DiagnosticSnapshot } from '../store/diagnostic-log-store';
import { prepareDiagnosticReport } from './prepare-report';

describe('prepareDiagnosticReport', () => {
  it('reads the names only once the log snapshot is taken', async () => {
    const snapshot = new Subject<DiagnosticSnapshot>();
    const readNames = vi.fn(() => of([]));
    const bundle = vi.fn(() => of({} as DiagnosticBundle));

    const report = firstValueFrom(
      prepareDiagnosticReport({
        build: null,
        platform: () => 'test',
        accounts: of([]),
        knownNames: defer(readNames),
        snapshot,
        bundle,
      }).pipe(filter((step) => step.kind === 'bundle')),
    );
    await Promise.resolve();
    expect(readNames).not.toHaveBeenCalled();

    snapshot.next({ entries: [], storage: 'memory', dropped: false });
    snapshot.complete();
    await report;

    expect(readNames).toHaveBeenCalledTimes(1);
    expect(bundle).toHaveBeenCalledTimes(1);
  });
});
