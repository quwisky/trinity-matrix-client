import { signal } from '@angular/core';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  WidgetsService,
  type RoomWidget,
  type WidgetLaunch,
} from '@trinity/data-access/widgets';
import { ExternalBrowserService } from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { RoomWidgetsComponent } from './room-widgets.component';

const BOARD_WIDGET: RoomWidget = {
  id: 'board',
  name: 'Planning board',
  type: 'm.custom',
  rawUrl:
    'https://widgets.example/board?room=$matrix_room_id&user=$matrix_user_id',
  data: {},
  creatorUserId: '@alice:example.org',
  waitForIframeLoad: true,
};

const BOARD_LAUNCH: WidgetLaunch = {
  url: 'https://widgets.example/board?room=!r%3Ahs&user=%40me%3Ahs',
  origin: 'https://widgets.example',
  disclosures: [
    { kind: 'room-id', label: 'this room’s ID' },
    { kind: 'user-id', label: 'your Matrix user ID' },
  ],
  insecure: false,
  failure: null,
};

async function build(
  over: {
    widgets?: readonly RoomWidget[];
    launchFor?: Mock;
    openExternal?: Mock;
    openDialog?: Mock;
  } = {},
) {
  const connect = vi.fn();
  const disconnect = vi.fn();
  const launchFor =
    over.launchFor ?? vi.fn<() => WidgetLaunch>(() => BOARD_LAUNCH);
  const openExternal = over.openExternal ?? vi.fn(() => of(true));
  const widgets = signal<readonly RoomWidget[]>(over.widgets ?? []);
  const toastShow = vi.fn();
  const openDialog = over.openDialog ?? vi.fn();
  const { fixture, container } = await render(RoomWidgetsComponent, {
    inputs: { roomId: '!r:hs' },
    providers: [
      MockProvider(WidgetsService, {
        widgetsFor: () => widgets.asReadonly(),
        launchFor,
        connect,
        disconnect,
      }),
      MockProvider(ExternalBrowserService, { open: openExternal }),
      MockProvider(TrnToastService, { show: toastShow }),
      MockProvider(TrnDialogService, { open: openDialog }),
    ],
  });
  return {
    container,
    fixture,
    connect,
    disconnect,
    openExternal,
    toastShow,
    openDialog,
  };
}

describe('RoomWidgetsComponent', () => {
  it('connects live widget state and explains an empty room', async () => {
    const { container, connect } = await build();

    expect(connect).toHaveBeenCalledWith('!r:hs');
    expect(
      container.querySelector('[data-testid="room-settings-widgets-empty"]'),
    ).toHaveTextContent('No widgets are declared in this room');
  });

  it('shows widget metadata, the raw template, destination, and disclosures', async () => {
    const { container } = await build({ widgets: [BOARD_WIDGET] });

    const card = container.querySelector('[data-testid="room-widget-board"]');
    expect(card).toHaveTextContent('Planning board');
    expect(card).toHaveTextContent('m.custom');
    expect(card).toHaveTextContent(BOARD_WIDGET.rawUrl);
    expect(card).toHaveTextContent('https://widgets.example');
    expect(card).toHaveTextContent('this room’s ID');
    expect(card).toHaveTextContent('your Matrix user ID');
    expect(card).toHaveTextContent('network and browser information');

    const link = card?.querySelector<HTMLAnchorElement>(
      '[data-testid="room-widget-open-board"]',
    );
    expect(link?.getAttribute('href')).toBe(BOARD_LAUNCH.url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('aria-label')).toBe(
      'Open Planning board in browser',
    );
  });

  it('delegates a safe widget link to the cross-platform browser service', async () => {
    const openExternal = vi.fn(() => of(true));
    const { container } = await build({
      widgets: [BOARD_WIDGET],
      openExternal,
    });

    container
      .querySelector<HTMLElement>('[data-testid="room-widget-open-board"]')
      ?.click();

    expect(openExternal).toHaveBeenCalledWith(BOARD_LAUNCH.url);
  });

  it('opens an eligible widget in Trinity only after an explicit click', async () => {
    const openDialog = vi.fn();
    const { container } = await build({
      widgets: [BOARD_WIDGET],
      openDialog,
    });

    expect(openDialog).not.toHaveBeenCalled();
    container
      .querySelector<HTMLElement>('[data-testid="room-widget-embed-board"]')
      ?.click();

    expect(openDialog).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        side: 'full-screen',
        ariaLabel: 'Planning board widget',
        inputs: expect.objectContaining({
          roomId: '!r:hs',
          widget: BOARD_WIDGET,
          embed: expect.objectContaining({
            url: BOARD_LAUNCH.url,
            origin: BOARD_LAUNCH.origin,
          }),
        }),
      }),
    );
  });

  it('reports when the external browser cannot open a widget', async () => {
    const { container, toastShow } = await build({
      widgets: [BOARD_WIDGET],
      openExternal: vi.fn(() => of(false)),
    });

    container
      .querySelector<HTMLElement>('[data-testid="room-widget-open-board"]')
      ?.click();

    expect(toastShow).toHaveBeenCalledWith(
      'Could not open this widget in a browser.',
      { duration: 4000, variant: 'destructive' },
    );
  });

  it('does not report a late browser result after it is destroyed', async () => {
    const result = new Subject<boolean>();
    const { container, fixture, toastShow } = await build({
      widgets: [BOARD_WIDGET],
      openExternal: vi.fn(() => result.asObservable()),
    });
    container
      .querySelector<HTMLElement>('[data-testid="room-widget-open-board"]')
      ?.click();

    fixture.destroy();
    result.next(false);

    expect(toastShow).not.toHaveBeenCalled();
  });

  it('lists an unsafe widget but does not make it clickable', async () => {
    const launchFor = vi.fn<() => WidgetLaunch>(() => ({
      url: null,
      origin: null,
      disclosures: [],
      insecure: false,
      failure: 'unsupported-protocol',
    }));
    const unsafe = {
      ...BOARD_WIDGET,
      rawUrl: 'javascript:alert(document.cookie)',
    };
    const { container } = await build({ widgets: [unsafe], launchFor });

    const card = container.querySelector('[data-testid="room-widget-board"]');
    expect(card).toHaveTextContent('javascript:alert(document.cookie)');
    expect(card).toHaveTextContent(
      'Only HTTP and HTTPS widget links can be opened',
    );
    expect(
      card?.querySelector('[data-testid="room-widget-open-board"]'),
    ).toBeNull();
  });

  it('disconnects live widget state when destroyed', async () => {
    const { fixture, disconnect } = await build();

    fixture.destroy();

    expect(disconnect).toHaveBeenCalledWith('!r:hs');
  });
});
