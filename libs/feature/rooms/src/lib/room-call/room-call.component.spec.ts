import { signal } from '@angular/core';
import { CallService, type ActiveCall } from '@trinity/data-access/calls';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomShellNavigationService } from '../rooms/room-shell-navigation.service';
import { RoomCallComponent } from './room-call.component';

const CALL: ActiveCall = {
  id: 1,
  roomId: '!call:hs',
  accountId: '@me:hs',
  widgetUrl: 'trinity://app/element-call/index.html#?roomId=!call:hs',
  state: 'joined',
};

async function build(expanded: boolean, state: ActiveCall['state'] = 'joined') {
  const activeCall = signal<ActiveCall | null>({ ...CALL, state });
  let subscriptions = 0;
  const attach = vi.fn(
    () =>
      new Observable<never>(() => {
        subscriptions++;
      }),
  );
  const hangUp = vi.fn();
  const onSelectRoom = vi.fn();
  const result = await render(RoomCallComponent, {
    inputs: { expanded },
    providers: [
      MockProvider(CallService, { activeCall, attach, hangUp }),
      MockProvider(RoomShellNavigationService, { onSelectRoom }),
    ],
  });
  const iframe = () =>
    (result.container as HTMLElement).querySelector('iframe');
  return {
    ...result,
    iframe,
    attach,
    hangUp,
    onSelectRoom,
    activeCall,
    subscriptions: () => subscriptions,
  };
}

describe('RoomCallComponent', () => {
  it('renders the call frame with its permissions and attaches it once', async () => {
    const { iframe, attach, subscriptions } = await build(true);
    const frame = iframe();
    expect(frame?.getAttribute('title')).toBe('Call');
    expect(frame?.getAttribute('allow')).toBe(
      'camera; microphone; display-capture; autoplay; clipboard-write',
    );
    expect(frame?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
    );
    expect(attach).toHaveBeenCalledExactlyOnceWith(frame);
    expect(subscriptions()).toBe(1);
    expect(screen.queryByText('Call in progress')).toBeNull();
  });

  it('keeps the same frame mounted when collapsed and offers return and hang up', async () => {
    const { iframe, fixture, attach, hangUp, onSelectRoom } = await build(true);
    const frame = iframe();

    fixture.componentRef.setInput('expanded', false);
    fixture.detectChanges();

    expect(iframe()).toBe(frame);
    expect(attach).toHaveBeenCalledOnce();
    expect(screen.getByText('Call in progress')).toBeTruthy();
    screen.getByRole('button', { name: 'Return to call' }).click();
    expect(onSelectRoom).toHaveBeenCalledWith({
      roomId: CALL.roomId,
      accountId: CALL.accountId,
    });
    screen.getByRole('button', { name: 'Hang up' }).click();
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it('shows the spinner while the call loads', async () => {
    const { container } = await build(true, 'loading');
    expect(container.querySelector('trn-spinner')).not.toBeNull();
  });

  it('says when the call could not start and closes it', async () => {
    const { hangUp, container } = await build(true, 'failed');
    expect(screen.getByText('The call could not start')).toBeTruthy();
    expect(container.querySelector('trn-spinner')).toBeNull();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it('does not attach again when the call state changes', async () => {
    const { attach, activeCall, fixture } = await build(true, 'loading');
    activeCall.set({ ...CALL, state: 'joined' });
    fixture.detectChanges();
    expect(attach).toHaveBeenCalledOnce();
  });
});
