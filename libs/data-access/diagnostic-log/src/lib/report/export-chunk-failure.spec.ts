import { TestBed } from '@angular/core/testing';
import { PREFERENCE_STORAGE_ADAPTER } from '@trinity/runtime/preferences';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticLogService } from '../diagnostic-log.service';
import {
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DIAGNOSTIC_LOG_STORE_REMOVER,
} from '../diagnostic-log.tokens';
import { MemoryLogStore } from '../store/diagnostic-log-store';
import type { DiagnosticReportProgress } from './prepare-report';

// A stale deploy: the export chunk is gone from the server, so its import rejects.
vi.mock('./load-report-export', () => ({
  loadReportExport: () =>
    Promise.reject(
      new TypeError('Failed to fetch dynamically imported module'),
    ),
}));

describe('a report when the export code fails to load', () => {
  it('still reports the facts, then fails the file alone', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DIAGNOSTIC_LOG_STORE_FACTORY,
          useValue: () => Promise.resolve(new MemoryLogStore()),
        },
        {
          provide: DIAGNOSTIC_LOG_STORE_REMOVER,
          useValue: () => Promise.resolve(),
        },
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' } as const),
            write: () => of({ kind: 'completed' } as const),
          },
        },
      ],
    });
    const service = TestBed.inject(DiagnosticLogService);
    service.start();
    const steps: DiagnosticReportProgress['kind'][] = [];

    const failure = await new Promise<unknown>((resolve) =>
      service.prepareReport().subscribe({
        next: (step) => steps.push(step.kind),
        error: resolve,
      }),
    );

    expect(steps).toEqual(['facts']);
    expect(failure).toBeInstanceOf(TypeError);
    TestBed.resetTestingModule();
  });
});
