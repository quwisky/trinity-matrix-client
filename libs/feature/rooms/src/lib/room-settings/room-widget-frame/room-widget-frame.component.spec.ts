import { signal } from '@angular/core';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  WidgetBridgeService,
  type RoomWidget,
  type WidgetEmbed,
} from '@trinity/data-access/widgets';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { RoomWidgetFrameComponent } from './room-widget-frame.component';

const WIDGET: RoomWidget = {
  id: 'board',
  name: 'Planning board',
  type: 'm.custom',
  rawUrl: 'https://widgets.example/board',
  data: {},
  creatorUserId: '@alice:example.org',
  waitForIframeLoad: true,
  sourceEventId: '$board',
};

const EMBED: WidgetEmbed = {
  url: 'https://widgets.example/board',
  origin: 'https://widgets.example',
  failure: null,
};

describe('RoomWidgetFrameComponent', () => {
  it('starts only after the protected frame exists and pins its restrictions', async () => {
    const stop = vi.fn();
    const start = vi.fn(
      (_widget, _embed, _roomId, iframe: HTMLIFrameElement) => {
        expect(iframe.getAttribute('src')).toBeNull();
        return { state: signal<'frame-loading'>('frame-loading'), stop };
      },
    );
    const { container } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, { start }),
        MockProvider(TrnDialogRef, { close: vi.fn() }),
      ],
    });

    const iframe = container.querySelector<HTMLIFrameElement>('iframe');
    expect(start).toHaveBeenCalledOnce();
    expect(iframe?.getAttribute('src')).toBe(EMBED.url);
    expect(iframe?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-same-origin',
    );
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.hasAttribute('allowfullscreen')).toBe(false);
    expect(iframe?.getAttribute('allow')).toContain("camera 'none'");
    expect(iframe?.getAttribute('allow')).toContain("microphone 'none'");
    expect(iframe?.getAttribute('allow')).toContain("geolocation 'none'");
    expect(iframe?.getAttribute('title')).toBe('Planning board widget');
  });

  it('stops the bridge on destroy', async () => {
    const stop = vi.fn();
    const { fixture } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, {
          start: () => ({ state: signal('ready'), stop }),
        }),
        MockProvider(TrnDialogRef, { close: vi.fn() }),
      ],
    });

    fixture.destroy();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('reports a startup failure without assigning a network-bearing src', async () => {
    const { container } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, {
          start: () => {
            throw new Error('bridge unavailable');
          },
        }),
        MockProvider(TrnDialogRef, { close: vi.fn() }),
      ],
    });

    expect(
      container.querySelector<HTMLIFrameElement>('iframe')?.getAttribute('src'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="widget-frame-status"]'),
    ).toHaveTextContent(
      'Trinity could not start this widget. No third-party page was loaded.',
    );
  });
});
