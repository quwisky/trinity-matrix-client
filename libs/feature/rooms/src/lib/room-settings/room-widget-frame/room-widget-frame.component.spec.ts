import { signal } from '@angular/core';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  WidgetBridgeService,
  type RoomWidget,
  type WidgetBridgeSession,
  type WidgetEmbed,
} from '@trinity/data-access/widgets';
import { fireEvent, render, screen, within } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomWidgetFrameComponent } from './room-widget-frame.component';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isInstalledNativePlatform: () => platform.native,
}));

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
  afterEach(() => {
    platform.native = false;
  });

  it('starts only after the protected frame exists and pins its restrictions', async () => {
    const stop = vi.fn();
    const start = vi.fn(
      (_widget, _embed, _roomId, iframe: HTMLIFrameElement) => {
        expect(iframe.getAttribute('src')).toBeNull();
        return of({ state: signal<'frame-loading'>('frame-loading'), stop });
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

  it('fills the shared dialog shell body with the frame and closes from its X', async () => {
    const close = vi.fn();
    const { container } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, {
          start: () =>
            of<WidgetBridgeSession>({ state: signal('ready'), stop: vi.fn() }),
        }),
        MockProvider(TrnDialogRef, { close, presentation: 'fullscreen' }),
      ],
    });

    const surface = screen.getByTestId('dialog-surface');
    expect(
      within(surface).getByRole('heading', {
        level: 2,
        name: 'Planning board',
      }),
    ).toBeTruthy();
    expect(container.querySelector('trn-dialog-shell')).toHaveAttribute(
      'data-presentation',
      'fullscreen',
    );
    const body = container.querySelector('.dialog-shell__body');
    expect(body).toHaveClass('p-0');
    expect(body?.querySelector('iframe')).not.toBeNull();

    fireEvent.click(screen.getByTestId('dialog-close'));
    expect(close).toHaveBeenCalled();
  });

  it('assigns the frame src only once the Widget API session exists', async () => {
    const session = new Subject<WidgetBridgeSession>();
    const { container, fixture } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, { start: () => session }),
        MockProvider(TrnDialogRef, { close: vi.fn() }),
      ],
    });
    const iframe = container.querySelector<HTMLIFrameElement>('iframe');

    expect(iframe?.hasAttribute('src')).toBe(false);
    expect(
      container.querySelector('[data-testid="widget-frame-status"]'),
    ).toHaveTextContent('Loading the third-party widget…');

    session.next({ state: signal('negotiating'), stop: vi.fn() });
    session.complete();
    fixture.detectChanges();

    expect(iframe?.getAttribute('src')).toBe(EMBED.url);
    expect(
      container.querySelector('[data-testid="widget-frame-status"]'),
    ).toHaveTextContent('Negotiating the restricted Widget API connection…');
  });

  it('abandons a Widget API load that is still pending when destroyed', async () => {
    const session = new Subject<WidgetBridgeSession>();
    const { container, fixture } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, { start: () => session }),
        MockProvider(TrnDialogRef, { close: vi.fn() }),
      ],
    });
    const iframe = container.querySelector<HTMLIFrameElement>('iframe');

    fixture.destroy();

    expect(session.observed).toBe(false);
    expect(iframe?.hasAttribute('src')).toBe(false);
  });

  it('stops the bridge on destroy', async () => {
    const stop = vi.fn();
    const { fixture } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, {
          start: () =>
            of<WidgetBridgeSession>({ state: signal('ready'), stop }),
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
          start: () => throwError(() => new Error('bridge unavailable')),
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

  it('never loads a page on the installed mobile apps, even with a valid embed', async () => {
    platform.native = true;
    const start = vi.fn();
    const { container } = await render(RoomWidgetFrameComponent, {
      inputs: { roomId: '!r:hs', widget: WIDGET, embed: EMBED },
      providers: [
        MockProvider(WidgetBridgeService, { start }),
        MockProvider(TrnDialogRef, { close: vi.fn() }),
      ],
    });

    expect(start).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLIFrameElement>('iframe')?.hasAttribute('src'),
    ).toBe(false);
    expect(
      container.querySelector('[data-testid="widget-frame-status"]'),
    ).toHaveTextContent('No third-party page was loaded.');
  });
});
