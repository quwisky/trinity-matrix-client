import type { Observable } from 'rxjs';

export const PREFERENCE_STARTUP_PRODUCERS = [
  'appearance',
  'shell-layout',
  'feature-flags',
  'privacy',
  'system-lines',
  'composer',
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
  readonly consequence: PreferenceFallbackConsequenceKey;
}

export type PreferenceSafeDefaultKey =
  | 'appearance-declared-defaults'
  | 'shell-layout-standard-widths'
  | 'feature-flags-shipping-defaults'
  | 'privacy-declared-defaults'
  | 'system-lines-visible'
  | 'composer-toolbar-visible'
  | 'message-swipe-off'
  | 'date-time-system-format'
  | 'shortcuts-built-in-bindings'
  | 'gifs-klipy-unconfigured'
  | 'account-scope-active-only'
  | 'push-gateway-build-default';

export type PreferenceFallbackConsequenceKey =
  | 'appearance-fallback'
  | 'shell-layout-fallback'
  | 'feature-flags-fallback'
  | 'privacy-fallback'
  | 'system-lines-fallback'
  | 'composer-fallback'
  | 'gestures-fallback'
  | 'date-time-fallback'
  | 'shortcuts-fallback'
  | 'gifs-fallback'
  | 'account-scope-fallback'
  | 'push-gateway-fallback';

function policy(
  producer: PreferenceStartupProducer,
  safeDefault: PreferenceSafeDefaultKey,
  consequence: PreferenceFallbackConsequenceKey,
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
    consequence,
  };
}

/** Exhaustive identity, scope, storage and deadline ledger for preference preparation. */
export const PREFERENCE_STARTUP_PRODUCER_POLICIES = {
  appearance: policy(
    'appearance',
    'appearance-declared-defaults',
    'appearance-fallback',
  ),
  'shell-layout': policy(
    'shell-layout',
    'shell-layout-standard-widths',
    'shell-layout-fallback',
  ),
  'feature-flags': policy(
    'feature-flags',
    'feature-flags-shipping-defaults',
    'feature-flags-fallback',
  ),
  privacy: policy('privacy', 'privacy-declared-defaults', 'privacy-fallback'),
  'system-lines': policy(
    'system-lines',
    'system-lines-visible',
    'system-lines-fallback',
  ),
  composer: policy('composer', 'composer-toolbar-visible', 'composer-fallback'),
  gestures: policy('gestures', 'message-swipe-off', 'gestures-fallback'),
  'date-time': policy(
    'date-time',
    'date-time-system-format',
    'date-time-fallback',
  ),
  shortcuts: policy(
    'shortcuts',
    'shortcuts-built-in-bindings',
    'shortcuts-fallback',
  ),
  gifs: policy('gifs', 'gifs-klipy-unconfigured', 'gifs-fallback'),
  'account-scope': policy(
    'account-scope',
    'account-scope-active-only',
    'account-scope-fallback',
  ),
  'push-gateway': policy(
    'push-gateway',
    'push-gateway-build-default',
    'push-gateway-fallback',
  ),
} satisfies Record<PreferenceStartupProducer, PreferenceStartupProducerPolicy>;

const FALLBACK_MESSAGES = {
  'appearance-fallback':
    'Appearance is using its built-in theme, size, and density defaults.',
  'shell-layout-fallback': 'Panels are using their standard widths.',
  'feature-flags-fallback':
    'Experimental features use their shipping defaults.',
  'privacy-fallback': 'Privacy controls are using their declared defaults.',
  'system-lines-fallback': 'Timeline system lines are shown by default.',
  'composer-fallback': 'The composer uses its standard toolbar behavior.',
  'gestures-fallback': 'Message swipe actions are turned off.',
  'date-time-fallback': 'Dates and times use the system format.',
  'shortcuts-fallback': 'Keyboard shortcuts use their built-in bindings.',
  'gifs-fallback':
    'The GIF picker uses KLIPY; without a restored key it remains unavailable.',
  'account-scope-fallback': 'Only the active Account is shown.',
  'push-gateway-fallback':
    'Push uses the build configuration or remains disabled.',
} satisfies Record<PreferenceFallbackConsequenceKey, string>;

/** Value-free presentation selected by the stable hydration operation identity. */
export function preferenceFallbackMessage(operation: string): string | null {
  const policy = Object.values(PREFERENCE_STARTUP_PRODUCER_POLICIES).find(
    (candidate) => candidate.operation === operation,
  );
  return policy ? FALLBACK_MESSAGES[policy.consequence] : null;
}
