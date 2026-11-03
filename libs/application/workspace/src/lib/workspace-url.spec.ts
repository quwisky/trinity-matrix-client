import { convertToParamMap } from '@angular/router';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { describe, expect, it } from 'vitest';
import {
  isWorkspacePanelChange,
  parseWorkspaceUrl,
  workspaceUrlOf,
} from './workspace-url';

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

  it('projects an optional semantic event anchor into the canonical Room URL', () => {
    const destination = {
      accountId: '@alice:example.org',
      scope: { kind: 'recent' },
      roomId: '!room:example.org',
      pane: 'conversation',
      panel: null,
    } as const;

    expect(workspaceUrlOf(destination, '$notification').queryParams).toEqual({
      account: '@alice:example.org',
      event: '$notification',
    });
  });

  it('round-trips an exact Account, space, and room destination', () => {
    const destination = {
      accountId: '@alice:example.org',
      scope: { kind: 'space', spaceId: '!space:example.org' },
      roomId: '!room:example.org',
      pane: 'conversation',
      panel: null,
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
        panel: null,
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
          panel: null,
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
      panel: null,
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
        panel: null,
      },
      canonical: false,
    });
  });

  it('round-trips view=inbox as canonical', () => {
    const destination = {
      accountId: '@alice:example.org',
      scope: { kind: 'inbox' },
      roomId: null,
      pane: 'list',
      panel: null,
    } as const;
    const projected = workspaceUrlOf(destination);

    expect(projected.queryParams).toEqual({
      account: '@alice:example.org',
      view: 'inbox',
    });
    expect(
      parseWorkspaceUrl(
        convertToParamMap({}),
        convertToParamMap(projected.queryParams),
        '@alice:example.org',
      ),
    ).toEqual({ destination, canonical: true });
  });
  describe('room panel', () => {
    const base = {
      accountId: '@alice:example.org',
      scope: { kind: 'recent' },
      roomId: '!room:example.org',
      pane: 'conversation',
    } as const;
    const parse = (query: Record<string, string>) =>
      parseWorkspaceUrl(
        convertToParamMap({ roomId: encodeRoomSegment(base.roomId) }),
        convertToParamMap({ account: base.accountId, ...query }),
        base.accountId,
      );

    it.each([
      { kind: 'members' },
      { kind: 'threads' },
      { kind: 'pinned' },
      { kind: 'search' },
      { kind: 'thread', root: '$root:example.org' },
    ] as const)('round-trips the $kind panel', (panel) => {
      const destination = { ...base, panel };
      expect(parse(workspaceUrlOf(destination).queryParams)).toEqual({
        destination,
        canonical: true,
      });
    });

    it('keeps $ and : in a thread root and never writes a search query', () => {
      const root = '$abc_DEF-123:example.org';
      expect(
        workspaceUrlOf({ ...base, panel: { kind: 'thread', root } })
          .queryParams,
      ).toEqual({
        account: base.accountId,
        panel: 'thread',
        root,
      });
      expect(
        workspaceUrlOf({ ...base, panel: { kind: 'search' } }).queryParams,
      ).toEqual({ account: base.accountId, panel: 'search' });
    });

    it.each<Record<string, string>>([
      { panel: 'thread' },
      { panel: 'thread', root: 'not-an-event' },
      { panel: 'thread', root: '$has space' },
      { panel: 'unknown' },
      { panel: 'members', root: '$root:example.org' },
      { root: '$root:example.org' },
    ])('parses %o to no panel and repairs the URL', (query) => {
      expect(parse(query)).toMatchObject({
        destination: { panel: null },
        canonical: false,
      });
    });

    it('never carries a panel on a list destination', () => {
      const members = { kind: 'members' } as const;
      expect(
        workspaceUrlOf({ ...base, pane: 'list', panel: members }).queryParams,
      ).not.toHaveProperty('panel');
      expect(parse({ pane: 'list', panel: 'members' })).toMatchObject({
        destination: { pane: 'list', panel: null },
        canonical: false,
      });
      expect(
        parseWorkspaceUrl(
          convertToParamMap({}),
          convertToParamMap({ account: base.accountId, panel: 'members' }),
          base.accountId,
        ),
      ).toMatchObject({ destination: { roomId: null, panel: null } });
    });
  });
});

describe('isWorkspacePanelChange', () => {
  const room = '/rooms/IXI6aHM?account=%40me%3Ahs&view=rooms';

  it('names a navigation that only opens, switches or closes the panel', () => {
    expect(isWorkspacePanelChange(room, `${room}&panel=members`)).toBe(true);
    expect(
      isWorkspacePanelChange(
        `${room}&panel=threads`,
        `${room}&panel=thread&root=%24root`,
      ),
    ).toBe(true);
    expect(isWorkspacePanelChange(`${room}&panel=pinned`, room)).toBe(true);
    expect(
      isWorkspacePanelChange(`${room}&event=%24e`, `${room}&panel=threads`),
    ).toBe(true);
  });

  it('leaves out every other navigation', () => {
    expect(isWorkspacePanelChange(room, room)).toBe(false);
    expect(isWorkspacePanelChange(room, `${room}&event=%24e`)).toBe(false);
    expect(
      isWorkspacePanelChange(
        `${room}&panel=members`,
        '/rooms/IWI6aHM?account=%40me%3Ahs&view=rooms',
      ),
    ).toBe(false);
    expect(
      isWorkspacePanelChange(
        '/rooms?account=%40me%3Ahs',
        '/rooms?account=%40me%3Ahs&panel=members',
      ),
    ).toBe(false);
  });
});
