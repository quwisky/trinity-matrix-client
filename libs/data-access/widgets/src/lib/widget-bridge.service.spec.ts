import {
  OpenIDRequestState,
  SimpleObservable,
  type Capability,
} from 'matrix-widget-api';
import { describe, expect, it, vi } from 'vitest';
import type { RoomWidget, WidgetEmbed } from './widget.model';
import {
  RestrictedWidgetDriver,
  WidgetBridgeService,
} from './widget-bridge.service';

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

describe('RestrictedWidgetDriver', () => {
  it('approves no requested capabilities', async () => {
    const requested = new Set<Capability>([
      'm.always_on_screen',
      'org.matrix.msc2762.timeline:*',
    ]);

    expect(
      await new RestrictedWidgetDriver().validateCapabilities(requested),
    ).toEqual(new Set());
  });

  it('blocks OpenID requests', () => {
    const updates = vi.fn();
    const observer = new SimpleObservable(updates);

    new RestrictedWidgetDriver().askOpenID(observer);

    expect(updates).toHaveBeenCalledWith({ state: OpenIDRequestState.Blocked });
  });
});

describe('WidgetBridgeService', () => {
  it('targets the resolved widget origin and removes the frame on stop', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const postMessage = vi
      .spyOn(iframe.contentWindow!, 'postMessage')
      .mockImplementation(() => undefined);
    const session = new WidgetBridgeService().start(
      WIDGET,
      EMBED,
      '!r:hs',
      iframe,
    );

    iframe.dispatchEvent(new Event('load'));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'capabilities' }),
      'https://widgets.example',
    );
    expect(session.state()).toBe('negotiating');

    session.stop();
    expect(iframe.isConnected).toBe(false);
  });
});
