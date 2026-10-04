import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeEvent,
  privacyProvider,
  setupActions,
} from './timeline.spec-harness';

describe('TimelineActionsService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [privacyProvider(true)] });
  });

  it('sends a shared location as m.location', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);

    await firstValueFrom(svc.sendLocation(52.51, 13.38));

    expect(sent[0][0]).toBe('message');
    expect(sent[0][1]).toMatchObject({
      msgtype: 'm.location',
      geo_uri: 'geo:52.51,13.38',
    });
  });

  it('sends an image-pack entry as an m.sticker event with exact media metadata', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);

    await firstValueFrom(
      svc.sendSticker({
        shortcode: 'party_parrot',
        url: 'mxc://hs/parrot',
        body: 'Party parrot',
        mimetype: 'image/png',
        width: 64,
        height: 48,
        info: {
          mimetype: 'image/png',
          size: 4096,
          w: 64,
          h: 48,
          thumbnail_url: 'mxc://hs/thumb',
          thumbnail_info: { mimetype: 'image/png', w: 32, h: 24 },
        },
        usage: ['sticker'],
        packId: '!pack:hs:fun',
        packName: 'Fun',
      }),
    );

    expect(sent[0]).toEqual([
      'event',
      'm.sticker',
      {
        body: 'Party parrot',
        url: 'mxc://hs/parrot',
        info: {
          mimetype: 'image/png',
          size: 4096,
          w: 64,
          h: 48,
          thumbnail_url: 'mxc://hs/thumb',
          thumbnail_info: { mimetype: 'image/png', w: 32, h: 24 },
        },
      },
    ]);
  });

  it('does not send a sticker with a remote tracking URL', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);

    await firstValueFrom(
      svc.sendSticker({
        shortcode: 'tracker',
        url: 'https://tracker.example/pixel.png',
        body: 'Tracker',
        mimetype: 'image/png',
        width: 1,
        height: 1,
        info: { mimetype: 'image/png', w: 1, h: 1 },
        usage: ['sticker'],
        packId: '!pack:hs:unsafe',
        packName: 'Unsafe',
      }),
    );

    expect(sent).toEqual([]);
  });

  it('forwards a message content to another room, dropping any relation', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions(
      [
        fakeEvent({
          id: '$src',
          sender: '@a:hs',
          body: 'forward me',
          relatesTo: { rel_type: 'm.thread', event_id: '$root' },
        }),
      ],
      sent,
    );

    await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!target:hs'));

    const message = sent.find((c) => c[0] === 'message');
    const content = message?.[1] as Record<string, unknown>;
    expect(content['body']).toBe('forward me');
    expect(content['m.relates_to']).toBeUndefined(); // standalone, not a thread reply
  });

  it('errors when forwarding an event that cannot be found', async () => {
    const svc = setupActions([]);
    await expect(
      firstValueFrom(svc.forwardMessage('!r:hs', '$missing', '!target:hs')),
    ).rejects.toThrow();
  });

  it('creates a poll via an MSC3381 poll start event', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.createPoll('Best fruit?', ['Apple', 'Pear']));
    const event = sent.find((c) => c[0] === 'event');
    expect(event?.[1]).toBe('org.matrix.msc3381.poll.start');
    const content = event?.[2] as Record<string, { answers: unknown[] }>;
    expect(content['org.matrix.msc3381.poll.start'].answers).toHaveLength(2);
  });

  it('sends the requested max_selections, clamped to the answer count', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.createPoll('Q', ['A', 'B', 'C'], 2));
    await firstValueFrom(svc.createPoll('Q', ['A', 'B', ' '], 5));
    const max = sent
      .filter((c) => c[0] === 'event')
      .map(
        (c) =>
          (c[2] as Record<string, { max_selections: number }>)[
            'org.matrix.msc3381.poll.start'
          ].max_selections,
      );
    expect(max).toEqual([2, 2]);
  });

  it('rejects a poll with fewer than two options', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.createPoll('Best fruit?', ['Apple', '  ']));
    expect(sent.some((c) => c[0] === 'event')).toBe(false);
  });

  it('casts a poll vote via an MSC3381 poll response event', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.votePoll('$p', ['a0', 'a1']));
    const event = sent.find((c) => c[0] === 'event');
    expect(event?.[1]).toBe('org.matrix.msc3381.poll.response');
    const content = event?.[2] as Record<string, { answers: string[] }>;
    expect(content['org.matrix.msc3381.poll.response'].answers).toEqual([
      'a0',
      'a1',
    ]);
  });

  it('ends a poll via an MSC3381 poll end event', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.endPoll('$p'));
    expect(sent.find((c) => c[0] === 'event')?.[1]).toBe(
      'org.matrix.msc3381.poll.end',
    );
  });
});
