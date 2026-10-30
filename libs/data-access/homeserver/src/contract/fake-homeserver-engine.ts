import { Observable, defer, of } from 'rxjs';
import type {
  HomeserverEngine,
  HomeserverProbe,
} from '../lib/homeserver-engine';

export class FakeHomeserverEngine implements HomeserverEngine {
  readonly calls: string[] = [];
  private readonly probes = new Map<string, HomeserverProbe | null>();

  set(accountId: string, probe: HomeserverProbe | null): void {
    this.probes.set(accountId, probe);
  }

  probe(accountId: string): Observable<HomeserverProbe | null> {
    return defer(() => {
      this.calls.push(accountId);
      return of(this.probes.get(accountId) ?? null);
    });
  }
}
