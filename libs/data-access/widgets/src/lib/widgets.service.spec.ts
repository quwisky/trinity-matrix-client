import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { finalize, tap } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRoomWidgetEngine } from '../contract/fake-room-widget-engine';
import { ROOM_WIDGET_ENGINE } from './room-widget-engine.token';
import { WIDGET_APPEARANCE_PROJECTION } from './widget-appearance-projection';
import type { RoomWidget } from './widget.model';
import { WidgetsService } from './widgets.service';

const BOB_ACCOUNT = '@bob:other.example';

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

function widget(rawUrl: string): RoomWidget {
  return {
    id: 'board',
    name: 'Board',
    type: 'm.custom',
    rawUrl,
    data: {},
    creatorUserId: '@alice:example.org',
    waitForIframeLoad: true,
    sourceEventId: '$board',
  };
}

async function setup(options: { canManage?: boolean } = {}) {
  const engine = new FakeRoomWidgetEngine();
  const roomId = await engine.joinedRoom({
    canManage: options.canManage ?? true,
  });
  const target = { accountId: engine.alice, roomId } as const;
  let open = 0;
  const roomWidgets = engine.roomWidgets.bind(engine);
  const subscribed = vi.fn();
  engine.roomWidgets = (accountId, room) =>
    roomWidgets(accountId, room).pipe(
      tap({
        subscribe: () => {
          open += 1;
          subscribed(room);
        },
      }),
      finalize(() => (open -= 1)),
    );
  const resolvedAppearance = signal<{ readonly mode: 'light' | 'dark' }>({
    mode: 'dark',
  });
  const snapshot = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: engine.alice,
    accounts: [account(engine.alice), account(BOB_ACCOUNT)],
  });
  TestBed.configureTestingModule({
    providers: [
      WidgetsService,
      { provide: ROOM_WIDGET_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: snapshot },
      {
        provide: WIDGET_APPEARANCE_PROJECTION,
        useValue: { resolved: resolvedAppearance.asReadonly() },
      },
    ],
  });
  return {
    service: TestBed.inject(WidgetsService),
    engine,
    target,
    snapshot,
    subscribed,
    resolvedAppearance,
    open: () => open,
  };
}

