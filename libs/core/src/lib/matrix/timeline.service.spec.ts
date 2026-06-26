import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TimelineService } from './timeline.service';
import { MatrixClientService } from './matrix-client.service';

function fakeEvent(o: {
  id: string;
  sender: string;
  type?: string;
  body?: string;
  msgtype?: string;
  ts?: number;
  redacted?: boolean;
  decryptFail?: boolean;
}) {
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    getRoomId: () => '!r:hs',
    getType: () => o.type ?? 'm.room.message',
    getTs: () => o.ts ?? 0,
    getContent: () => ({ body: o.body ?? '', msgtype: o.msgtype ?? 'm.text' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
  };
}

function setup(events: ReturnType<typeof fakeEvent>[]) {
  const room = {
    getLiveTimeline: () => ({
      getEvents: () => events,
      getPaginationToken: () => null,
    }),
    getMember: (id: string) => ({
      name: id === '@me:hs' ? 'Me' : 'Alice',
      getAvatarUrl: () => null,
    }),
    on: () => {},
    off: () => {},
  };
  const client = {
    baseUrl: 'https://hs',
    getRoom: () => room,
    getUserId: () => '@me:hs',
    on: () => {},
    off: () => {},
    sendReadReceipt: () => Promise.resolve({}),
    scrollback: () => Promise.resolve(room),
  };
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      TimelineService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open('!r:hs');
  return svc;
}

describe('TimelineService', () => {
  it('maps message events to views and drops non-messages', () => {
    const svc = setup([
      fakeEvent({ id: '$1', sender: '@alice:hs', body: 'hi' }),
      fakeEvent({ id: '$m', sender: '@alice:hs', type: 'm.room.member' }),
      fakeEvent({ id: '$2', sender: '@me:hs', body: 'yo' }),
    ]);

    const msgs = svc.messages();
    expect(msgs.map((m) => m.id)).toEqual(['$1', '$2']);
    expect(msgs[0]).toMatchObject({
      senderName: 'Alice',
      body: 'hi',
      isOwn: false,
      kind: 'text',
    });
    expect(msgs[1].isOwn).toBe(true);
  });

  it('flags redacted and decryption-failed messages', () => {
    const svc = setup([
      fakeEvent({ id: '$r', sender: '@a:hs', redacted: true }),
      fakeEvent({ id: '$e', sender: '@a:hs', decryptFail: true }),
    ]);

    const [redacted, failed] = svc.messages();
    expect(redacted.kind).toBe('redacted');
    expect(failed.decryptionFailed).toBe(true);
    expect(failed.body).toContain('Unable to decrypt');
  });
});
