import { TestBed } from '@angular/core/testing';
import {
  BUILD_INFO,
  DevicePreferenceStorageService,
} from '@trinity/platform-native';
import { firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { RELEASE_NOTES, type ReleaseNote } from './release-notes';
import { WhatsNewService } from './whats-new.service';

const KEY = 'trinity.whats-new.last-seen-version';
const note = (version: string): ReleaseNote => ({
  version,
  date: '2026-01-01',
  sections: {},
});
const NOTES = [
  note('0.5.0-next.3'),
  note('0.5.0-next.2'),
  note('0.5.0-next.1'),
];

class FakeStorage {
  readonly map = new Map<string, string>();
  failRead = false;
  failWrite = false;
  get(key: string): Observable<string | null> {
    return this.failRead
      ? throwError(() => new Error('read'))
      : of(this.map.get(key) ?? null);
  }
  set(key: string, value: string): Observable<void> {
    if (this.failWrite) return throwError(() => new Error('write'));
    this.map.set(key, value);
    return of(undefined);
  }
}

function setup(stored: string | null, notes: readonly ReleaseNote[] = NOTES) {
  const storage = new FakeStorage();
  if (stored !== null) storage.map.set(KEY, stored);
  TestBed.configureTestingModule({
    providers: [
      { provide: DevicePreferenceStorageService, useValue: storage },
      {
        provide: BUILD_INFO,
        useValue: { version: '0.5.0-next.3', commit: 'abc', builtAt: '' },
      },
      { provide: RELEASE_NOTES, useValue: notes },
    ],
  });
  return { storage, service: TestBed.inject(WhatsNewService) };
}

describe('WhatsNewService', () => {
  it('stores the running version and shows nothing on a fresh install', async () => {
    const { storage, service } = setup(null);
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('treats an unparseable stored version as a fresh install', async () => {
    const { storage, service } = setup('banana');
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('returns the skipped versions after an update without writing', async () => {
    const { storage, service } = setup('0.5.0-next.1');
    const result = await firstValueFrom(service.pending());
    expect(result.map((n) => n.version)).toEqual([
      '0.5.0-next.3',
      '0.5.0-next.2',
    ]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.1');
    await firstValueFrom(service.markSeen());
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('returns nothing for the same version', async () => {
    const { storage, service } = setup('0.5.0-next.3');
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('returns nothing for a downgrade and stores the running version', async () => {
    const { storage, service } = setup('0.5.0');
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('returns nothing when the build has no notes', async () => {
    const { storage, service } = setup('0.5.0-next.1', []);
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('stores the running version when no newer notes fall in range', async () => {
    const { storage, service } = setup('0.5.0-next.1', [
      note('0.5.0-next.1'),
      note('0.6.0'),
    ]);
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
  });

  it('returns nothing and writes nothing when storage cannot be read', async () => {
    const { storage, service } = setup('0.5.0-next.1');
    storage.failRead = true;
    expect(await firstValueFrom(service.pending())).toEqual([]);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.1');
  });

  it('markSeen writes the running version and reports a write failure', async () => {
    const { storage, service } = setup(null);
    expect(await firstValueFrom(service.markSeen())).toBe(true);
    expect(storage.map.get(KEY)).toBe('0.5.0-next.3');
    storage.failWrite = true;
    expect(await firstValueFrom(service.markSeen())).toBe(false);
  });
});
