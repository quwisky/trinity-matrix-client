import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import {
  WhatsNewService,
  type ReleaseNote,
} from '@trinity/data-access/whats-new';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { WHATS_NEW_DIALOG_COMPONENT } from '../application-dialog-loaders';
import { WhatsNewLauncherAdapter } from './whats-new-launcher.adapter';

@Component({
  selector: 'trn-fake-whats-new',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class FakeWhatsNewDialogComponent {}

const note = (version: string): ReleaseNote => ({
  version,
  date: '2026-10-01',
  sections: { added: ['Something'] },
});
const newer = [note('0.5.0')];
const bundled = [note('0.5.0'), note('0.4.0')];

function setup(
  pending: Observable<readonly ReleaseNote[]>[],
  load: () => Observable<typeof FakeWhatsNewDialogComponent> = () =>
    of(FakeWhatsNewDialogComponent),
) {
  const closed = new Subject<void>();
  const open = vi.fn(() => ({ closed }));
  const markSeen = vi.fn(() => of(true));
  const queue = [...pending];
  const record = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: WHATS_NEW_DIALOG_COMPONENT, useValue: vi.fn(load) },
      MockProvider(TrnSurfaceService, { open } as never),
      MockProvider(DiagnosticLogService, { record }),
      MockProvider(WhatsNewService, {
        all: bundled,
        pending: () => queue.shift() ?? of([]),
        markSeen,
      }),
    ],
  });
  return {
    launcher: TestBed.inject(WhatsNewLauncherAdapter),
    open,
    markSeen,
    record,
    closed,
  };
}

describe('WhatsNewLauncherAdapter', () => {
  it('opens the pending notes and marks them seen', () => {
    const { launcher, open, markSeen } = setup([of(newer)]);

    launcher.runPending().subscribe();

    expect(markSeen).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(FakeWhatsNewDialogComponent, {
      ariaLabel: "What's new in Trinity",
      autoFocus: 'first-heading',
      inputs: { releases: newer },
    });
  });

  it('does nothing when nothing is pending', () => {
    const { launcher, open, markSeen } = setup([of([])]);

    launcher.runPending().subscribe();

    expect(open).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('opens one dialog at a time and does not reopen after sign-in again', () => {
    const { launcher, open } = setup([of(newer), of([])]);

    launcher.runPending().subscribe();
    launcher.showAll();
    launcher.runPending().subscribe();

    expect(open).toHaveBeenCalledOnce();
  });

  it('showAll opens every bundled release without marking seen', () => {
    const { launcher, open, markSeen } = setup([]);

    launcher.showAll();

    expect(open).toHaveBeenCalledWith(
      FakeWhatsNewDialogComponent,
      expect.objectContaining({ inputs: { releases: bundled } }),
    );
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('skips the dialog when the seen version cannot be stored', () => {
    const { launcher, open, markSeen } = setup([of(newer)]);
    markSeen.mockReturnValue(of(false));

    launcher.runPending().subscribe();

    expect(open).not.toHaveBeenCalled();
  });

  it('swallows a loader failure', () => {
    const { launcher, open, record } = setup([of(newer)], () =>
      throwError(() => new Error('chunk failed')),
    );

    expect(() => launcher.runPending().subscribe()).not.toThrow();

    expect(open).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
  });
});
