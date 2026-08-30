/** A bounded, SDK-free event considered by notification delivery policy. */
export interface NotificationEvent {
  readonly accountId: string;
  readonly roomId: string;
  readonly eventId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly roomName: string | null;
  readonly body: string | null;
  readonly kind: 'message' | 'unsupported';
}

/** The exact semantic destination carried through presentation and activation. */
export interface NotificationDestination {
  readonly accountId: string;
  readonly roomId: string;
  readonly eventId: string;
}

/** A complete, platform-neutral request produced by Notifications policy. */
export interface NotificationIntent {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly silent: boolean;
  readonly destination: NotificationDestination;
}

export interface NotificationPolicyInput {
  readonly event: NotificationEvent;
  readonly viewerId: string;
  readonly rules: {
    readonly notify: boolean;
    readonly silent: boolean;
  };
  readonly visibility: {
    readonly foreground: boolean;
    readonly conversation: {
      readonly accountId: string;
      readonly roomId: string;
    } | null;
  };
  readonly duplicate: boolean;
}

export type NotificationPolicyDecision =
  | { readonly kind: 'present'; readonly intent: NotificationIntent }
  | {
      readonly kind: 'suppress';
      readonly reason:
        | 'own-event'
        | 'visible-conversation'
        | 'rules'
        | 'duplicate'
        | 'missing-destination';
    };
