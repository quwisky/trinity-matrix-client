import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationActionContextService } from './conversation-action-context.service';
import { TimelineActionsService } from './timeline-actions.service';
import { TimelineService } from './timeline.service';
import {
  fakeClient,
  fakeEvent,
  fakeRoom,
  mediaProvider,
  privacyProvider,
  setupActions,
  switchableMatrixProvider,
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

  it('creates a poll via an m.poll.start event', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.createPoll('Best fruit?', ['Apple', 'Pear']));
    const event = sent.find((c) => c[0] === 'event');
    expect(event?.[1]).toBe('m.poll.start');
    const content = event?.[2] as Record<string, { answers: unknown[] }>;
    expect(content['m.poll.start'].answers).toHaveLength(2);
  });

  it('rejects a poll with fewer than two options', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.createPoll('Best fruit?', ['Apple', '  ']));
    expect(sent.some((c) => c[0] === 'event')).toBe(false);
  });

  it('casts a poll vote via an m.poll.response event', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.votePoll('$p', 'a1'));
    const event = sent.find((c) => c[0] === 'event');
    expect(event?.[1]).toBe('m.poll.response');
    const content = event?.[2] as Record<string, { answers: string[] }>;
    expect(content['m.poll.response'].answers).toEqual(['a1']);
  });

  it('ends a poll via an m.poll.end event', async () => {
    const sent: unknown[][] = [];
    const svc = setupActions([], sent);
    await firstValueFrom(svc.endPoll('$p'));
    expect(sent.find((c) => c[0] === 'event')?.[1]).toBe('m.poll.end');
  });

  describe('sendMedia', () => {
    const png = () =>
      new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', {
        type: 'image/png',
      });
    const gif = () =>
      new File([new Uint8Array([1, 2, 3, 4])], 'trinity.gif', {
        type: 'image/gif',
      });

    it('sends a plaintext url media event in an unencrypted room', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions([], sent); // encrypted = false

      await firstValueFrom(svc.sendMedia(png(), ''));

      expect(sent[0][0]).toBe('message');
      const content = sent[0][1] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.image');
      expect(content['url']).toBe('mxc://hs/up');
      expect(content['file']).toBeUndefined();
      expect(content['info']).toMatchObject({ mimetype: 'image/png' });
      expect(content['body']).toBe('pic.png'); // no caption → body is the filename
      expect(content['filename']).toBeUndefined();
    });

    it('sends a caption as an MSC2530 body + filename (rich when formatted)', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions([], sent);

      await firstValueFrom(svc.sendMedia(png(), 'a **bold** caption'));

      const content = sent[0][1] as Record<string, unknown>;
      expect(content['body']).toBe('a **bold** caption'); // body carries the caption
      expect(content['filename']).toBe('pic.png'); // real file name preserved
      expect(content['format']).toBe('org.matrix.custom.html');
      expect(content['formatted_body']).toContain('<strong>bold</strong>');
    });

    it('sends an encrypted file media event in an E2EE room', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions([], sent, {}, true); // encrypted = true

      await firstValueFrom(svc.sendMedia(png(), ''));

      const content = sent[0][1] as Record<string, unknown>;
      expect(content['url']).toBeUndefined();
      expect(content['file']).toMatchObject({ url: 'mxc://hs/enc', v: 'v2' });
    });

    it('is a no-op for an empty file', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions([], sent);

      await firstValueFrom(
        svc.sendMedia(
          new File([], 'empty.bin', { type: 'application/octet-stream' }),
          '',
        ),
      );

      expect(sent).toHaveLength(0);
    });

    it('uploads a recording and sends it as an MSC3245 voice message', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions([], sent);

      await firstValueFrom(
        svc.sendVoiceMessage({
          blob: new Blob([new Uint8Array([1, 2, 3, 4])], {
            type: 'audio/webm',
          }),
          durationMs: 4200,
          waveform: [0, 512, 1024],
          mimeType: 'audio/webm',
        }),
      );

      expect(sent[0][0]).toBe('message');
      const content = sent[0][1] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.audio');
      expect(content['url']).toBe('mxc://hs/up');
      expect(content['org.matrix.msc3245.voice']).toEqual({});
      expect(content['org.matrix.msc1767.audio']).toEqual({
        duration: 4200,
        waveform: [0, 512, 1024],
      });
    });

    it('is a no-op for an empty recording', async () => {
      const sent: unknown[][] = [];
      const svc = setupActions([], sent);

      await firstValueFrom(
        svc.sendVoiceMessage({
          blob: new Blob([]),
          durationMs: 0,
          waveform: [],
          mimeType: 'audio/webm',
        }),
      );

      expect(sent).toHaveLength(0);
    });

    it('keeps sending through the immutable Conversation account', async () => {
      // A Conversation handle owns the client it opened on. Active Account can change
      // while the handle is retained, but the handle must never silently retarget.
      const sentA: unknown[][] = [];
      const sentB: unknown[][] = [];
      const room = fakeRoom([]);
      const active = { client: fakeClient(room, sentA) as unknown };
      const clientB = fakeClient(room, sentB);

      TestBed.configureTestingModule({
        providers: [
          TimelineService,
          TimelineActionsService,
          switchableMatrixProvider(active),
          mediaProvider(),
        ],
      });
      const timeline = TestBed.inject(TimelineService);
      timeline.open('!r:hs');
      TestBed.inject(ConversationActionContextService).bind(() =>
        timeline.openContext(),
      );
      const svc = TestBed.inject(TimelineActionsService);

      await firstValueFrom(svc.sendMedia(gif(), ''));
      expect(sentA).toHaveLength(1);
      expect(sentB).toHaveLength(0);

      active.client = clientB; // the user picks another account in the switcher

      await firstValueFrom(svc.sendMedia(gif(), ''));
      expect(sentA).toHaveLength(2);
      expect(sentB).toHaveLength(0);
      expect((sentA[1][1] as Record<string, unknown>)['msgtype']).toBe(
        'm.image',
      );
    });

    it('resolves the immutable Conversation on subscribe without retargeting', async () => {
      // These actions are documented as cold: calling them must do nothing until
      // subscribed. Even when Active Account changes before subscription, the focused
      // handle still names the original Account-and-Room pair; Workspace must focus a
      // different handle to change the action target.
      const sentA: unknown[][] = [];
      const sentB: unknown[][] = [];
      const room = fakeRoom([]);
      const active = { client: fakeClient(room, sentA) as unknown };
      const clientB = fakeClient(room, sentB);

      TestBed.configureTestingModule({
        providers: [
          TimelineService,
          TimelineActionsService,
          switchableMatrixProvider(active),
          mediaProvider(),
        ],
      });
      const timeline = TestBed.inject(TimelineService);
      timeline.open('!r:hs');
      TestBed.inject(ConversationActionContextService).bind(() =>
        timeline.openContext(),
      );
      const svc = TestBed.inject(TimelineActionsService);

      const send$ = svc.sendMedia(gif(), ''); // built while A is active…
      active.client = clientB; // …account switched before anyone subscribes
      await firstValueFrom(send$);

      expect(sentA).toHaveLength(1);
      expect(sentB).toHaveLength(0);
    });

    it('is inert when the room closed before subscribe', async () => {
      // The same coldness contract for the room half of the context: a send built
      // against a room the user has since navigated away from must not fire.
      const sent: unknown[][] = [];
      const svc = setupActions([], sent);

      const send$ = svc.sendMedia(gif(), '');
      TestBed.inject(TimelineService).close();
      await firstValueFrom(send$);

      expect(sent).toHaveLength(0);
    });
  });
});
