import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '@trinity/data-access/media';
import { ConversationActionContextService } from './conversation-action-context.service';
import { TimelineActionsService } from './timeline-actions.service';
import {
  emoteMessageContent,
  locationMessageContent,
  mediaCaptionFields,
  renderMarkdown,
  textMessageContent,
  voiceMessageContent,
} from '@trinity/util/matrix';
import {
  ROOM_KEY,
  fakeClient,
  fakeEdit,
  fakeEvent,
  fakeRoom,
  matrixProvider,
  privacyProvider,
  setupActions,
} from './timeline.spec-harness';
import { resolvedShields } from './js-sdk/shields';

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

  it("forwards what a message's sender wrote, not someone else's edit of it", async () => {
    const sent: unknown[][] = [];
    const svc = setupActions(
      [
        fakeEvent({
          id: '$src',
          sender: '@a:hs',
          body: 'forward me',
          replacement: {
            ...fakeEdit('$src'),
            getSender: () => '@m:hs',
            getContent: () => ({
              'm.new_content': { msgtype: 'm.text', body: 'forged' },
            }),
          },
        }),
      ],
      sent,
    );

    await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!target:hs'));

    const message = sent.find((c) => c[0] === 'message');
    expect((message?.[1] as Record<string, unknown>)['body']).toBe(
      'forward me',
    );
  });

  it('forwards a message as its row shows it, holding an unchecked edit back', async () => {
    const sent: unknown[][] = [];
    const message = fakeEvent({
      id: '$src',
      sender: '@a:hs',
      body: 'forward me',
      encrypted: true,
      replacement: {
        ...fakeEdit('$src', true),
        getOriginalContent: () => ({
          'm.new_content': { msgtype: 'm.text', body: 'as edited' },
        }),
      },
    });
    const svc = setupActions([message], sent);
    const forwarded = async () => {
      await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!target:hs'));
      return (
        sent.filter((c) => c[0] === 'message').at(-1)?.[1] as Record<
          string,
          unknown
        >
      )['body'];
    };

    expect(await forwarded()).toBe('forward me');

    resolvedShields.set(message.replacingEvent() as never, null);
    expect(await forwarded()).toBe('as edited');
  });

  it('forwards an encrypted message as sent, not its unencrypted edit', async () => {
    const sent: unknown[][] = [];
    const message = fakeEvent({
      id: '$src',
      sender: '@a:hs',
      body: 'forward me',
      encrypted: true,
      replacement: {
        ...fakeEdit('$src'),
        getOriginalContent: () => ({
          'm.new_content': { msgtype: 'm.text', body: 'as edited' },
        }),
      },
    });
    const svc = setupActions([message], sent);

    await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!target:hs'));

    const forwarded = sent.find((c) => c[0] === 'message');
    expect((forwarded?.[1] as Record<string, unknown>)['body']).toBe(
      'forward me',
    );
  });

  describe('forwarded content', () => {
    const encryptedFile = {
      url: 'mxc://hs/enc',
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        k: 'k',
        key_ops: ['encrypt', 'decrypt'],
        ext: true,
      },
      iv: 'iv',
      hashes: { sha256: 'h' },
      v: 'v2',
    };
    const reply = { 'm.in_reply_to': { event_id: '$parent' } };
    const shapes: [string, Record<string, unknown>][] = [
      [
        'a text with a mention',
        textMessageContent('hi @Alice', renderMarkdown('hi @Alice'), [
          { userId: '@alice:hs', display: '@Alice' },
        ]),
      ],
      [
        'a notice',
        {
          msgtype: 'm.notice',
          body: 'built',
          format: 'org.matrix.custom.html',
          formatted_body: '<b>built</b>',
        },
      ],
      ['an emote', emoteMessageContent('waves', renderMarkdown('waves'))],
      [
        'an encrypted image with a caption',
        {
          msgtype: 'm.image',
          ...mediaCaptionFields('cat.png', '**look**'),
          info: {
            mimetype: 'image/png',
            size: 10,
            w: 4,
            h: 3,
            thumbnail_file: encryptedFile,
            thumbnail_info: { mimetype: 'image/png', w: 2, h: 1 },
          },
          file: encryptedFile,
        },
      ],
      [
        'a file',
        {
          msgtype: 'm.file',
          body: 'doc.pdf',
          info: { mimetype: 'application/pdf', size: 99 },
          url: 'mxc://hs/doc',
        },
      ],
      [
        'a voice message',
        voiceMessageContent(
          { mxc: 'mxc://hs/v', file: null, mimeType: 'audio/webm', size: 5 },
          1200,
          [0, 512, 1024],
        ),
      ],
      [
        'a video',
        {
          msgtype: 'm.video',
          body: 'clip.mp4',
          info: {
            mimetype: 'video/mp4',
            size: 7,
            duration: 3000,
            w: 16,
            h: 9,
            thumbnail_url: 'mxc://hs/thumb',
            thumbnail_info: { mimetype: 'image/jpeg', w: 16, h: 9 },
          },
          url: 'mxc://hs/clip',
        },
      ],
      ['a location', locationMessageContent(52.51, 13.38, 'Berlin')],
    ];

    for (const [name, original] of shapes) {
      it(`forwards ${name} as it was, mentioning nobody`, async () => {
        const sent: unknown[][] = [];
        const svc = setupActions(
          [
            fakeEvent({
              id: '$src',
              sender: '@a:hs',
              content: { ...original, 'm.relates_to': reply },
            }),
          ],
          sent,
        );

        await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));

        expect(sent).toEqual([['message', { ...original, 'm.mentions': {} }]]);
      });
    }

    const forwardOf = async (content: Record<string, unknown>) => {
      const sent: unknown[][] = [];
      const svc = setupActions(
        [fakeEvent({ id: '$src', sender: '@a:hs', content })],
        sent,
      );
      await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));
      return sent;
    };
    const shownSources: [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ][] = [
      [
        'only the encrypted file of an attachment that also names a url',
        { url: 'mxc://hs/other', file: encryptedFile },
        { file: encryptedFile },
      ],
      [
        'only the url of a plain attachment',
        { url: 'mxc://hs/doc', file: { url: 'mxc://hs/x' } },
        { url: 'mxc://hs/doc' },
      ],
    ];
    for (const [name, source, shown] of shownSources) {
      it(`forwards ${name}`, async () => {
        const base = { msgtype: 'm.file', body: 'doc.pdf' };

        expect(await forwardOf({ ...base, ...source })).toEqual([
          ['message', { ...base, ...shown, 'm.mentions': {} }],
        ]);
      });
    }

    const shownThumbnails: [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ][] = [
      [
        'the encrypted thumbnail of one that also names a url',
        { thumbnail_url: 'mxc://hs/other', thumbnail_file: encryptedFile },
        { thumbnail_file: encryptedFile },
      ],
      [
        'the url thumbnail of a plain one',
        { thumbnail_url: 'mxc://hs/thumb', thumbnail_file: { iv: 'iv' } },
        { thumbnail_url: 'mxc://hs/thumb' },
      ],
    ];
    for (const [name, thumbnail, shown] of shownThumbnails) {
      it(`forwards only ${name}, and only the info it shows`, async () => {
        const base = {
          msgtype: 'm.image',
          body: 'cat.png',
          url: 'mxc://hs/cat',
        };
        const info = { mimetype: 'image/png', size: 10, w: 4, h: 3 };
        const thumbnailInfo = { mimetype: 'image/png', size: 2, w: 2, h: 1 };

        expect(
          await forwardOf({
            ...base,
            info: {
              ...info,
              ...thumbnail,
              thumbnail_info: { ...thumbnailInfo, 'com.example': 1 },
              'com.example.extra': 'x',
            },
          }),
        ).toEqual([
          [
            'message',
            {
              ...base,
              info: { ...info, ...shown, thumbnail_info: thumbnailInfo },
              'm.mentions': {},
            },
          ],
        ]);
      });
    }

    it('forwards a location as its row shows it, not its disagreeing extras', async () => {
      expect(
        await forwardOf({
          msgtype: 'm.location',
          body: 'Berlin',
          geo_uri: 'geo:52.51,13.38',
          'org.matrix.msc3488.location': {
            uri: 'geo:48.85,2.35',
            description: 'Paris',
          },
          'org.matrix.msc3488.asset': { type: 'm.pin' },
          'org.matrix.msc1767.text': 'Paris',
        }),
      ).toEqual([
        [
          'message',
          {
            ...locationMessageContent(52.51, 13.38, 'Berlin'),
            'm.mentions': {},
          },
        ],
      ]);
    });

    it('forwards a sticker as a sticker', async () => {
      const sticker = {
        body: 'Party parrot',
        url: 'mxc://hs/parrot',
        info: { mimetype: 'image/png', w: 64, h: 48, size: 4096 },
      };
      const sent: unknown[][] = [];
      const svc = setupActions(
        [
          fakeEvent({
            id: '$src',
            sender: '@a:hs',
            type: 'm.sticker',
            content: { ...sticker, 'm.relates_to': reply },
          }),
        ],
        sent,
      );

      await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));

      expect(sent).toEqual([
        ['event', 'm.sticker', { ...sticker, 'm.mentions': {} }],
      ]);
    });

    it("drops the original's mentions and any key its type does not define", async () => {
      const sent: unknown[][] = [];
      const svc = setupActions(
        [
          fakeEvent({
            id: '$src',
            sender: '@a:hs',
            content: {
              msgtype: 'm.text',
              body: 'hello',
              'm.mentions': { user_ids: ['@victim:hs'], room: true },
              'm.new_content': { msgtype: 'm.text', body: 'edited' },
              'com.example.extra': { ping: true },
              geo_uri: 'geo:1,2',
            },
          }),
        ],
        sent,
      );

      await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));

      expect(sent).toEqual([
        ['message', { msgtype: 'm.text', body: 'hello', 'm.mentions': {} }],
      ]);
    });

    const fallbacks: [string, string, string][] = [
      [
        'the quote of the message it replied to',
        '> <@bob:hs> the original\n\nmy reply',
        '<mx-reply><blockquote><a href="https://matrix.to/#/@bob:hs">@bob:hs</a> the original</blockquote></mx-reply>my reply',
      ],
      [
        'a made-up quote the forwarder never saw',
        '> <@bob:hs> Bob: approved, send it\n\nmy reply',
        '<mx-reply><blockquote>Bob: approved, send it</blockquote></mx-reply>my reply',
      ],
    ];
    for (const [name, body, html] of fallbacks) {
      it(`drops a reply's fallback: ${name}`, async () => {
        const sent: unknown[][] = [];
        const svc = setupActions(
          [
            fakeEvent({
              id: '$src',
              sender: '@a:hs',
              replyTo: '$parent',
              content: {
                msgtype: 'm.text',
                body,
                format: 'org.matrix.custom.html',
                formatted_body: html,
                'm.relates_to': reply,
              },
            }),
          ],
          sent,
        );

        await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));

        expect(sent).toEqual([
          [
            'message',
            {
              msgtype: 'm.text',
              body: 'my reply',
              format: 'org.matrix.custom.html',
              formatted_body: 'my reply',
              'm.mentions': {},
            },
          ],
        ]);
      });
    }

    it('keeps a leading quote in a message that is not a reply', async () => {
      const content = { msgtype: 'm.text', body: '> quoted\n\nmine' };
      const sent: unknown[][] = [];
      const svc = setupActions(
        [fakeEvent({ id: '$src', sender: '@a:hs', content })],
        sent,
      );

      await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));

      expect(sent).toEqual([['message', { ...content, 'm.mentions': {} }]]);
    });

    it("forwards a reply's valid edit as its own text only, and ignores a plaintext edit of an encrypted reply", async () => {
      const fallback = (text: string) => ({
        msgtype: 'm.text',
        body: `> <@bob:hs> quoted\n\n${text}`,
        format: 'org.matrix.custom.html',
        formatted_body: `<mx-reply><blockquote>quoted</blockquote></mx-reply>${text}`,
        'm.mentions': { user_ids: ['@victim:hs'], room: true },
        'com.example.extra': { ping: true },
      });
      const edit = (encrypted: boolean) => ({
        ...fakeEdit('$src', encrypted),
        getOriginalContent: () => ({ 'm.new_content': fallback('as edited') }),
      });
      const sent: unknown[][] = [];
      const svc = setupActions(
        [
          fakeEvent({
            id: '$src',
            sender: '@a:hs',
            replyTo: '$parent',
            content: { ...fallback('as sent'), 'm.relates_to': reply },
            replacement: edit(false),
          }),
          fakeEvent({
            id: '$enc',
            sender: '@a:hs',
            replyTo: '$parent',
            encrypted: true,
            content: { ...fallback('as sent'), 'm.relates_to': reply },
            replacement: {
              ...edit(false),
              getRelation: () => ({ rel_type: 'm.replace', event_id: '$enc' }),
            },
          }),
        ],
        sent,
      );
      const own = (text: string) => ({
        msgtype: 'm.text',
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: text,
        'm.mentions': {},
      });

      await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs'));
      await firstValueFrom(svc.forwardMessage('!r:hs', '$enc', '!t:hs'));

      expect(sent).toEqual([
        ['message', own('as edited')],
        ['message', own('as sent')],
      ]);
    });

    it('refuses a message type it cannot forward faithfully', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions(
        [
          fakeEvent({
            id: '$src',
            sender: '@a:hs',
            content: { msgtype: 'constructor', body: 'odd' },
          }),
        ],
        sent,
      );

      await expect(
        firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!t:hs')),
      ).rejects.toThrow();
      expect(sent).toEqual([]);
    });
  });

  it('errors when forwarding an event that cannot be found', async () => {
    const svc = setupActions([]);
    await expect(
      firstValueFrom(svc.forwardMessage('!r:hs', '$missing', '!target:hs')),
    ).rejects.toThrow();
  });

  it('forward of a missing message rejects with "Message not found."', async () => {
    const svc = setupActions([]);
    await expect(
      firstValueFrom(svc.forwardMessage('!r:hs', '$missing', '!target:hs')),
    ).rejects.toThrow('Message not found.');
  });

  it('errors when a send fails and its echo stays unsent', async () => {
    const room = { ...fakeRoom([]), getEventForTxnId: () => ({}) };
    const client = {
      ...fakeClient(room, []),
      sendEvent: () => Promise.reject(new Error('offline')),
    };
    TestBed.configureTestingModule({
      providers: [TimelineActionsService, matrixProvider(client)],
    });
    TestBed.inject(ConversationActionContextService).bind(() => ROOM_KEY);

    await expect(
      firstValueFrom(TestBed.inject(TimelineActionsService).endPoll('$p')),
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

describe('TimelineActionsService voice clips', () => {
  const recording = {
    blob: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
    durationMs: 1000,
    waveform: [1],
    mimeType: 'audio/webm',
  };

  function setupVoice(
    crypto: {
      isEncryptionEnabledInRoom: () => Promise<boolean>;
    } | null,
  ) {
    const uploadMedia = vi.fn((..._args: unknown[]) =>
      of({
        msgtype: 'm.audio',
        body: 'voice-message.webm',
        mxc: 'mxc://hs/voice',
        info: { mimetype: 'audio/webm', size: 1 },
      }),
    );
    const room = { roomId: '!r:hs', hasEncryptionStateEvent: () => false };
    const client = {
      getUserId: () => ROOM_KEY.accountId,
      getRoom: () => room,
      makeTxnId: () => 'txn',
      getCrypto: () => crypto ?? undefined,
      sendMessage: vi.fn(() => Promise.resolve({ event_id: '$voice' })),
    };
    TestBed.configureTestingModule({
      providers: [
        matrixProvider(client),
        { provide: MediaService, useValue: { uploadMedia } },
      ],
    });
    TestBed.inject(ConversationActionContextService).bind(() => ROOM_KEY);
    return { svc: TestBed.inject(TimelineActionsService), uploadMedia, client };
  }

  it('encrypts a clip for a room the crypto store has as encrypted when its state lacks the event', async () => {
    const { svc, uploadMedia } = setupVoice({
      isEncryptionEnabledInRoom: () => Promise.resolve(true),
    });

    await firstValueFrom(svc.sendVoiceMessage(recording));

    expect(uploadMedia).toHaveBeenCalledWith(
      expect.any(File),
      true,
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it('encrypts a clip when the crypto store fails to answer', async () => {
    const { svc, uploadMedia } = setupVoice({
      isEncryptionEnabledInRoom: () => Promise.reject(new Error('store')),
    });

    await firstValueFrom(svc.sendVoiceMessage(recording));

    expect(uploadMedia).toHaveBeenCalledWith(
      expect.any(File),
      true,
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it('refuses to upload a clip when the crypto store is unavailable', async () => {
    const { svc, uploadMedia, client } = setupVoice(null);

    await expect(
      firstValueFrom(svc.sendVoiceMessage(recording)),
    ).rejects.toThrow();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
