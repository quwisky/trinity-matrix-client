import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { lastValueFrom, type Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { type SwitcherSelection } from '@trinity/application/search';
import { ForwardService } from './forward.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

function setup(
  selection: SwitcherSelection | null,
  forwardResult: Observable<void> = of(undefined),
) {
  const pick = vi.fn(() => of(selection));
  const forwardMessage = vi.fn(() => forwardResult);
  const show = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ForwardService,
      MockProvider(QuickSwitcherService, { pick$: pick }),
      MockProvider(TimelineActionsService, { forwardMessage }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  return { svc: TestBed.inject(ForwardService), forwardMessage, show, pick };
}

describe('ForwardService', () => {
  // The send goes through the ACTIVE client with no account switch, so offering a mixed-in
  // account's room would just 403 with an unexplainable toast.
  it('asks the picker for the active account’s rooms only', async () => {
    const { svc, pick } = setup({
      kind: 'conversation',
      accountId: '@me:hs',
      roomId: '!t:hs',
    });

    await lastValueFrom(svc.forward$('!s:hs', '$e'), {
      defaultValue: undefined,
    });

    expect(pick).toHaveBeenCalledWith({ activeAccountOnly: true });
  });

  it('forwards to the picked room and toasts success', async () => {
    const { svc, forwardMessage, show } = setup({
      kind: 'conversation',
      accountId: '@me:hs',
      roomId: '!t:hs',
    });
    await lastValueFrom(svc.forward$('!s:hs', '$e'), {
      defaultValue: undefined,
    });
    expect(forwardMessage).toHaveBeenCalledWith('!s:hs', '$e', '!t:hs');
    expect(show).toHaveBeenCalledWith(
      'Message forwarded.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('forwards to a picked direct message', async () => {
    const { svc, forwardMessage } = setup({
      kind: 'conversation',
      accountId: '@me:hs',
      roomId: '!dm:hs',
    });
    await lastValueFrom(svc.forward$('!s:hs', '$e'), {
      defaultValue: undefined,
    });
    expect(forwardMessage).toHaveBeenCalledWith('!s:hs', '$e', '!dm:hs');
  });

  it('does nothing when the picker is cancelled', async () => {
    const { svc, forwardMessage } = setup(null);
    await lastValueFrom(svc.forward$('!s:hs', '$e'), {
      defaultValue: undefined,
    });
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it('ignores a non-room selection (a space or person)', async () => {
    const { svc, forwardMessage } = setup({
      kind: 'person',
      accountId: '@me:hs',
      userId: '@x:hs',
    });
    await lastValueFrom(svc.forward$('!s:hs', '$e'), {
      defaultValue: undefined,
    });
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it('toasts an error when the forward fails', async () => {
    const { svc, show } = setup(
      {
        kind: 'conversation',
        accountId: '@me:hs',
        roomId: '!t:hs',
      },
      throwError(() => new Error('boom')),
    );
    await lastValueFrom(svc.forward$('!s:hs', '$e'), {
      defaultValue: undefined,
    });
    expect(show).toHaveBeenCalledWith(
      'Could not forward the message.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });
});
