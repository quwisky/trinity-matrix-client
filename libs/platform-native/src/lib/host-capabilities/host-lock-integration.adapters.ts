import { Injectable, Provider, inject } from '@angular/core';
import {
  HOST_LOCK_INTEGRATION_OPERATION,
  HostCapabilitiesService,
  type HostLockIntegrationOperation,
  type HostLockRequest,
  type HostLockState,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { EMPTY, Observable, defer, map, share, switchMap, take } from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';

const NOT_SUPPORTED: HostOperationOutcome = {
  kind: 'unavailable',
  reason: 'not-supported',
};

type LockBridge = NonNullable<
  NonNullable<
    ReturnType<typeof getTrinityDesktopBridge>
  >['capabilities']['lockIntegration']
>;

/** Electron's part of App lock: menu item, OS lock and sleep, and the show hold. */
@Injectable({ providedIn: 'root' })
export class ElectronLockIntegrationAdapter implements HostLockIntegrationOperation {
  private readonly capabilities = inject(HostCapabilitiesService);

  private readonly granted: Observable<boolean> = defer(() =>
    this.capabilities.manifest(),
  ).pipe(
    take(1),
    map(
      (manifest) =>
        manifest.operations['lock-integration'].kind === 'supported',
    ),
  );

  readonly requests: Observable<HostLockRequest> = this.granted.pipe(
    switchMap((granted) => {
      const bridge = getTrinityDesktopBridge()?.capabilities.lockIntegration;
      return granted && bridge
        ? new Observable<HostLockRequest>((subscriber) =>
            bridge.subscribeRequests((request) => subscriber.next(request)),
          )
        : EMPTY;
    }),
    share(),
  );

  setState(state: HostLockState): Observable<HostOperationOutcome> {
    return this.send((bridge) => bridge.setState({ ...state }));
  }

  coverPainted(): Observable<HostOperationOutcome> {
    return this.send((bridge) => bridge.coverPainted());
  }

  private send(
    command: (bridge: LockBridge) => void,
  ): Observable<HostOperationOutcome> {
    return this.granted.pipe(
      map((granted): HostOperationOutcome => {
        const bridge = getTrinityDesktopBridge()?.capabilities.lockIntegration;
        if (!granted || !bridge) return NOT_SUPPORTED;
        command(bridge);
        return { kind: 'completed' };
      }),
    );
  }
}

/** Only Electron has lock integration; other hosts provide null. */
export function lockIntegrationProvider(): Provider {
  return {
    provide: HOST_LOCK_INTEGRATION_OPERATION,
    useFactory: (): HostLockIntegrationOperation | null =>
      getTrinityDesktopBridge() ? inject(ElectronLockIntegrationAdapter) : null,
  };
}
