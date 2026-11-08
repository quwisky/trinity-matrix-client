import {
  inject,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { RoomActionPermissionsService } from '@trinity/data-access/room-administration';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  type RoomLibraryGovernancePolicy,
} from '@trinity/data-access/room-library';
import { CONVERSATION_PRIVACY_PREFERENCES } from '@trinity/data-access/timeline';
import { providePrivacyPreferenceSet } from '@trinity/platform-native';

/** What every feature-rooms spec's TestBed starts with (`test-setup.ts` adds it before each test). */
export function featureRoomsTestProviders(): (
  Provider | EnvironmentProviders
)[] {
  return [
    provideTrnIcons(),
    providePrivacyPreferenceSet(CONVERSATION_PRIVACY_PREFERENCES),
    {
      provide: ROOM_LIBRARY_GOVERNANCE_POLICY,
      useFactory: (): RoomLibraryGovernancePolicy => {
        const permissions = inject(RoomActionPermissionsService);
        return {
          authorize: (key, action) => {
            const availability =
              action === 'invite'
                ? permissions.roomFor(key).invite
                : permissions.roomFor(key).curateSpace;
            return availability.available
              ? { kind: 'allowed' }
              : {
                  kind: 'rejected',
                  reason:
                    availability.reason ?? 'This room action is unavailable.',
                };
          },
        };
      },
    },
  ];
}