describe('WidgetsService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('seeds a watched room synchronously from the engine', async () => {
    const { service, engine, target } = await setup();
    const eventId = await engine.asBob.putWidget(target.roomId, 'board', {
      type: 'm.custom',
      url: 'https://widgets.example',
    });

    expect(service.widgetsFor(target)()).toEqual([
      expect.objectContaining({ id: 'board', sourceEventId: eventId }),
    ]);
    expect(service.canManageFor(target)()).toBe(true);
  });

  it('memoizes the readonly signal for each watched room', async () => {
    const { service, target } = await setup();

    expect(service.widgetsFor(target)).toBe(service.widgetsFor({ ...target }));
  });

  it('follows widget and permission changes while connected', async () => {
    const { service, engine, target } = await setup({ canManage: false });
    const widgets = service.widgetsFor(target);
    const canManage = service.canManageFor(target);
    service.connect(target);

    await engine.asBob.putWidget(target.roomId, 'board', {
      type: 'm.custom',
      url: 'https://widgets.example',
    });
    await engine.asBob.setPowerLevel(target.roomId, engine.alice, 100);

    expect(widgets().map((w) => w.id)).toEqual(['board']);
    expect(canManage()).toBe(true);
  });

  it('detaches and clears watched values on the last disconnect', async () => {
    const { service, engine, target, open } = await setup();
    await engine.asBob.putWidget(target.roomId, 'board', {
      type: 'm.custom',
      url: 'https://widgets.example',
    });
    const widgets = service.widgetsFor(target);
    service.connect(target);

    service.disconnect(target);

    expect(open()).toBe(0);
    expect(widgets()).toEqual([]);
    expect(service.widgetsFor(target)).not.toBe(widgets);
  });

  it('keeps one subscription until overlapping consumers release it', async () => {
    const { service, engine, target, open } = await setup();
    await engine.asBob.putWidget(target.roomId, 'board', {
      type: 'm.custom',
      url: 'https://widgets.example',
    });
    const first = service.widgetsFor(target);
    const second = service.widgetsFor({ ...target });
    service.connect(target);
    service.connect({ ...target });

    service.disconnect(target);

    expect(first()).not.toEqual([]);
    expect(second()).toBe(first());
    expect(open()).toBe(1);

    service.disconnect({ ...target });

    expect(first()).toEqual([]);
    expect(open()).toBe(0);
  });

  it('resubscribes for a new client of the exact Account, not the active one', async () => {
    const { service, engine, target, snapshot, subscribed } = await setup();
    service.connect(target);
    TestBed.tick();
    subscribed.mockClear();

    snapshot.update((s) => ({ ...s, activeAccountId: BOB_ACCOUNT }));
    TestBed.tick();
    expect(subscribed).not.toHaveBeenCalled();

    snapshot.update((s) => ({
      ...s,
      accounts: [account(engine.alice, 2), account(BOB_ACCOUNT)],
    }));
    TestBed.tick();
    expect(subscribed).toHaveBeenCalledWith(target.roomId);
  });

  it('labels a display-name fallback as the Matrix user ID it actually sends', async () => {
    const { service, engine, target } = await setup();

    const launch = service.launchFor(
      target,
      widget('https://widgets.example/?name=$matrix_display_name'),
    );

    expect(new URL(launch.url as string).searchParams.get('name')).toBe(
      engine.alice,
    );
    expect(launch.disclosures).toEqual([
      { kind: 'user-id', label: 'your Matrix user ID' },
    ]);
  });

  it('reads widget theme disclosure from the application Appearance projection', async () => {
    const { service, target, resolvedAppearance } = await setup();
    const board = widget(
      'https://widgets.example/?theme=$org.matrix.msc2873.client_theme',
    );
    const theme = () =>
      new URL(service.launchFor(target, board).url as string).searchParams.get(
        'theme',
      );

    expect(theme()).toBe('dark');

    resolvedAppearance.set({ mode: 'light' });

    expect(theme()).toBe('light');
  });

  it('keeps launch identity on the opening Account when the active Account changes', async () => {
    const { service, engine, target, snapshot } = await setup();
    service.connect(target);
    const launch = computed(() =>
      service.launchFor(
        target,
        widget(
          'https://widgets.example/?user=$matrix_user_id' +
            '&device=$org.matrix.msc3819.matrix_device_id' +
            '&base=$org.matrix.msc4039.matrix_base_url',
        ),
      ),
    );
    expect(new URL(launch().url as string).searchParams.get('user')).toBe(
      engine.alice,
    );

    snapshot.update((s) => ({ ...s, activeAccountId: BOB_ACCOUNT }));
    TestBed.tick();

    expect(
      Object.fromEntries(new URL(launch().url as string).searchParams),
    ).toEqual({
      user: engine.alice,
      device: 'FAKEDEVICE',
      base: 'https://example.org',
    });
  });

  it('updates launch identity when the Account ends and returns', async () => {
    const { service, engine, target } = await setup();
    service.connect(target);
    const user = computed(() =>
      new URL(
        service.launchFor(
          target,
          widget(
            'https://widgets.example/?device=$org.matrix.msc3819.matrix_device_id',
          ),
        ).url as string,
      ).searchParams.get('device'),
    );
    expect(user()).toBe('FAKEDEVICE');

    engine.setLive(engine.alice, false);
    expect(user()).toBe('');

    engine.setLive(engine.alice, true);
    expect(user()).toBe('FAKEDEVICE');
  });

  it('prunes a released room before a later room reconnects', async () => {
    const { service, engine, target, subscribed } = await setup();
    service.widgetsFor(target);
    service.connect(target);
    service.disconnect(target);
    const second = {
      ...target,
      roomId: await engine.joinedRoom({ canManage: false }),
    };
    subscribed.mockClear();

    service.widgetsFor(second);
    service.connect(second);
    service.widgetsFor(target);

    expect(subscribed.mock.calls).toEqual([
      [second.roomId],
      [second.roomId],
      [target.roomId],
    ]);
  });
});
