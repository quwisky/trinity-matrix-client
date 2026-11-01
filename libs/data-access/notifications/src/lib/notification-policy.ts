import { Injectable } from '@angular/core';
import type {
  NotificationIntent,
  NotificationPolicyDecision,
  NotificationPolicyInput,
} from './notification-intent';

export const PREVIEW_LIMIT = 140;
export const GENERIC_BODY = 'New message';

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
    // Push delivers messages only; reactions have no push source and always present.
    if (
      visibility.hidden &&
      input.backgroundDelivery === 'push' &&
      event.kind !== 'reaction'
    ) {
      return { kind: 'suppress', reason: 'push-owns-background' };
    }
    if (!rules.notify) {
      return { kind: 'suppress', reason: 'rules' };
    }
    if (input.duplicate) {
      return { kind: 'suppress', reason: 'duplicate' };
    }

    const reaction = event.kind === 'reaction';
    const id = `${event.accountId} ${reaction ? 'reaction ' : ''}${event.eventId}`;
    const tag = `${event.accountId} ${event.roomId}${reaction ? ` reaction ${event.eventId}` : ''}`;
    const destination = Object.freeze({
      accountId: event.accountId,
      roomId: event.roomId,
      eventId: event.eventId,
    });
    const textMode = input.textMode ?? 'show';
    if (textMode === 'always-hide') {
      // Built before anything reads the event's text, sender or room; the tag and destination
      // are identifiers that are never shown.
      return {
        kind: 'present',
        intent: Object.freeze({
          id,
          // Twin of DEFAULT_APP_NAME (runtime/host); the policy stays free of the host.
          title: input.appName || 'Trinity',
          body: GENERIC_BODY,
          tag,
          silent: rules.silent,
          privacy: 'generic',
          destination,
        }),
      };
    }

    const body = event.body?.trim();
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
      id,
      title: event.roomName ? `${heading} · ${event.roomName}` : heading,
      body: reaction
        ? body
          ? `Your message: ${body.slice(0, PREVIEW_LIMIT)}`
          : 'Your message'
        : body
          ? body.slice(0, PREVIEW_LIMIT)
          : GENERIC_BODY,
      tag,
      silent: rules.silent,
      ...(textMode === 'hide-on-lock-screen'
        ? { privacy: 'lock-screen' as const }
        : {}),
      destination,
    });
    return { kind: 'present', intent };
  }
}
