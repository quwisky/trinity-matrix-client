import { convertToParamMap } from '@angular/router';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceUrl, workspaceUrlOf } from './workspace-url';

describe('Workspace URL projection', () => {
  it('parses a typed notification event anchor only beside a valid Room', () => {
    expect(
      parseWorkspaceUrl(
        convertToParamMap({ roomId: encodeRoomSegment('!room:example.org') }),
        convertToParamMap({
          account: '@alice:example.org',
          event: '$notification',
        }),
        '@alice:example.org',
      ),
    ).toMatchObject({ eventId: '$notification', canonical: true });
    expect(
      parseWorkspaceUrl(
        convertToParamMap({ roomId: encodeRoomSegment('!room:example.org') }),
        convertToParamMap({
          account: '@alice:example.org',
          event: 'not-an-event',
        }),
        '@alice:example.org',
      ),
    ).toMatchObject({ canonical: false });
  });

  it('round-trips an exact Account, space, and room destination', () => {
    const destination = {
      accountId: '@alice:example.org',
      scope: { kind: 'space', spaceId: '!space:example.org' },
      roomId: '!room:example.org',
      pane: 'conversation',
    } as const;
    const projected = workspaceUrlOf(destination);

    expect(
      parseWorkspaceUrl(
        convertToParamMap({ roomId: projected.commands[1] }),
        convertToParamMap(projected.queryParams),
        '@other:example.org',
      ),
    ).toEqual({ destination, canonical: true });
  });

  it('uses the active Account for a legacy room URL and requests canonical repair', () => {
    expect(
      parseWorkspaceUrl(
        convertToParamMap({
          roomId: encodeRoomSegment('!room:example.org'),
        }),
        convertToParamMap({}),
        '@alice:example.org',
      ),
    ).toEqual({
      destination: {
        accountId: '@alice:example.org',
        scope: { kind: 'recent' },
        roomId: '!room:example.org',
        pane: 'conversation',
      },
      canonical: false,
    });
  });

  it.each([
    [{ view: 'unknown' }, {}],
    [{ view: 'home', space: encodeRoomSegment('!space:example.org') }, {}],
    [{ space: 'not-an-encoded-room' }, {}],
    [{}, { roomId: 'not-an-encoded-room' }],
  ])(
    'repairs malformed selection %j to a safe destination',
    (query, params) => {
      expect(
        parseWorkspaceUrl(
          convertToParamMap(params),
          convertToParamMap({ account: '@alice:example.org', ...query }),
          '@alice:example.org',
        ),
      ).toEqual({
        destination: {
          accountId: '@alice:example.org',
          scope: { kind: 'recent' },
          roomId: null,
          pane: 'list',
        },
        canonical: false,
      });
    },
  );

  it('rejects a malformed Account when no active Account can repair it', () => {
    expect(
      parseWorkspaceUrl(
        convertToParamMap({}),
        convertToParamMap({ account: 'alice' }),
        null,
      ),
    ).toEqual({ destination: null, canonical: false });
  });

  it('round-trips a retained Room while the compact list pane is selected', () => {
    const destination = {
      accountId: '@alice:example.org',
      scope: { kind: 'rooms' },
      roomId: '!room:example.org',
      pane: 'list',
    } as const;
    const projected = workspaceUrlOf(destination);

    expect(projected.queryParams).toEqual({
      account: '@alice:example.org',
      pane: 'list',
      view: 'rooms',
    });
    expect(
      parseWorkspaceUrl(
        convertToParamMap({ roomId: projected.commands[1] }),
        convertToParamMap(projected.queryParams),
        '@alice:example.org',
      ),
    ).toEqual({ destination, canonical: true });
  });

  it('drops a valid Room when its combined scope coordinates are malformed', () => {
    expect(
      parseWorkspaceUrl(
        convertToParamMap({
          roomId: encodeRoomSegment('!room:example.org'),
        }),
        convertToParamMap({
          account: '@alice:example.org',
          view: 'home',
          space: encodeRoomSegment('!space:example.org'),
        }),
        '@alice:example.org',
      ),
    ).toEqual({
      destination: {
        accountId: '@alice:example.org',
        scope: { kind: 'recent' },
        roomId: null,
        pane: 'list',
      },
      canonical: false,
    });
  });
});
