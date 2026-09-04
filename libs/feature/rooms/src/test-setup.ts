import '../../../../test-setup.base';
import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { RoomActionPermissionsService } from '@trinity/data-access/room-administration';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  type RoomLibraryGovernancePolicy,
} from '@trinity/data-access/room-library';
import { CONVERSATION_PRIVACY_PREFERENCES } from '@trinity/data-access/timeline';
import { providePrivacyPreferenceSet } from '@trinity/platform-native';
import { beforeEach } from 'vitest';

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
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
    ],
  });
});

// jsdom has no ResizeObserver. This controllable stub lets the message-list tests
// drive the measurement path: it records the observed elements and its callback, and
// a static `instances` registry + `emit()` let a test deliver synthetic resize
// entries. (The virtualized list also feature-detects RO and degrades to render-all
// without one, so this needs to exist regardless.)
class TestResizeObserver {
  static readonly instances: TestResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  /** Test hook: deliver resize entries to this observer's callback. */
  emit(entries: ResizeObserverEntry[]): void {
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
globalThis.ResizeObserver =
  TestResizeObserver as unknown as typeof ResizeObserver;
