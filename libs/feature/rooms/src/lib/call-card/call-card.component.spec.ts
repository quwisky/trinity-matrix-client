import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  CallService,
  CallStageService,
  type ActiveCall,
} from '@trinity/data-access/calls';
import { render } from '@trinity/testing';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { screen } from '@testing-library/angular';
import { of } from 'rxjs';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { RoomShellNavigationService } from '../rooms/room-shell-navigation.service';
import { CallCardComponent } from './call-card.component';

const CALL: ActiveCall = {
  id: 1,
  roomId: '!design:hs',
  roomName: 'Design sync',
  accountId: '@me:hs',
  widgetUrl: 'trinity://app/element-call/index.html',
  state: 'joined',
  joinedAt: 0,
};

async function renderCard(
  call: Partial<ActiveCall> = {},
  { belowMd = false } = {},
) {
  if (belowMd) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === BELOW_MD_QUERY,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
  }
  const activeCall = signal<ActiveCall>({ ...CALL, ...call });
  const hangUp = vi.fn();
  const onSelectRoom = vi.fn();
  const result = await render(CallCardComponent, {
    providers: [
      {
        provide: CallService,
        useValue: {
          activeCall,
          hangUp,
          elapsed: () => of('0:05'),
          activeCallParticipants: () => of(2),
        },
      },
      { provide: RoomShellNavigationService, useValue: { onSelectRoom } },
    ],
  });
  return {
    ...result,
    activeCall,
    hangUp,
    onSelectRoom,
    stage: TestBed.inject(CallStageService),
  };
}

describe('CallCardComponent', () => {
  it('claims the dock while rendered and releases it on destroy', async () => {
    const { fixture, stage } = await renderCard();
    expect(stage.dockPresent()).toBe(true);
    fixture.destroy();
    expect(stage.dockPresent()).toBe(false);
  });

  it('offers the video box as the dock slot while the video is shown', async () => {
    const { fixture, stage } = await renderCard();
    const video = fixture.nativeElement.querySelector('.call-card__video');
    expect(video).not.toBeNull();
    expect(stage.dockElement()).toBe(video);

    screen.getByRole('button', { name: 'Hide video' }).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.call-card__video')).toBeNull();
    expect(stage.dockElement()).toBeNull();
    expect(screen.getByRole('button', { name: 'Show video' })).toBeTruthy();
  });

  it('hides the video by default below md', async () => {
    const { fixture, stage } = await renderCard({}, { belowMd: true });
    expect(fixture.nativeElement.querySelector('.call-card__video')).toBeNull();
    expect(stage.dockElement()).toBeNull();
  });

  it('resets the video choice for a new call', async () => {
    const { fixture, activeCall } = await renderCard();
    screen.getByRole('button', { name: 'Hide video' }).click();
    fixture.detectChanges();
    activeCall.set({ ...CALL, id: 2 });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.call-card__video'),
    ).not.toBeNull();
  });

  it('shows the room, the participant count and the elapsed time', async () => {
    const { fixture } = await renderCard();
    expect(
      fixture.nativeElement
        .querySelector('.call-card__summary')
        .textContent.replace(/\s+/g, ' ')
        .trim(),
    ).toBe('Design sync · 2 · 0:05');
  });

  it('truncates a long room name', async () => {
    await renderCard({ roomName: 'x'.repeat(200) });
    expect(
      screen.getByRole('button', { name: 'x'.repeat(200) }).classList,
    ).toContain('call-card__room');
  });

  it('returns to the call from the room name and Return to call', async () => {
    const { onSelectRoom } = await renderCard();
    screen.getByRole('button', { name: 'Design sync' }).click();
    screen.getByRole('button', { name: 'Return to call' }).click();
    expect(onSelectRoom).toHaveBeenCalledTimes(2);
    expect(onSelectRoom).toHaveBeenCalledWith({
      roomId: '!design:hs',
      accountId: '@me:hs',
    });
  });

  it('hangs up', async () => {
    const { hangUp } = await renderCard();
    screen.getByRole('button', { name: 'Hang up' }).click();
    expect(hangUp).toHaveBeenCalled();
  });

  it('reports a failed call with Close and no video', async () => {
    const { fixture, hangUp, stage } = await renderCard({ state: 'failed' });
    expect(screen.getByRole('alert').textContent).toContain(
      'The call could not start',
    );
    expect(fixture.nativeElement.querySelector('.call-card__video')).toBeNull();
    expect(stage.dockElement()).toBeNull();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(hangUp).toHaveBeenCalled();
  });

  it('reports its height, gap included, for the reserves below it', async () => {
    const { fixture } = await renderCard();
    const heights: number[] = [];
    fixture.componentInstance.heightChange.subscribe((h) => heights.push(h));
    const observer = (
      ResizeObserver as unknown as {
        instances: {
          observed: Set<Element>;
          emit(entries: unknown[]): void;
        }[];
      }
    ).instances.find((o) => o.observed.has(fixture.nativeElement));
    observer?.emit([{ borderBoxSize: [{ blockSize: 240, inlineSize: 300 }] }]);
    expect(heights).toEqual([240]);
  });
});
