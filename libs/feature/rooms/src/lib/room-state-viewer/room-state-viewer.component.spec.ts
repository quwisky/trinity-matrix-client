import { TestBed } from '@angular/core/testing';
import { fireEvent, render } from '@trinity/testing';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import type { RoomStateEntry } from '@trinity/data-access/room-administration';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomStateViewerComponent } from './room-state-viewer.component';

const entry = (
  type: string,
  stateKey: string,
  content: Record<string, unknown> = {},
): RoomStateEntry => ({
  type,
  stateKey,
  event: { type, state_key: stateKey, content },
});

const ENTRIES: readonly RoomStateEntry[] = [
  entry('m.room.member', '@bob:hs', { membership: 'join' }),
  entry('m.room.create', '', { room_version: '10' }),
  entry('m.room.member', '@alice:hs', { membership: 'join' }),
  entry('m.room.name', '', { name: 'Lobby' }),
];

async function build(entries: readonly RoomStateEntry[] = ENTRIES) {
  const close = vi.fn();
  const show = vi.fn();
  const result = await render(RoomStateViewerComponent, {
    inputs: { entries },
    providers: [
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  const click = (element: Element) => {
    fireEvent.click(element);
    result.fixture.detectChanges(); // zoneless: render the signal change
  };
  const texts = (testId: string) =>
    [...result.container.querySelectorAll(`[data-testid="${testId}"]`)].map(
      (el) => el.textContent?.replace(/\s+/g, ' ').trim(),
    );
  return { ...result, close, show, click, texts };
}

afterEach(() => vi.unstubAllGlobals());

describe('RoomStateViewerComponent', () => {
  it('groups state by event type, sorted, with counts, all collapsed', async () => {
    const { container, texts } = await build();

    expect(texts('room-state-group-toggle')).toEqual([
      'm.room.create 1',
      'm.room.member 2',
      'm.room.name 1',
    ]);
    for (const toggle of container.querySelectorAll(
      '[data-testid="room-state-group-toggle"]',
    )) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    expect(texts('room-state-event')).toEqual([]);
    expect(texts('room-state-json')).toEqual([]);
  });

  it('lists a group in state-key order and renders JSON only for an expanded event', async () => {
    const { getByRole, click, texts } = await build();

    click(getByRole('button', { name: /^m\.room\.member/ }));
    expect(texts('room-state-event')).toEqual(['@alice:hs', '@bob:hs']);
    expect(texts('room-state-json')).toEqual([]);

    click(getByRole('button', { name: '@alice:hs' }));
    const json = texts('room-state-json');
    expect(json).toHaveLength(1);
    expect(json[0]).toContain('"state_key": "@alice:hs"');
    expect(json[0]).toContain('"membership": "join"');
  });

  it('labels an empty state key', async () => {
    const { getByRole, click, texts } = await build();

    click(getByRole('button', { name: /^m\.room\.create/ }));

    expect(texts('room-state-event')).toEqual(['(empty)']);
  });

  it('filters by event type and by state key', async () => {
    const { getByLabelText, fixture, texts, container } = await build();
    const filter = getByLabelText('Filter by event type or state key');
    const type = (value: string) => {
      fireEvent.input(filter, { target: { value } });
      fixture.detectChanges();
    };

    type('NAME');
    expect(texts('room-state-group-toggle')).toEqual(['m.room.name 1']);
    type('@bob');
    expect(texts('room-state-group-toggle')).toEqual(['m.room.member 1']);
    type('nothing-matches');
    expect(texts('room-state-group-toggle')).toEqual([]);
    expect(container.textContent).toContain('No matching state events.');
  });

  it('copies an event’s JSON from a button that names the event', async () => {
    const { getByRole, click, show } = await build();
    click(getByRole('button', { name: /^m\.room\.member/ }));
    click(getByRole('button', { name: '@alice:hs' }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    click(
      getByRole('button', { name: 'Copy m.room.member @alice:hs event JSON' }),
    );

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(ENTRIES[2].event, null, 2),
    );
    await vi.waitFor(() =>
      expect(show).toHaveBeenCalledWith('Event JSON copied.', {
        duration: 2000,
      }),
    );
  });

  // A room with thousands of members stays cheap until the reader asks.
  it('renders no member rows or JSON for a large room until opened', async () => {
    const members = Array.from({ length: 3000 }, (_, i) =>
      entry('m.room.member', `@user${i}:hs`, { membership: 'join' }),
    );
    const { getByRole, click, container } = await build(members);

    expect(
      container.querySelectorAll('[data-testid="room-state-event"]'),
    ).toHaveLength(0);

    click(getByRole('button', { name: /^m\.room\.member/ }));

    expect(
      container.querySelectorAll('[data-testid="room-state-event"]'),
    ).toHaveLength(3000);
    expect(
      container.querySelectorAll('[data-testid="room-state-json"]'),
    ).toHaveLength(0);
  }, 30_000);

  it('closes the dialog', async () => {
    const { getByRole, click } = await build();
    click(getByRole('button', { name: 'Close' }));
    expect(TestBed.inject(TrnDialogRef).close).toHaveBeenCalled();
  });
});
