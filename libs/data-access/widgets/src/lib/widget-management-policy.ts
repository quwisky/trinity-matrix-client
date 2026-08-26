import type { NewRoomWidget } from './widget.model';

export const CUSTOM_WIDGET_TYPE = 'm.custom';
export const WIDGET_NAME_MAX_CODE_POINTS = 128;
export const WIDGET_URL_MAX_BYTES = 4096;

export type WidgetDraftFailure =
  | 'name-required'
  | 'name-too-long'
  | 'url-required'
  | 'url-too-long'
  | 'invalid-url'
  | 'https-required'
  | 'credentials'
  | 'dynamic-origin';

export interface ValidRoomWidgetDraft {
  readonly name: string;
  readonly rawUrl: string;
  readonly origin: string;
}

export type WidgetDraftResult =
  | { readonly value: ValidRoomWidgetDraft; readonly failure: null }
  | { readonly value: null; readonly failure: WidgetDraftFailure };

/** Validate the declaration itself without expanding identity-bearing URL variables. */
export function validateRoomWidgetDraft(
  draft: NewRoomWidget,
): WidgetDraftResult {
  const name = draft.name.trim();
  if (!name) {
    return blocked('name-required');
  }
  if ([...name].length > WIDGET_NAME_MAX_CODE_POINTS) {
    return blocked('name-too-long');
  }

  const rawUrl = draft.rawUrl.trim();
  if (!rawUrl) {
    return blocked('url-required');
  }
  if (new TextEncoder().encode(rawUrl).length > WIDGET_URL_MAX_BYTES) {
    return blocked('url-too-long');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return blocked('invalid-url');
  }
  if (parsed.protocol !== 'https:') {
    return blocked('https-required');
  }
  if (parsed.username || parsed.password) {
    return blocked('credentials');
  }
  // Path/query/hash variables are resolved at launch. The origin must be known now so a
  // declaration cannot turn identity substitution into a destination-origin substitution.
  if (parsed.origin.includes('$')) {
    return blocked('dynamic-origin');
  }
  return {
    value: { name, rawUrl, origin: parsed.origin },
    failure: null,
  };
}

function blocked(failure: WidgetDraftFailure): WidgetDraftResult {
  return { value: null, failure };
}
