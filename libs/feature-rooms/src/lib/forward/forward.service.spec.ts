import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { type Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '@trinity/helm/overlay';
import { TimelineService } from '@trinity/data-access/timeline';
import { type SwitcherSelection } from '@trinity/data-access/search';
import { ForwardService } from './forward.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

function setup(
  selection: SwitcherSelection | null,
  forwardResult: Observable<void> = of(undefined),
) {
  const pick = vi.fn().mockResolvedValue(selection);
  const forwardMessage = vi.fn(() => forwardResult);
  const show = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ForwardService,
      MockProvider(QuickSwitcherService, { pick }),
      MockProvider(TimelineService, { forwardMessage }),
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
      kind: 'room',
      id: '!t:hs',
    } as SwitcherSelection);

    await svc.forward('!s:hs', '$e');

    expect(pick).toHaveBeenCalledWith({ activeAccountOnly: true });
  });

  it('forwards to the picked room and toasts success', async () => {
    const { svc, forwardMessage, show } = setup({
      kind: 'room',
      id: '!t:hs',
    } as SwitcherSelection);
    await svc.forward('!s:hs', '$e');
    expect(forwardMessage).toHaveBeenCalledWith('!s:hs', '$e', '!t:hs');
    expect(show).toHaveBeenCalledWith(
      'Message forwarded.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('forwards to a picked direct message', async () => {
    const { svc, forwardMessage } = setup({
      kind: 'dm',
      id: '!dm:hs',
    } as SwitcherSelection);
    await svc.forward('!s:hs', '$e');
    expect(forwardMessage).toHaveBeenCalledWith('!s:hs', '$e', '!dm:hs');
  });

  it('does nothing when the picker is cancelled', async () => {
    const { svc, forwardMessage } = setup(null);
    await svc.forward('!s:hs', '$e');
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it('ignores a non-room selection (a space or person)', async () => {
    const { svc, forwardMessage } = setup({
      kind: 'user',
      id: '@x:hs',
    } as SwitcherSelection);
    await svc.forward('!s:hs', '$e');
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it('toasts an error when the forward fails', async () => {
    const { svc, show } = setup(
      { kind: 'room', id: '!t:hs' } as SwitcherSelection,
      throwError(() => new Error('boom')),
    );
    await svc.forward('!s:hs', '$e');
    expect(show).toHaveBeenCalledWith(
      'Could not forward the message.',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
