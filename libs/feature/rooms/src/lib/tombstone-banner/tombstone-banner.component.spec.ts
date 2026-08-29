import { inject, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationRuntime,
  TimelineService,
  type RoomTombstone,
} from '@trinity/data-access/timeline';
import { TombstoneBannerComponent } from './tombstone-banner.component';

async function build(tombstone: RoomTombstone | null) {
  const { fixture, container } = await render(TombstoneBannerComponent, {
    providers: [
      MockProvider(TimelineService, {
        tombstone: signal<RoomTombstone | null>(tombstone).asReadonly(),
      }),
      {
        provide: ConversationRuntime,
        useFactory: () => ({ timeline: inject(TimelineService) }),
      },
    ],
  });
  return { cmp: fixture.componentInstance, container };
}

describe('TombstoneBannerComponent', () => {
  it('renders nothing for a live room', async () => {
    const { container } = await build(null);
    expect(
      container.querySelector('[data-testid=tombstone-banner]'),
    ).toBeNull();
  });

  it('renders the banner when the room is tombstoned', async () => {
    const { container } = await build({
      replacementRoomId: '!new:hs',
      body: 'upgraded',
    });
    expect(
      container.querySelector('[data-testid=tombstone-banner]'),
    ).not.toBeNull();
  });

  it('emits the successor room id when Go is chosen', async () => {
    const { cmp } = await build({
      replacementRoomId: '!new:hs',
      body: 'upgraded',
    });
    const emitted = vi.fn();
    cmp.goToRoom.subscribe(emitted);

    cmp.go();

    expect(emitted).toHaveBeenCalledWith('!new:hs');
  });
});
