import { TestBed } from '@angular/core/testing';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { RoomModerationService } from '@trinity/data-access/room-administration';
import { MockProvider } from 'ng-mocks';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { ReportService } from './report.service';

function setup(
  over: {
    prompt$?: Mock;
    reportMessage?: Mock;
  } = {},
) {
  const prompt$ = over.prompt$ ?? vi.fn(() => of('spam'));
  const reportMessage = over.reportMessage ?? vi.fn(() => of(undefined));
  const toastShow = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ReportService,
      MockProvider(RoomModerationService, { reportMessage }),
      MockProvider(TrnAlertService, { prompt$ }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    svc: TestBed.inject(ReportService),
    prompt$,
    reportMessage,
    toastShow,
  };
}

describe('ReportService', () => {
  it('prompts for a reason and reports the message', async () => {
    const { svc, reportMessage, toastShow } = setup();

    await lastValueFrom(svc.report$('!r:hs', '$evt'));

    expect(reportMessage).toHaveBeenCalledWith('!r:hs', '$evt', 'spam');
    expect(toastShow).toHaveBeenCalled();
  });

  it('does not report when the prompt is cancelled', async () => {
    const { svc, reportMessage } = setup({
      prompt$: vi.fn(() => of(null)),
    });

    await lastValueFrom(svc.report$('!r:hs', '$evt'), {
      defaultValue: undefined,
    });

    expect(reportMessage).not.toHaveBeenCalled();
  });

  it('toasts an error when the report fails', async () => {
    const { svc, toastShow } = setup({
      reportMessage: vi.fn(() => throwError(() => new Error('nope'))),
    });

    await lastValueFrom(svc.report$('!r:hs', '$evt'), {
      defaultValue: undefined,
    });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('does nothing without a room or event id', async () => {
    const { svc, prompt$ } = setup();

    await lastValueFrom(svc.report$('', '$evt'));

    expect(prompt$).not.toHaveBeenCalled();
  });
});
