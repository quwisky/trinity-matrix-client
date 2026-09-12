import { Injectable } from '@angular/core';
import type {
  NotificationIntent,
  NotificationPolicyDecision,
  NotificationPolicyInput,
} from './notification-intent';

const PREVIEW_LIMIT = 140;

/** Pure notification policy: no Router, SDK, DOM, or host dependency. */
@Injectable({ providedIn: 'root' })
export class NotificationPolicy {
  decide(input: NotificationPolicyInput): NotificationPolicyDecision {
    const { event, rules, visibility } = input;
    if (!event.accountId || !event.roomId || !event.eventId) {
      return { kind: 'suppress', reason: 'missing-destination' };
    }
    if (event.senderId === input.viewerId) {
      return { kind: 'suppress', reason: 'own-event' };
    }
    if (
      visibility.foreground &&
      visibility.conversation?.accountId === event.accountId &&
      visibility.conversation.roomId === event.roomId
    ) {
      return { kind: 'suppress', reason: 'visible-conversation' };
    }
    if (!rules.notify) {
      return { kind: 'suppress', reason: 'rules' };
    }
    if (input.duplicate) {
      return { kind: 'suppress', reason: 'duplicate' };
    }

    const body = event.body?.trim();
    const reaction = event.kind === 'reaction';
    let heading = event.senderName;
    if (reaction) {
      const others = event.senderCount - 1;
      const people =
        others > 0
          ? `${heading} and ${others} ${others === 1 ? 'other' : 'others'}`
          : heading;
      const keys = event.reactionKeys
        .slice(0, 3)
        .map((key) => key.slice(0, 32))
        .join(' ');
      heading = `${people} reacted ${keys}${event.reactionKeys.length > 3 ? ' …' : ''}`;
    }
    const intent: NotificationIntent = Object.freeze({
      id: `${event.accountId} ${reaction ? 'reaction ' : ''}${event.eventId}`,
      title: event.roomName ? `${heading} · ${event.roomName}` : heading,
      body: reaction
        ? body
          ? `Your message: ${body.slice(0, PREVIEW_LIMIT)}`
          : 'Your message'
        : body
          ? body.slice(0, PREVIEW_LIMIT)
          : 'New message',
      tag: `${event.accountId} ${event.roomId}${reaction ? ` reaction ${event.eventId}` : ''}`,
      silent: rules.silent,
      destination: Object.freeze({
        accountId: event.accountId,
        roomId: event.roomId,
        eventId: event.eventId,
      }),
    });
    return { kind: 'present', intent };
  }
}
