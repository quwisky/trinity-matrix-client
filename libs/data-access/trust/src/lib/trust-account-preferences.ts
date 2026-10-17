import type {
  PreferenceDescriptor,
  PreferenceValue,
} from '@trinity/runtime/preferences';
import { DEVICE_CONFIRMATION_PREFERENCE } from './trust-device-confirmation.service';
import { SLOT_FORECAST_PREFERENCE } from './trust-slot-forecast';

/** Trust's account-scoped device preferences, which a deleted account forgets. */
export const TRUST_ACCOUNT_PREFERENCES: readonly PreferenceDescriptor<PreferenceValue>[] =
  [DEVICE_CONFIRMATION_PREFERENCE, SLOT_FORECAST_PREFERENCE];
