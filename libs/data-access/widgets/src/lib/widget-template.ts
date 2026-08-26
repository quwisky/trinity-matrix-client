import type {
  RoomWidget,
  WidgetDisclosure,
  WidgetDisclosureKind,
  WidgetLaunch,
  WidgetTemplateContext,
} from './widget.model';

interface TemplateVariable {
  readonly value: unknown;
  readonly disclosure?: {
    readonly kind: WidgetDisclosureKind;
    readonly label: string;
  };
}

const DISCLOSURE_ORDER: readonly WidgetDisclosureKind[] = [
  'room-id',
  'user-id',
  'display-name',
  'avatar-url',
  'widget-id',
  'client-id',
  'theme',
  'language',
  'device-id',
  'homeserver-url',
];

/**
 * Expand a widget URL without loading `matrix-widget-api`'s iframe/postMessage runtime.
 *
 * The variable set follows that package's reference templating contract. Room-declared
 * `data` is applied first and the authoritative Matrix/client values overwrite it, so a
 * widget cannot make `$matrix_user_id` claim to be another account. Longest keys are
 * replaced first: otherwise a custom `$matrix` key corrupts `$matrix_user_id` before the
 * authoritative variable gets its turn.
 */
export function resolveWidgetLaunch(
  widget: RoomWidget,
  context: WidgetTemplateContext,
): WidgetLaunch {
  const variables = variablesFor(widget, context);
  let url = widget.rawUrl;
  const disclosures: WidgetDisclosure[] = [];

  for (const [key, variable] of Object.entries(variables).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    const placeholder = `$${key}`;
    if (!url.includes(placeholder)) {
      continue;
    }
    const rendered = renderTemplateValue(variable.value);
    url = url.replaceAll(placeholder, encodeURIComponent(rendered));
    if (variable.disclosure && rendered.length > 0) {
      disclosures.push(variable.disclosure);
    }
  }

  const parsed = parseUrl(url);
  if (!parsed) {
    return blocked(disclosures, 'invalid-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return blocked(disclosures, 'unsupported-protocol');
  }
  return {
    url,
    origin: parsed.origin,
    disclosures: dedupeDisclosures(disclosures),
    insecure: parsed.protocol === 'http:',
    failure: null,
  };
}

function variablesFor(
  widget: RoomWidget,
  context: WidgetTemplateContext,
): Record<string, TemplateVariable> {
  const data = Object.fromEntries(
    Object.entries(widget.data).map(([key, value]) => [key, { value }]),
  );
  return {
    ...data,
    matrix_room_id: disclosed(context.roomId, 'room-id', 'this room’s ID'),
    matrix_user_id: disclosed(context.userId, 'user-id', 'your Matrix user ID'),
    matrix_display_name: disclosed(
      context.displayName || context.userId,
      'display-name',
      'your display name',
    ),
    matrix_avatar_url: disclosed(
      context.avatarUrl,
      'avatar-url',
      'your avatar URL',
    ),
    matrix_widget_id: disclosed(widget.id, 'widget-id', 'this widget’s ID'),
    'org.matrix.msc2873.client_id': disclosed(
      context.clientId,
      'client-id',
      'that you use Trinity',
    ),
    'org.matrix.msc2873.client_theme': disclosed(
      context.theme,
      'theme',
      'your light or dark theme',
    ),
    'org.matrix.msc2873.client_language': disclosed(
      context.language,
      'language',
      'your browser language',
    ),
    'org.matrix.msc3819.matrix_device_id': disclosed(
      context.deviceId,
      'device-id',
      'your Matrix device ID',
    ),
    'org.matrix.msc4039.matrix_base_url': disclosed(
      context.baseUrl,
      'homeserver-url',
      'your homeserver URL',
    ),
  };
}

function disclosed(
  value: string,
  kind: WidgetDisclosureKind,
  label: string,
): TemplateVariable {
  return { value, disclosure: { kind, label } };
}

function renderTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return `${value}`;
  }
  return String(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function blocked(
  disclosures: readonly WidgetDisclosure[],
  failure: WidgetLaunch['failure'],
): WidgetLaunch {
  return {
    url: null,
    origin: null,
    disclosures: dedupeDisclosures(disclosures),
    insecure: false,
    failure,
  };
}

function dedupeDisclosures(
  disclosures: readonly WidgetDisclosure[],
): readonly WidgetDisclosure[] {
  const byKind = new Map(disclosures.map((item) => [item.kind, item]));
  return DISCLOSURE_ORDER.flatMap((kind) => {
    const disclosure = byKind.get(kind);
    return disclosure ? [disclosure] : [];
  });
}
