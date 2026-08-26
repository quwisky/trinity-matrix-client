import { describe, expect, it } from 'vitest';
import type { RoomWidget, WidgetLaunch } from './widget.model';
import { resolveWidgetEmbed } from './widget-embed-policy';

const WIDGET: RoomWidget = {
  id: 'board',
  name: 'Board',
  type: 'm.custom',
  rawUrl: 'https://widgets.example/board',
  data: {},
  creatorUserId: '@alice:example.org',
  waitForIframeLoad: true,
};

const LAUNCH: WidgetLaunch = {
  url: 'https://widgets.example/board',
  origin: 'https://widgets.example',
  disclosures: [],
  insecure: false,
  failure: null,
};

describe('resolveWidgetEmbed', () => {
  it('accepts a resolved cross-origin HTTPS widget', () => {
    expect(
      resolveWidgetEmbed(WIDGET, LAUNCH, 'https://trinity.example'),
    ).toEqual({
      url: LAUNCH.url,
      origin: LAUNCH.origin,
      failure: null,
    });
  });

  it.each([
    [
      'HTTP',
      {
        ...LAUNCH,
        url: 'http://widgets.example',
        origin: 'http://widgets.example',
      },
      'insecure',
    ],
    [
      'same-origin',
      {
        ...LAUNCH,
        url: 'https://trinity.example/widget',
        origin: 'https://trinity.example',
      },
      'same-origin',
    ],
    ['missing creator', LAUNCH, 'missing-creator'],
  ] as const)('rejects %s embedding', (_label, launch, failure) => {
    const widget =
      failure === 'missing-creator'
        ? { ...WIDGET, creatorUserId: null }
        : WIDGET;

    expect(
      resolveWidgetEmbed(widget, launch, 'https://trinity.example'),
    ).toEqual({
      url: null,
      origin: null,
      failure,
    });
  });

  it.each(['jitsi', 'm.jitsi', 'm.call', ' M.CALL '])(
    'rejects the deployed call widget type %s',
    (type) => {
      expect(
        resolveWidgetEmbed(
          { ...WIDGET, type },
          LAUNCH,
          'https://trinity.example',
        ),
      ).toEqual({ url: null, origin: null, failure: 'call-widget' });
    },
  );

  it('rejects a launch whose recorded origin does not match its final URL', () => {
    expect(
      resolveWidgetEmbed(
        WIDGET,
        { ...LAUNCH, origin: 'https://attacker.example' },
        'https://trinity.example',
      ),
    ).toEqual({ url: null, origin: null, failure: 'invalid-url' });
  });
});
