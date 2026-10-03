import type { Observable } from 'rxjs';

export const PREFERENCE_STARTUP_PRODUCERS = [
  'appearance',
  'shell-layout',
  'feature-flags',
  'privacy',
  'system-lines',
  'gestures',
  'date-time',
  'shortcuts',
  'gifs',
  'account-scope',
  'push-gateway',
] as const;

export type PreferenceStartupProducer =
  (typeof PREFERENCE_STARTUP_PRODUCERS)[number];

export type PreferencePreparationEvidence =
  | { readonly kind: 'ready' }
  | { readonly kind: 'not-applicable'; readonly code: string }
  | {
      readonly kind: 'defaulted' | 'blocked';
      readonly code: string;
      readonly recover?: () => Observable<PreferencePreparationEvidence>;
    };

export type PreferenceStartupSources = Record<
  PreferenceStartupProducer,
  () => Observable<PreferencePreparationEvidence>
>;

interface PreferenceStartupProducerPolicy {
  readonly operation: string;
  readonly context: 'installation';
  readonly storage: 'device-preferences';
  readonly budgetMs: number;
  readonly defaultCode: string;
  readonly invalidCode: string;
  readonly timeoutCode: string;
  readonly safeDefault: PreferenceSafeDefaultKey;
}

export type PreferenceSafeDefaultKey =
  | 'appearance-declared-defaults'
  | 'shell-layout-standard-widths'
  | 'feature-flags-shipping-defaults'
  | 'privacy-declared-defaults'
  | 'system-lines-visible'
  | 'message-swipe-off'
  | 'date-time-system-format'
  | 'shortcuts-built-in-bindings'
  | 'gifs-klipy-unconfigured'
  | 'account-scope-active-only'
  | 'push-gateway-build-default';

function policy(
  producer: PreferenceStartupProducer,
  safeDefault: PreferenceSafeDefaultKey,
): PreferenceStartupProducerPolicy {
  return {
    operation: `hydrate-${producer}`,
    context: 'installation',
    storage: 'device-preferences',
    budgetMs: 10_000,
    defaultCode: `${producer}-hydration-failed`,
    invalidCode: `${producer}-stored-value-invalid`,
    timeoutCode: `${producer}-hydration-timeout`,
    safeDefault,
  };
}

/** Exhaustive identity, scope, storage and deadline ledger for preference preparation. */
export const PREFERENCE_STARTUP_PRODUCER_POLICIES = {
  appearance: policy('appearance', 'appearance-declared-defaults'),
  'shell-layout': policy('shell-layout', 'shell-layout-standard-widths'),
  'feature-flags': policy('feature-flags', 'feature-flags-shipping-defaults'),
  privacy: policy('privacy', 'privacy-declared-defaults'),
  'system-lines': policy('system-lines', 'system-lines-visible'),
  gestures: policy('gestures', 'message-swipe-off'),
  'date-time': policy('date-time', 'date-time-system-format'),
  shortcuts: policy('shortcuts', 'shortcuts-built-in-bindings'),
  gifs: policy('gifs', 'gifs-klipy-unconfigured'),
  'account-scope': policy('account-scope', 'account-scope-active-only'),
  'push-gateway': policy('push-gateway', 'push-gateway-build-default'),
} satisfies Record<PreferenceStartupProducer, PreferenceStartupProducerPolicy>;
