import { describe, expect, it } from 'vitest';
import type { NotificationPolicyInput } from './notification-intent';
import { NotificationPolicy } from './notification-policy';

const base = (): NotificationPolicyInput => ({
  event: {
    accountId: '@alice:example.org',
    roomId: '!room:example.org',
    eventId: '$event',
    senderId: '@bob:example.org',
    senderName: 'Bob',
    roomName: 'General',
    body: 'Hello',
    kind: 'message',
  },
  viewerId: '@alice:example.org',
  rules: { notify: true, silent: false },
  visibility: { foreground: false, hidden: false, conversation: null },
  duplicate: false,
  backgroundDelivery: 'app',
});

describe('NotificationPolicy', () => {
  const policy = new NotificationPolicy();

  it('produces an immutable typed intent from normalized input', () => {
    const decision = policy.decide(base());

    expect(decision).toEqual({
      kind: 'present',
      intent: {
        id: '@alice:example.org $event',
        title: 'Bob · General',
        body: 'Hello',
        tag: '@alice:example.org !room:example.org',
        silent: false,
        destination: {
          accountId: '@alice:example.org',
          roomId: '!room:example.org',
          eventId: '$event',
        },
      },
    });
    expect(
      decision.kind === 'present' && Object.isFrozen(decision.intent),
    ).toBe(true);
  });

  it.each([
    [
      'push-owns-background',
      {
        backgroundDelivery: 'push',
        visibility: { foreground: false, hidden: true, conversation: null },
      },
    ],
    ['rules', { rules: { notify: false, silent: false } }],
    ['duplicate', { duplicate: true }],
    [
      'visible-conversation',
      {
        visibility: {
          foreground: true,
          hidden: false,
          conversation: {
            accountId: '@alice:example.org',
            roomId: '!room:example.org',
          },
        },
      },
    ],
  ] as const)('suppresses %s input', (reason, overrides) => {
    expect(policy.decide({ ...base(), ...overrides })).toEqual({
      kind: 'suppress',
      reason,
    });
  });

  it('presents while visible even when native push owns the background', () => {
    for (const foreground of [true, false]) {
      const decision = policy.decide({
        ...base(),
        backgroundDelivery: 'push',
        visibility: { foreground, hidden: false, conversation: null },
      });

      expect(decision.kind).toBe('present');
    }
  });

  it('presents while hidden when push does not own the background', () => {
    const decision = policy.decide({
      ...base(),
      backgroundDelivery: 'app',
      visibility: { foreground: false, hidden: true, conversation: null },
    });

    expect(decision.kind).toBe('present');
  });

  it('still presents reactions while hidden and push owns the background', () => {
    const input = base();
    const decision = policy.decide({
      ...input,
      event: {
        ...input.event,
        kind: 'reaction',
        senderCount: 1,
        reactionKeys: ['👍'],
      },
      backgroundDelivery: 'push',
      visibility: { foreground: false, hidden: true, conversation: null },
    });

    expect(decision.kind).toBe('present');
  });

  it('keeps unsupported events safe with the existing generic preview', () => {
    const input = base();
    const decision = policy.decide({
      ...input,
      event: { ...input.event, kind: 'unsupported', body: null },
    });

    expect(decision).toMatchObject({
      kind: 'present',
      intent: { body: 'New message' },
    });
  });

  it('presents a grouped reaction with a target-specific tag and message destination', () => {
    const input = base();
    const decision = policy.decide({
      ...input,
      event: {
        ...input.event,
        kind: 'reaction',
        senderCount: 5,
        reactionKeys: ['👍'],
      },
    });
    expect(decision).toMatchObject({
      kind: 'present',
      intent: {
        title: 'Bob and 4 others reacted 👍 · General',
        body: 'Your message: Hello',
        tag: '@alice:example.org !room:example.org reaction $event',
        destination: {
          accountId: '@alice:example.org',
          roomId: '!room:example.org',
          eventId: '$event',
        },
      },
    });
  });

  describe('notification text (App lock)', () => {
    const reactionOf = (input: NotificationPolicyInput) =>
      ({
        ...input.event,
        kind: 'reaction',
        senderCount: 2,
        reactionKeys: ['👍'],
      }) as NotificationPolicyInput['event'];

    it('shows only “New message” under Always hide, for messages and reactions alike', () => {
      const message = policy.decide({ ...base(), textMode: 'always-hide' });
      const reaction = policy.decide({
        ...base(),
        textMode: 'always-hide',
        event: reactionOf(base()),
      });
      for (const decision of [message, reaction]) {
        expect(decision).toMatchObject({
          kind: 'present',
          intent: { title: 'Trinity', body: 'New message', privacy: 'generic' },
        });
        const text = JSON.stringify(decision);
        expect(text.includes('Bob')).toBe(false);
        expect(text.includes('General')).toBe(false);
        expect(text.includes('Hello')).toBe(false);
        expect(text.includes('👍')).toBe(false);
      }
    });

    it('names the running app under Always hide', () => {
      expect(
        policy.decide({
          ...base(),
          textMode: 'always-hide',
          appName: 'Trinity Next',
        }),
      ).toMatchObject({
        intent: { title: 'Trinity Next', body: 'New message' },
      });
    });

    it('keeps the grouping tag, the destination and the sound choice under Always hide', () => {
      expect(
        policy.decide({
          ...base(),
          textMode: 'always-hide',
          rules: { notify: true, silent: true },
        }),
      ).toEqual({
        kind: 'present',
        intent: {
          id: '@alice:example.org $event',
          title: 'Trinity',
          body: 'New message',
          tag: '@alice:example.org !room:example.org',
          silent: true,
          privacy: 'generic',
          destination: {
            accountId: '@alice:example.org',
            roomId: '!room:example.org',
            eventId: '$event',
          },
        },
      });
      expect(
        policy.decide({
          ...base(),
          textMode: 'always-hide',
          event: reactionOf(base()),
        }),
      ).toMatchObject({
        intent: {
          id: '@alice:example.org reaction $event',
          tag: '@alice:example.org !room:example.org reaction $event',
        },
      });
    });

    it('still suppresses what it would suppress under Always hide', () => {
      expect(
        policy.decide({
          ...base(),
          textMode: 'always-hide',
          rules: { notify: false, silent: false },
        }),
      ).toEqual({ kind: 'suppress', reason: 'rules' });
    });

    it('marks the intent for the lock screen under Hide on the lock screen', () => {
      expect(
        policy.decide({ ...base(), textMode: 'hide-on-lock-screen' }),
      ).toMatchObject({
        intent: {
          title: 'Bob · General',
          body: 'Hello',
          privacy: 'lock-screen',
        },
      });
    });

    it('adds nothing under Show', () => {
      expect(policy.decide({ ...base(), textMode: 'show' })).toEqual(
        policy.decide(base()),
      );
    });
  });
});
