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
  readonly timeoutCode: string;
}

function policy(
  producer: PreferenceStartupProducer,
): PreferenceStartupProducerPolicy {
  return {
    operation: `hydrate-${producer}`,
    context: 'installation',
    storage: 'device-preferences',
    budgetMs: 10_000,
    defaultCode: `${producer}-hydration-failed`,
    timeoutCode: `${producer}-hydration-timeout`,
  };
}

/** Exhaustive identity, scope, storage and deadline ledger for preference preparation. */
export const PREFERENCE_STARTUP_PRODUCER_POLICIES = {
  appearance: policy('appearance'),
  'shell-layout': policy('shell-layout'),
  'feature-flags': policy('feature-flags'),
  privacy: policy('privacy'),
  'system-lines': policy('system-lines'),
  composer: policy('composer'),
  gestures: policy('gestures'),
  'date-time': policy('date-time'),
  shortcuts: policy('shortcuts'),
  gifs: policy('gifs'),
  'account-scope': policy('account-scope'),
  'push-gateway': policy('push-gateway'),
} satisfies Record<PreferenceStartupProducer, PreferenceStartupProducerPolicy>;
