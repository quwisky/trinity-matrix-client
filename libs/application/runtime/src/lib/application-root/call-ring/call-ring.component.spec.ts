import { signal } from '@angular/core';
import { AppearanceEffects } from '@trinity/application/appearance';
import {
  WorkspaceNavigationService,
  type WorkspaceNavigationOutcome,
} from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  CallRingService,
  CallService,
  type IncomingRing,
} from '@trinity/data-access/calls';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { NotificationSoundService } from '@trinity/data-access/notifications';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CallRingComponent } from './call-ring.component';
import { RingToneService } from './ring-tone.service';

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
  outcome: { kind: string } = { kind: 'ready' },
) {
  const incomingRing = signal<IncomingRing | null>(initial);
  const decline = vi.fn();
  const dismiss = vi.fn();
  const start = vi.fn();
  const sound = signal(true);
  // Reads the preference as the real service does, so a tracked call would re-run.
  const toneStart = vi.fn(() => void sound());
  const toneStop = vi.fn();
  const order: string[] = [];
  const navigate = vi.fn((): Observable<WorkspaceNavigationOutcome> => {
    order.push('navigate');
    return of(outcome as WorkspaceNavigationOutcome);
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
      MockProvider(NotificationSoundService, { enabled: sound }),
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
    sound,
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

  it('keeps the ring when the room does not open', async () => {
    const { dismiss, start } = await build(RING, ['@me:hs'], {
      kind: 'unavailable',
    });
    screen.getByRole('button', { name: 'Join' }).click();
    expect(dismiss).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
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
    expect(toneStart).toHaveBeenCalledWith(RING.accountId);
    incomingRing.set(null);
    await update();
    expect(toneStop).toHaveBeenCalled();
    incomingRing.set(RING);
    await update();
    toneStop.mockClear();
    fixture.destroy();
    expect(toneStop).toHaveBeenCalled();
  });

  it('does not restart the tone when the sound preference flips', async () => {
    const { toneStart, update, sound } = await build();
    sound.set(false);
    await update();
    sound.set(true);
    await update();
    expect(toneStart).toHaveBeenCalledTimes(1);
  });

  it('truncates a long caller name', async () => {
    await build({ ...RING, callerName: 'B'.repeat(200) });
    expect(
      screen.getByText(`${'B'.repeat(200)} is calling`).classList,
    ).toContain('truncate');
  });

  it('focuses Join when nothing holds focus', async () => {
    await build();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Join' }),
    );
  });

  it('leaves focus alone while a dialog holds it', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    dialog.append(inner);
    document.body.append(dialog);
    inner.focus();
    await build();
    expect(document.activeElement).toBe(inner);
    dialog.remove();
  });
});
