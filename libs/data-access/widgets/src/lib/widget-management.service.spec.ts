import { TestBed } from '@angular/core/testing';
import { EngineRequestError } from '@trinity/util/matrix';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRoomWidgetEngine } from '../contract/fake-room-widget-engine';
import { ROOM_WIDGET_ENGINE } from './room-widget-engine.token';
import type { RoomWidget, WidgetLaunch } from './widget.model';
import {
  WidgetManagementError,
  WidgetManagementService,
} from './widget-management.service';
import { WidgetsService } from './widgets.service';

const GENERIC = { type: 'm.custom', url: 'https://widgets.example/board' };

async function setup(options: { canManage?: boolean } = {}) {
  const engine = new FakeRoomWidgetEngine();
  const roomId = await engine.joinedRoom({
    canManage: options.canManage ?? true,
  });
  const target = { accountId: engine.alice, roomId } as const;
  const sourceEventId = await engine.asBob.putWidget(roomId, 'board', GENERIC);
  const widget: RoomWidget = {
    id: 'board',
    name: 'Planning board',
    type: 'm.custom',
    rawUrl: GENERIC.url,
    data: {},
    creatorUserId: engine.bob,
    waitForIframeLoad: true,
    sourceEventId,
  };
  const put = vi.spyOn(engine, 'putRoomWidget');
  const remove = vi.spyOn(engine, 'removeRoomWidget');
  const launchFor = vi.fn(
    (_target: typeof target, draft: RoomWidget): WidgetLaunch => ({
      url: draft.rawUrl,
      origin: new URL(draft.rawUrl).origin,
      disclosures: [],
      insecure: false,
      failure: null,
    }),
  );
  TestBed.configureTestingModule({
    providers: [
      WidgetManagementService,
      { provide: ROOM_WIDGET_ENGINE, useValue: engine },
      { provide: WidgetsService, useValue: { launchFor } },
    ],
  });
  return {
    service: TestBed.inject(WidgetManagementService),
    engine,
    target,
    widget,
    put,
    remove,
    launchFor,
  };
}

describe('WidgetManagementService', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.unstubAllGlobals());

  it('is cold and writes the exact generic-widget payload after subscription', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const { service, engine, target, launchFor, put } = await setup();
    const request = service.create(target, {
      name: '  Planning board  ',
      rawUrl: ' https://widgets.example/$matrix_room_id ',
    });

    expect(put).not.toHaveBeenCalled();
    await expect(firstValueFrom(request)).resolves.toBe('generated-id');

    expect(launchFor).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        id: 'generated-id',
        type: 'm.custom',
        creatorUserId: engine.alice,
      }),
    );
    expect(put).toHaveBeenCalledWith(engine.alice, target.roomId, {
      id: 'generated-id',
      name: 'Planning board',
      type: 'm.custom',
      url: 'https://widgets.example/$matrix_room_id',
      creatorUserId: engine.alice,
      data: {},
      waitForIframeLoad: true,
    });
  });

  it('retries UUID collisions and never falls back to a predictable ID', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('taken')
      .mockReturnValueOnce('available');
    vi.stubGlobal('crypto', { randomUUID });
    const { service, engine, target } = await setup();
    await engine.asBob.putWidget(target.roomId, 'taken', {});

    await expect(
      firstValueFrom(
        service.create(target, {
          name: 'Board',
          rawUrl: 'https://widgets.example',
        }),
      ),
    ).resolves.toBe('available');

    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it('gives up after eight taken ids', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'taken') });
    const { service, engine, target, put } = await setup();
    await engine.asBob.putWidget(target.roomId, 'taken', {});

    await expect(
      firstValueFrom(
        service.create(target, {
          name: 'Board',
          rawUrl: 'https://widgets.example',
        }),
      ),
    ).rejects.toMatchObject({ code: 'uuid-collision' });
    expect(put).toHaveBeenCalledTimes(8);
  });

  it('denies an account without power at subscription time', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const { service, engine, target, put } = await setup();
    const request = service.create(target, {
      name: 'Board',
      rawUrl: 'https://widgets.example',
    });
    await engine.asBob.setPowerLevel(target.roomId, engine.alice, 0);

    await expect(firstValueFrom(request)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('answers not-signed-in for an account that is not live', async () => {
    const { service, engine, target } = await setup();
    engine.setLive(engine.alice, false);

    await expect(
      firstValueFrom(
        service.create(target, {
          name: 'Board',
          rawUrl: 'https://widgets.example',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not-signed-in' });
  });

  it('returns a typed validation failure without writing', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const { service, target, put } = await setup();

    await expect(
      firstValueFrom(
        service.create(target, {
          name: 'Board',
          rawUrl: 'https://user:secret@widgets.example',
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WidgetManagementError>>({
        code: 'invalid-draft',
        draftFailure: 'credentials',
      }),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects an origin that the expanded template changes', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const { service, target, put, launchFor } = await setup();
    launchFor.mockReturnValueOnce({
      url: 'https://elsewhere.example',
      origin: 'https://elsewhere.example',
      disclosures: [],
      insecure: false,
      failure: null,
    });

    await expect(
      firstValueFrom(
        service.create(target, {
          name: 'Board',
          rawUrl: 'https://widgets.example',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-draft',
      draftFailure: 'dynamic-origin',
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('tombstones only the exact active revision that was confirmed', async () => {
    const { service, engine, target, widget, remove } = await setup();

    await expect(
      firstValueFrom(service.remove(target, widget)),
    ).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(
      engine.alice,
      target.roomId,
      'board',
      widget.sourceEventId,
    );
  });

  it('rejects a replaced revision as a conflict', async () => {
    const { service, target, widget } = await setup();

    await expect(
      firstValueFrom(
        service.remove(target, { ...widget, sourceEventId: '$stale' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects a widget without a confirmed revision as a conflict', async () => {
    const { service, target, widget, remove } = await setup();

    await expect(
      firstValueFrom(
        service.remove(target, { ...widget, sourceEventId: null }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses to remove call widgets', async () => {
    const { service, target, widget, remove } = await setup();

    await expect(
      firstValueFrom(service.remove(target, { ...widget, type: 'm.jitsi' })),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('trusts the current state type over a forged generic projection', async () => {
    const { service, engine, target, widget } = await setup();
    const sourceEventId = await engine.asBob.putWidget(target.roomId, 'board', {
      type: 'm.jitsi',
      url: 'https://widgets.example/call',
    });

    await expect(
      firstValueFrom(service.remove(target, { ...widget, sourceEventId })),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
  });

  it('rejects an account without power as forbidden', async () => {
    const { service, target, widget } = await setup({ canManage: false });

    await expect(
      firstValueFrom(service.remove(target, widget)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('carries a homeserver write failure as an engine request error', async () => {
    const { service, engine, target, widget } = await setup();
    engine.failNext('request-failed');

    const error = await firstValueFrom(service.remove(target, widget)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).failure.code).toBe('request-failed');
  });
});
