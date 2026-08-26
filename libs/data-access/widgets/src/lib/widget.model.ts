/** One active `im.vector.modular.widgets` declaration, with SDK details removed. */
export interface RoomWidget {
  /** The state key, and therefore the widget's room-local identifier. */
  readonly id: string;
  /** Human-facing name, with a deterministic fallback for unnamed widgets. */
  readonly name: string;
  /** Widget type declared by the room state. */
  readonly type: string;
  /** The unexpanded template exactly as the room declared it. */
  readonly rawUrl: string;
  /** Room-declared values available to `$name` placeholders in {@link rawUrl}. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Account that created the declaration, when room state supplies one. */
  readonly creatorUserId: string | null;
  /** Whether the Widget API waits for the iframe load event before negotiation. */
  readonly waitForIframeLoad: boolean;
  /** The exact state-event revision projected for conflict-aware management. */
  readonly sourceEventId: string | null;
}

/** The two administrator-supplied values for a new generic room widget. */
export interface NewRoomWidget {
  readonly name: string;
  readonly rawUrl: string;
}

/** Values Trinity may put into a widget URL when the user explicitly opens it. */
export interface WidgetTemplateContext {
  readonly roomId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly clientId: string;
  readonly theme: string;
  readonly language: string;
  readonly deviceId: string;
  readonly baseUrl: string;
}

export type WidgetDisclosureKind =
  | 'room-id'
  | 'user-id'
  | 'display-name'
  | 'avatar-url'
  | 'widget-id'
  | 'client-id'
  | 'theme'
  | 'language'
  | 'device-id'
  | 'homeserver-url';

/** A non-empty client value that this widget's URL template asks to receive. */
export interface WidgetDisclosure {
  readonly kind: WidgetDisclosureKind;
  readonly label: string;
}

export type WidgetLaunchFailure = 'invalid-url' | 'unsupported-protocol';

/** The result of expanding and validating a widget's external destination. */
export interface WidgetLaunch {
  /** Final URL, or null when it must not be opened. */
  readonly url: string | null;
  /** Third-party origin the user will contact, when the URL is safe to open. */
  readonly origin: string | null;
  /** Matrix/client values that the raw template actually requests. */
  readonly disclosures: readonly WidgetDisclosure[];
  /** Whether transport to the otherwise-openable destination is unencrypted HTTP. */
  readonly insecure: boolean;
  readonly failure: WidgetLaunchFailure | null;
}

export type WidgetEmbedFailure =
  | 'invalid-url'
  | 'insecure'
  | 'same-origin'
  | 'missing-creator'
  | 'call-widget';

/** A destination that is eligible for Trinity's restricted Widget API runtime. */
export interface WidgetEmbed {
  readonly url: string | null;
  readonly origin: string | null;
  readonly failure: WidgetEmbedFailure | null;
}
