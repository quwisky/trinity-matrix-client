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
        roomId: '!room:server',
        title: 'Alice',
        body: 'hello there',
        silent: true,
        tag: 'msg-123',
      }),
    ).toEqual({
      roomId: '!room:server',
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

  it('returns null when roomId is missing or not a string', () => {
    expect(coerceNotificationPayload({ title: 'hi', body: 'yo' })).toBeNull();
    expect(coerceNotificationPayload({ roomId: 123, title: 'hi' })).toBeNull();
    expect(coerceNotificationPayload({ roomId: '', title: 'hi' })).toBeNull();
    // whitespace-only collapses to empty after trim => treated as missing
    expect(
      coerceNotificationPayload({ roomId: '   ', title: 'hi' }),
    ).toBeNull();
  });

  it('returns null when both title and body are absent/empty', () => {
    expect(coerceNotificationPayload({ roomId: '!r:s' })).toBeNull();
  });

  it("defaults title and body to '' when absent (given the other is present)", () => {
    expect(
      coerceNotificationPayload({ roomId: '!r:s', body: 'body only' }),
    ).toMatchObject({ title: '', body: 'body only' });
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'title only' }),
    ).toMatchObject({ title: 'title only', body: '' });
  });

  it('clamps an over-long title and body to the existing limits', () => {
    const result = coerceNotificationPayload({
      roomId: '!r:s',
      title: 'a'.repeat(NOTIFICATION_TITLE_LIMIT + 50),
      body: 'b'.repeat(NOTIFICATION_BODY_LIMIT + 50),
    });
    expect(result?.title).toHaveLength(NOTIFICATION_TITLE_LIMIT);
    expect(result?.body).toHaveLength(NOTIFICATION_BODY_LIMIT);
  });

  it('passes tag through when it is a string and omits it otherwise', () => {
    expect(
      coerceNotificationPayload({
        roomId: '!r:s',
        title: 'hi',
        tag: 'collapse-key',
      })?.tag,
    ).toBe('collapse-key');
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi' }),
    ).not.toHaveProperty('tag');
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi', tag: 42 }),
    ).not.toHaveProperty('tag');
  });

  it('passes userId through when it is a string and omits it otherwise', () => {
    expect(
      coerceNotificationPayload({
        roomId: '!r:s',
        title: 'hi',
        userId: '@bob:server',
      })?.userId,
    ).toBe('@bob:server');
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi' }),
    ).not.toHaveProperty('userId');
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi', userId: 42 }),
    ).not.toHaveProperty('userId');
  });

  it('treats silent as false unless it is strictly true', () => {
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi' })?.silent,
    ).toBe(false);
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi', silent: 'true' })
        ?.silent,
    ).toBe(false);
    expect(
      coerceNotificationPayload({ roomId: '!r:s', title: 'hi', silent: true })
        ?.silent,
    ).toBe(true);
  });
});
