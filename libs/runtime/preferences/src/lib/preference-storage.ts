import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  PreferenceContext,
  PreferenceSensitivity,
  PreferenceSourceDiagnostic,
  PreferenceStoragePolicy,
} from './preference.models';

export interface PreferenceStorageRequest {
  readonly key: string;
  readonly context: PreferenceContext;
  readonly sensitivity: PreferenceSensitivity;
  readonly storage: PreferenceStoragePolicy;
}

export type PreferenceStorageReadOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly payload: string }
  | {
      readonly kind: 'unavailable';
      readonly diagnostic: PreferenceSourceDiagnostic;
    };

export type PreferenceStorageWriteOutcome =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'unavailable' | 'rejected';
      readonly diagnostic: PreferenceSourceDiagnostic;
    };

/** A removal target: one context, or every conversation context of one account. */
export interface PreferenceStorageRemoveRequest extends Omit<
  PreferenceStorageRequest,
  'context'
> {
  readonly context:
    | PreferenceContext
    | { readonly kind: 'every-conversation'; readonly accountId: string };
}

export interface PreferenceStorageAdapter {
  read(
    request: PreferenceStorageRequest,
  ): Observable<PreferenceStorageReadOutcome>;
  write(
    request: PreferenceStorageRequest & { readonly payload: string },
  ): Observable<PreferenceStorageWriteOutcome>;
  /** Optional: an adapter without it cannot forget a deleted account's values. */
  remove?(
    request: PreferenceStorageRemoveRequest,
  ): Observable<PreferenceStorageWriteOutcome>;
}

export const PREFERENCE_STORAGE_ADAPTER =
  new InjectionToken<PreferenceStorageAdapter>('PREFERENCE_STORAGE_ADAPTER');
