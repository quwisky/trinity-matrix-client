import {
  Injectable,
  InjectionToken,
  computed,
  inject,
  makeEnvironmentProviders,
} from '@angular/core';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  type PreferenceCommandOutcome,
  type PreferenceFailure,
  type PreferenceDescriptor,
  type PreferenceHydrationOutcome,
  type PreferenceValue,
} from '@trinity/runtime/preferences';
import type { Observable } from 'rxjs';

/** Temporary bridge while privacy consumers migrate to the Conversations preference API. */
export interface PrivacyPreferenceSet {
  readonly sendReadReceipts: PreferenceDescriptor<boolean>;
  readonly linkPreviews: PreferenceDescriptor<boolean>;
  readonly linkPreviewsInEncrypted: PreferenceDescriptor<boolean>;
}

const PRIVACY_PREFERENCE_SET = new InjectionToken<PrivacyPreferenceSet>(
  'PRIVACY_PREFERENCE_SET',
);

export function providePrivacyPreferenceSet(set: PrivacyPreferenceSet) {
  return makeEnvironmentProviders([
    { provide: PRIVACY_PREFERENCE_SET, useValue: set },
  ]);
}

@Injectable({ providedIn: 'root' })
export class PrivacySettingsService {
  private readonly preferences = inject(PreferenceStoreService);
  private readonly descriptors = inject(PRIVACY_PREFERENCE_SET);

  readonly sendReadReceipts = this.booleanValue(
    this.descriptors.sendReadReceipts,
  );
  readonly linkPreviews = this.booleanValue(this.descriptors.linkPreviews);
  readonly linkPreviewsInEncrypted = this.booleanValue(
    this.descriptors.linkPreviewsInEncrypted,
  );

  init(): Observable<PreferenceHydrationOutcome> {
    return this.preferences.hydrateDescriptors(
      INSTALLATION_PREFERENCE_CONTEXT,
      Object.values(this.descriptors),
    );
  }

  recoverHydration(
    failures: readonly PreferenceFailure[],
  ): Observable<PreferenceHydrationOutcome> {
    return this.preferences.recoverHydration(
      INSTALLATION_PREFERENCE_CONTEXT,
      failures,
    );
  }

  setSendReadReceipts(on: boolean): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      this.descriptors.sendReadReceipts,
      INSTALLATION_PREFERENCE_CONTEXT,
      on,
    );
  }

  setLinkPreviews(on: boolean): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      this.descriptors.linkPreviews,
      INSTALLATION_PREFERENCE_CONTEXT,
      on,
    );
  }

  setLinkPreviewsInEncrypted(
    on: boolean,
  ): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      this.descriptors.linkPreviewsInEncrypted,
      INSTALLATION_PREFERENCE_CONTEXT,
      on,
    );
  }

  resetSendReadReceipts(): Observable<PreferenceCommandOutcome> {
    return this.setSendReadReceipts(
      this.descriptors.sendReadReceipts.defaultValue,
    );
  }

  resetLinkPreviews(): Observable<PreferenceCommandOutcome> {
    return this.setLinkPreviews(this.descriptors.linkPreviews.defaultValue);
  }

  resetLinkPreviewsInEncrypted(): Observable<PreferenceCommandOutcome> {
    return this.setLinkPreviewsInEncrypted(
      this.descriptors.linkPreviewsInEncrypted.defaultValue,
    );
  }

  private booleanValue(descriptor: PreferenceDescriptor<boolean>) {
    const value = this.preferences.valueFor(
      descriptor,
      INSTALLATION_PREFERENCE_CONTEXT,
    );
    return computed(() => toBoolean(value(), descriptor.defaultValue));
  }
}

function toBoolean(value: PreferenceValue, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
