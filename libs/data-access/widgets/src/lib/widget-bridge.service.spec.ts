import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomWidget, WidgetEmbed } from './widget.model';
import { WidgetBridgeService } from './widget-bridge.service';

// Counts evaluations of the module that statically imports matrix-widget-api. A static
// import from the service would evaluate it as soon as this spec loads the service.
const runtime = vi.hoisted(() => ({ loads: 0 }));
vi.mock('./widget-bridge-runtime', async (importOriginal) => {
  runtime.loads += 1;
  return importOriginal();
});

const WIDGET: RoomWidget = {
  id: 'board',
  name: 'Planning board',
  type: 'm.custom',
  rawUrl: 'https://raw.example/$matrix_room_id',
  data: {},
  creatorUserId: '@alice:example.org',
  waitForIframeLoad: true,
  sourceEventId: '$board',
};

const EMBED: WidgetEmbed = {
  url: 'https://widgets.example/board?room=!r%3Ahs',
  origin: 'https://widgets.example',
  failure: null,
};

function attachedFrame(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  return iframe;
}

describe('WidgetBridgeService', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('loads the Widget API only when a widget starts', async () => {
    const iframe = attachedFrame();
    const start = new WidgetBridgeService().start(
      WIDGET,
      EMBED,
      '!r:hs',
      iframe,
    );

    expect(runtime.loads).toBe(0);

    const session = await firstValueFrom(start);

    expect(runtime.loads).toBe(1);
    session.stop();
  });

  it('targets the resolved widget origin and removes the frame on stop', async () => {
    const iframe = attachedFrame();
    const postMessage = vi
      .spyOn(iframe.contentWindow!, 'postMessage')
      .mockImplementation(() => undefined);
    const transportLog = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const session = await firstValueFrom(
      new WidgetBridgeService().start(WIDGET, EMBED, '!r:hs', iframe),
    );

    iframe.dispatchEvent(new Event('load'));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'capabilities' }),
      'https://widgets.example',
    );
    expect(session.state()).toBe('negotiating');
    expect(transportLog).toHaveBeenCalledWith(
      '[PostmessageTransport] Sending object to https://widgets.example: ',
      expect.objectContaining({ action: 'capabilities' }),
    );

    session.stop();
    expect(iframe.isConnected).toBe(false);
  });

  it('attaches nothing to the frame when unsubscribed before the Widget API loads', async () => {
    const iframe = attachedFrame();
    const addEventListener = vi.spyOn(iframe, 'addEventListener');

    new WidgetBridgeService()
      .start(WIDGET, EMBED, '!r:hs', iframe)
      .subscribe()
      .unsubscribe();
    await vi.dynamicImportSettled();

    expect(addEventListener).not.toHaveBeenCalled();
    expect(iframe.isConnected).toBe(true);
  });

  it('stops the previous widget when another one starts', async () => {
    const service = new WidgetBridgeService();
    const first = attachedFrame();
    const second = attachedFrame();

    await firstValueFrom(service.start(WIDGET, EMBED, '!r:hs', first));
    const session = await firstValueFrom(
      service.start(WIDGET, EMBED, '!r:hs', second),
    );

    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    session.stop();
  });

  it('rejects an embed whose destination changed', async () => {
    await expect(
      firstValueFrom(
        new WidgetBridgeService().start(
          WIDGET,
          { ...EMBED, origin: 'https://other.example' },
          '!r:hs',
          attachedFrame(),
        ),
      ),
    ).rejects.toThrow('Widget embed destination changed');
  });
});
