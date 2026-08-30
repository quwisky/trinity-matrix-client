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
    const intent: NotificationIntent = Object.freeze({
      id: `${event.accountId} ${event.eventId}`,
      title: event.roomName
        ? `${event.senderName} · ${event.roomName}`
        : event.senderName,
      body: body ? body.slice(0, PREVIEW_LIMIT) : 'New message',
      tag: `${event.accountId} ${event.roomId}`,
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
