import { signal } from '@angular/core';
import { AppearanceEffects } from '@trinity/application/appearance';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  CallRingService,
  CallService,
  type IncomingRing,
} from '@trinity/data-access/calls';
import { RingToneService } from './ring-tone.service';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CallRingComponent } from './call-ring.component';

const RING: IncomingRing = {
  id: '$ring',
  roomId: '!dm:hs',
  accountId: '@me:hs',
  callerId: '@bob:hs',
  callerName: 'Bob',
  video: true,
  expiresAt: 0,
};

async function build(
  initial: IncomingRing | null = RING,
  accountIds: string[] = ['@me:hs'],
) {
  const incomingRing = signal<IncomingRing | null>(initial);
  const decline = vi.fn();
  const dismiss = vi.fn();
  const start = vi.fn();
  const toneStart = vi.fn();
  const toneStop = vi.fn();
  const order: string[] = [];
  const navigate = vi.fn(() => {
    order.push('navigate');
    return of({ kind: 'ready' as const, change: 'committed' as const });
  });
  start.mockImplementation(() => order.push('start'));
  const result = await render(CallRingComponent, {
    providers: [
      provideTrnIcons(),
      MockProvider(CallRingService, { incomingRing, decline, dismiss }),
      MockProvider(CallService, { start }),
      MockProvider(RingToneService, { start: toneStart, stop: toneStop }),
      MockProvider(WorkspaceNavigationService, { navigate }),
      MockProvider(AppearanceEffects, {
        resolved: signal({ mode: 'dark' }) as never,
      }),
      MockProvider(MatrixClientService, {
        accountIds: signal(accountIds),
      }),
      MockProvider(AccountIdentitiesService, {
        identities: signal(
          new Map([
            [
              '@me:hs',
              { userId: '@me:hs', displayName: 'Me Myself', avatarMxc: null },
            ],
          ]),
        ),
      }),
    ],
  });
  const update = async () => {
    result.fixture.detectChanges();
    await result.fixture.whenStable();
  };
  return {
    ...result,
    incomingRing,
    decline,
    dismiss,
    start,
    navigate,
    order,
    toneStart,
    toneStop,
    update,
  };
}

describe('CallRingComponent', () => {
  it('renders nothing without a ring', async () => {
    await build(null);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('announces the caller and the call kind', async () => {
    await build();
    expect(
      screen.getByRole('alertdialog', { name: 'Incoming call' }),
    ).toBeTruthy();
    expect(screen.getByText('Bob is calling')).toBeTruthy();
    expect(screen.getByText('Incoming video call')).toBeTruthy();
    expect(screen.queryByText(/^for /)).toBeNull();
  });

  it('joins a video ring: dismiss, navigate, then start', async () => {
    const { dismiss, navigate, start, order } = await build();
    screen.getByRole('button', { name: 'Join' }).click();
    expect(dismiss).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({
      kind: 'room',
      accountId: '@me:hs',
      roomId: '!dm:hs',
      origin: 'room-action',
    });
    expect(start).toHaveBeenCalledWith('!dm:hs', {
      video: true,
      dm: true,
      theme: 'dark',
      roomName: 'Bob',
    });
    expect(order).toEqual(['navigate', 'start']);
  });

  it('joins a voice ring without video', async () => {
    const { start } = await build({ ...RING, video: false });
    expect(screen.getByText('Incoming voice call')).toBeTruthy();
    screen.getByRole('button', { name: 'Join' }).click();
    expect(start.mock.calls[0][1]).toMatchObject({ video: false });
  });

  it('joins a ring of unknown intent with video', async () => {
    const { start } = await build({ ...RING, video: null });
    screen.getByRole('button', { name: 'Join' }).click();
    expect(start.mock.calls[0][1]).toMatchObject({ video: true });
  });

  it('opens the room on the called account, which switches to it', async () => {
    const { navigate } = await build({ ...RING, accountId: '@other:hs' });
    screen.getByRole('button', { name: 'Join' }).click();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: '@other:hs' }),
    );
  });

  it('names the called account only with several signed in', async () => {
    await build(RING, ['@me:hs', '@other:hs']);
    expect(screen.getByText('for Me Myself')).toBeTruthy();
  });

  it('declines', async () => {
    const { decline } = await build();
    screen.getByRole('button', { name: 'Decline' }).click();
    expect(decline).toHaveBeenCalled();
  });

  it('rings while the prompt shows and stops when it clears or is destroyed', async () => {
    const { incomingRing, toneStart, toneStop, update, fixture } =
      await build(null);
    expect(toneStart).not.toHaveBeenCalled();
    incomingRing.set(RING);
    await update();
    expect(toneStart).toHaveBeenCalledTimes(1);
    incomingRing.set(null);
    await update();
    expect(toneStop).toHaveBeenCalled();
    incomingRing.set(RING);
    await update();
    toneStop.mockClear();
    fixture.destroy();
    expect(toneStop).toHaveBeenCalled();
  });

  it('truncates a long caller name', async () => {
    await build({ ...RING, callerName: 'B'.repeat(200) });
    expect(
      screen.getByText(`${'B'.repeat(200)} is calling`).classList,
    ).toContain('truncate');
  });

  it('focuses Join unless a dialog already holds focus', async () => {
    await build();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Join' }),
    );
  });
});
