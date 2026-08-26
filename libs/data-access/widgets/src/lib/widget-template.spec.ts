import { describe, expect, it } from 'vitest';
import type { RoomWidget, WidgetTemplateContext } from './widget.model';
import { resolveWidgetLaunch } from './widget-template';

const widget: RoomWidget = {
  id: 'board/1',
  name: 'Planning board',
  type: 'm.custom',
  rawUrl: 'https://widgets.example/board',
  data: {},
  creatorUserId: '@alice:example.org',
  waitForIframeLoad: true,
};

const context: WidgetTemplateContext = {
  roomId: '!room:example.org',
  userId: '@alice:example.org',
  displayName: 'Alice Smith',
  avatarUrl: 'https://example.org/avatar/alice',
  clientId: 'eu.qwky.trinity',
  theme: 'dark',
  language: 'en-GB',
  deviceId: 'DEVICE 1',
  baseUrl: 'https://matrix.example.org',
};

describe('resolveWidgetLaunch', () => {
  it('expands every standard variable, widget data, and reports exact disclosures', () => {
    const rawUrl =
      'https://widgets.example/open' +
      '?room=$matrix_room_id' +
      '&user=$matrix_user_id' +
      '&name=$matrix_display_name' +
      '&avatar=$matrix_avatar_url' +
      '&widget=$matrix_widget_id' +
      '&client=$org.matrix.msc2873.client_id' +
      '&theme=$org.matrix.msc2873.client_theme' +
      '&language=$org.matrix.msc2873.client_language' +
      '&device=$org.matrix.msc3819.matrix_device_id' +
      '&base=$org.matrix.msc4039.matrix_base_url' +
      '&board=$board_id' +
      '&unknown=$not_declared';

    const launch = resolveWidgetLaunch(
      { ...widget, rawUrl, data: { board_id: 'road map' } },
      context,
    );

    expect(launch.url).not.toBeNull();
    const url = new URL(launch.url as string);
    expect(url.origin).toBe('https://widgets.example');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      room: '!room:example.org',
      user: '@alice:example.org',
      name: 'Alice Smith',
      avatar: 'https://example.org/avatar/alice',
      widget: 'board/1',
      client: 'eu.qwky.trinity',
      theme: 'dark',
      language: 'en-GB',
      device: 'DEVICE 1',
      base: 'https://matrix.example.org',
      board: 'road map',
      unknown: '$not_declared',
    });
    expect(launch.disclosures.map((item) => item.kind)).toEqual([
      'room-id',
      'user-id',
      'display-name',
      'avatar-url',
      'widget-id',
      'client-id',
      'theme',
      'language',
      'device-id',
      'homeserver-url',
    ]);
  });

  it('lets authoritative values override widget data without prefix collisions', () => {
    const launch = resolveWidgetLaunch(
      {
        ...widget,
        rawUrl: 'https://widgets.example/?user=$matrix_user_id&short=$matrix',
        data: {
          matrix: 'custom',
          matrix_user_id: '@mallory:evil.example',
        },
      },
      context,
    );

    const url = new URL(launch.url as string);
    expect(url.searchParams.get('user')).toBe('@alice:example.org');
    expect(url.searchParams.get('short')).toBe('custom');
  });

  it('reports only placeholders that actually disclose a non-empty value', () => {
    const launch = resolveWidgetLaunch(
      {
        ...widget,
        rawUrl:
          'https://widgets.example/?room=$matrix_room_id&avatar=$matrix_avatar_url',
      },
      { ...context, avatarUrl: '' },
    );

    expect(launch.disclosures.map((item) => item.kind)).toEqual(['room-id']);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello'])(
    'refuses the unsafe %s protocol',
    (rawUrl) => {
      const launch = resolveWidgetLaunch({ ...widget, rawUrl }, context);

      expect(launch).toMatchObject({
        url: null,
        origin: null,
        failure: 'unsupported-protocol',
      });
    },
  );

  it('refuses a malformed URL', () => {
    expect(
      resolveWidgetLaunch({ ...widget, rawUrl: 'not a URL' }, context),
    ).toMatchObject({ url: null, origin: null, failure: 'invalid-url' });
  });

  it('marks plain HTTP without blocking the explicit open action', () => {
    expect(
      resolveWidgetLaunch(
        { ...widget, rawUrl: 'http://widgets.example/board' },
        context,
      ),
    ).toMatchObject({
      url: 'http://widgets.example/board',
      origin: 'http://widgets.example',
      insecure: true,
      failure: null,
    });
  });
});
