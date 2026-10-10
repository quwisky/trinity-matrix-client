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
});
