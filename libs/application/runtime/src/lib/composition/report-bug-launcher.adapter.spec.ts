import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { REPORT_BUG_DIALOG_COMPONENT } from '../application-dialog-loaders';
import { ReportBugLauncherAdapter } from './report-bug-launcher.adapter';

@Component({
  selector: 'trn-fake-report-bug',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class FakeReportBugDialogComponent {}

function setup(
  load: () => Observable<typeof FakeReportBugDialogComponent> = () =>
    of(FakeReportBugDialogComponent),
) {
  const closed = new Subject<void>();
  const open = vi.fn(() => ({ closed }));
  const show = vi.fn();
  const loader = vi.fn(load);
  TestBed.configureTestingModule({
    providers: [
      { provide: REPORT_BUG_DIALOG_COMPONENT, useValue: loader },
      MockProvider(TrnSurfaceService, { open } as never),
      MockProvider(TrnToastService, { show }),
    ],
  });
  return {
    launcher: TestBed.inject(ReportBugLauncherAdapter),
    loader,
    open,
    show,
    closed,
  };
}

describe('ReportBugLauncherAdapter', () => {
  it('loads the dialog when asked and keeps one open at a time', () => {
    const { launcher, loader, open, closed } = setup();

    launcher.open();
    launcher.open();

    expect(loader).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(FakeReportBugDialogComponent, {
      ariaLabel: 'Report a bug',
      autoFocus: '[data-autofocus]',
    });

    closed.next();
    launcher.open();

    expect(open).toHaveBeenCalledTimes(2);
  });

  it('says so when the dialog cannot be loaded', () => {
    const { launcher, show, open } = setup(() =>
      throwError(() => new Error('chunk failed')),
    );

    launcher.open();

    expect(open).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      'Couldn’t open Report a bug. Try again.',
      {
        duration: 5000,
        variant: 'danger',
      },
    );
  });
});
