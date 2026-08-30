import {
  Injectable,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceContext,
  type PreferenceStorageAdapter,
  type PreferenceStorageRequest,
} from '@trinity/runtime/preferences';
import { catchError, defer, from, map, of } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class CapacitorPreferenceStorageAdapter implements PreferenceStorageAdapter {
  read(request: PreferenceStorageRequest) {
    return defer(() => {
      const unavailable = unavailableReason(request);
      if (unavailable) return of(unavailable);
      return from(Preferences.get({ key: scopedKey(request) })).pipe(
        map(({ value }) =>
          value === null
            ? ({ kind: 'missing' } as const)
            : ({ kind: 'found', payload: value } as const),
        ),
        catchError(() =>
          of({
            kind: 'unavailable',
            diagnostic: { code: 'device-preferences-read-failed' },
          } as const),
        ),
      );
    });
  }

  write(request: PreferenceStorageRequest & { readonly payload: string }) {
    return defer(() => {
      const unavailable = unavailableReason(request);
      if (unavailable) return of(unavailable);
      return from(
        Preferences.set({ key: scopedKey(request), value: request.payload }),
      ).pipe(
        map(() => ({ kind: 'completed' }) as const),
        catchError(() =>
          of({
            kind: 'unavailable',
            diagnostic: { code: 'device-preferences-write-failed' },
          } as const),
        ),
      );
    });
  }
}

export function provideCapacitorPreferenceStorage(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: PREFERENCE_STORAGE_ADAPTER,
      useExisting: CapacitorPreferenceStorageAdapter,
    },
  ]);
}

function unavailableReason(request: PreferenceStorageRequest) {
  if (request.sensitivity === 'secret') {
    return {
      kind: 'unavailable',
      diagnostic: { code: 'secret-preference-requires-secure-store' },
    } as const;
  }
  if (request.storage !== 'device-preferences') {
    return {
      kind: 'unavailable',
      diagnostic: { code: 'preference-storage-policy-unavailable' },
    } as const;
  }
  if (request.context.kind === 'server-authoritative') {
    return {
      kind: 'unavailable',
      diagnostic: { code: 'server-preference-requires-matrix-adapter' },
    } as const;
  }
  return null;
}

function scopedKey(request: PreferenceStorageRequest): string {
  return `${request.key}${scopeSuffix(request.context)}`;
}

function scopeSuffix(context: PreferenceContext): string {
  switch (context.kind) {
    case 'installation':
      return '';
    case 'account':
      return `.account.${encodeURIComponent(context.accountId)}`;
    case 'conversation':
      return `.conversation.${encodeURIComponent(context.accountId)}.${encodeURIComponent(context.conversationId)}`;
    case 'server-authoritative':
      return '';
  }
}
