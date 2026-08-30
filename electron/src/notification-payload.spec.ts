import { describe, expect, it } from 'vitest';
import {
  coerceNotificationPayload,
  NOTIFICATION_BODY_LIMIT,
  NOTIFICATION_TITLE_LIMIT,
} from './notification-payload';

describe('coerceNotificationPayload', () => {
  it('passes a well-formed payload through', () => {
    expect(
      coerceNotificationPayload({
        destination: {
          accountId: '@me:server',
          roomId: '!room:server',
          eventId: '$event',
        },
        title: 'Alice',
        body: 'hello there',
        silent: true,
        tag: 'msg-123',
      }),
    ).toEqual({
      destination: {
        accountId: '@me:server',
        roomId: '!room:server',
        eventId: '$event',
      },
      title: 'Alice',
      body: 'hello there',
      silent: true,
      tag: 'msg-123',
    });
  });

  it('returns null for a non-object or null payload', () => {
    expect(coerceNotificationPayload(null)).toBeNull();
    expect(coerceNotificationPayload(undefined)).toBeNull();
    expect(coerceNotificationPayload('not-an-object')).toBeNull();
    expect(coerceNotificationPayload(42)).toBeNull();
  });

  it('returns null when the typed destination is incomplete', () => {
    expect(coerceNotificationPayload({ title: 'hi', body: 'yo' })).toBeNull();
    expect(
      coerceNotificationPayload({
        destination: {
          accountId: '@me:server',
          roomId: '!room:server',
          eventId: '',
        },
        title: 'hi',
      }),
    ).toBeNull();
  });

  it('returns null when both title and body are absent/empty', () => {
    expect(coerceNotificationPayload({ destination: target })).toBeNull();
  });

  it("defaults title and body to '' when absent (given the other is present)", () => {
    expect(
      coerceNotificationPayload({ destination: target, body: 'body only' }),
    ).toMatchObject({ title: '', body: 'body only' });
    expect(
      coerceNotificationPayload({ destination: target, title: 'title only' }),
    ).toMatchObject({ title: 'title only', body: '' });
  });

  it('clamps an over-long title and body to the existing limits', () => {
    const result = coerceNotificationPayload({
      destination: target,
      title: 'a'.repeat(NOTIFICATION_TITLE_LIMIT + 50),
      body: 'b'.repeat(NOTIFICATION_BODY_LIMIT + 50),
    });
    expect(result?.title).toHaveLength(NOTIFICATION_TITLE_LIMIT);
    expect(result?.body).toHaveLength(NOTIFICATION_BODY_LIMIT);
  });

  it('passes tag through when it is a string and omits it otherwise', () => {
    expect(
      coerceNotificationPayload({
        destination: target,
        title: 'hi',
        tag: 'collapse-key',
      })?.tag,
    ).toBe('collapse-key');
    expect(
      coerceNotificationPayload({ destination: target, title: 'hi' }),
    ).not.toHaveProperty('tag');
    expect(
      coerceNotificationPayload({ destination: target, title: 'hi', tag: 42 }),
    ).not.toHaveProperty('tag');
  });

  it('treats silent as false unless it is strictly true', () => {
    expect(
      coerceNotificationPayload({ destination: target, title: 'hi' })?.silent,
    ).toBe(false);
    expect(
      coerceNotificationPayload({
        destination: target,
        title: 'hi',
        silent: 'true',
      })?.silent,
    ).toBe(false);
    expect(
      coerceNotificationPayload({
        destination: target,
        title: 'hi',
        silent: true,
      })?.silent,
    ).toBe(true);
  });
});

const target = {
  accountId: '@me:server',
  roomId: '!r:s',
  eventId: '$event',
} as const;
