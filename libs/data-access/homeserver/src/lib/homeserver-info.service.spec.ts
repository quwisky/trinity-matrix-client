import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, firstValueFrom, take } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { FakeHomeserverEngine } from '../contract/fake-homeserver-engine';
import { HOMESERVER_ENGINE, type HomeserverProbe } from './homeserver-engine';
import type { ServerSoftware } from './homeserver-info.model';
import { HomeserverInfoService } from './homeserver-info.service';

const probeOf = (
  baseUrl: string,
  serverName: string,
  extra: Partial<HomeserverProbe> = {},
): HomeserverProbe => ({
  serverName,
  baseUrl,
  software: null,
  specVersions: ['v1.11'],
  unstableFeatures: [],
  capabilities: null,
  ...extra,
});

const synapse = (version: string): ServerSoftware => ({
  name: 'Synapse',
  version,
  source: 'base-url',
  host: 'https://one.org',
});

function setup(
  probes: Record<string, HomeserverProbe | null>,
  /** Signed-in ids the engine knows nothing about — it answers null for these. */
  idsWithoutSession: string[] = [],
  engine:
    | FakeHomeserverEngine
    | { probe: FakeHomeserverEngine['probe'] } = new FakeHomeserverEngine(),
) {
  const fake = engine instanceof FakeHomeserverEngine ? engine : null;
  for (const [id, probe] of Object.entries(probes)) {
    fake?.set(id, probe);
  }
  const ids = signal<readonly string[]>([
    ...Object.keys(probes),
    ...idsWithoutSession,
  ]);
  const generations = signal<ReadonlyMap<string, number>>(
    new Map(Object.keys(probes).map((id) => [id, 1])),
  );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      HomeserverInfoService,
      { provide: HOMESERVER_ENGINE, useValue: engine },
      MockProvider(MatrixClientService, {
        accountIds: ids.asReadonly(),
        sessionGenerations: generations.asReadonly(),
      }),
    ],
  });
  const svc = TestBed.inject(HomeserverInfoService);
  // The eviction pass wires itself from a constructor effect, which has not run yet.
  TestBed.tick();
  return { svc, ids, generations, engine, fake };
}

/** Read an account's record the way the real consumers do: `infos().get(...)`. */
const infoFor = (svc: HomeserverInfoService, userId: string) =>
  svc.infos().get(userId) ?? null;

describe('HomeserverInfoService', () => {
  it('probes every signed-in account through the engine', async () => {
    const { svc } = setup({
      '@me:one.org': probeOf('https://matrix.one.org', 'one.org', {
        software: synapse('1.157.2'),
      }),
      '@alt:two.org': probeOf('https://matrix.two.org', 'two.org', {
        software: { ...synapse('0.13.8'), name: 'Dendrite' },
      }),
    });

    await firstValueFrom(svc.loadAll());

    expect(infoFor(svc, '@me:one.org')?.software?.name).toBe('Synapse');
    expect(infoFor(svc, '@alt:two.org')?.software?.name).toBe('Dendrite');
  });

  it('records the spec versions, unstable flags and capabilities it was given', async () => {
    const capabilities = {
      defaultRoomVersion: '10',
      roomVersions: null,
      canChangePassword: false,
    };
    const { svc } = setup({
      '@me:one.example': probeOf('https://one.example', 'one.example', {
        specVersions: ['v1.11', 'v1.12'],
        unstableFeatures: ['org.matrix.msc4028'],
        capabilities,
      }),
    });

    await firstValueFrom(svc.load('@me:one.example'));

    expect(infoFor(svc, '@me:one.example')).toMatchObject({
      userId: '@me:one.example',
      specVersions: ['v1.11', 'v1.12'],
      unstableFeatures: ['org.matrix.msc4028'],
      capabilities,
    });
  });

  it('shares one in-flight probe rather than starting a second', async () => {
    const answer = new Subject<HomeserverProbe | null>();
    let started = 0;
    const { svc } = setup({ '@me:one.example': null }, [], {
      probe: () => {
        started++;
        return answer.pipe(take(1));
      },
    });

    const first = firstValueFrom(svc.load('@me:one.example'));
    const second = firstValueFrom(svc.refresh('@me:one.example'));
    answer.next(probeOf('https://one.example', 'one.example'));
    await Promise.all([first, second]);

    expect(started).toBe(1);
    expect(infoFor(svc, '@me:one.example')).not.toBeNull();
  });

  it('probes again once the shared request has finished', async () => {
    const { svc, fake } = setup({
      '@me:one.example': probeOf('https://one.example', 'one.example'),
    });

    await firstValueFrom(svc.refresh('@me:one.example'));
    await firstValueFrom(svc.refresh('@me:one.example'));

    expect(fake?.calls).toHaveLength(2);
  });

  it.each([
    ['a differently-cased host', 'https://One.Example', 'one.example'],
    ['an explicit default port', 'https://one.example:443', 'one.example'],
    ['the server name itself', 'https://one.org', 'one.org'],
  ])('does not read %s as delegation', async (_label, baseUrl, serverName) => {
    const { svc } = setup({
      [`@me:${serverName}`]: probeOf(baseUrl, serverName),
    });

    await firstValueFrom(svc.load(`@me:${serverName}`));

    expect(infoFor(svc, `@me:${serverName}`)?.discovered).toBe(false);
  });

  it('records the server name and base URL, and notes when they differ', async () => {
    const { svc } = setup({
      '@me:one.org': probeOf('https://matrix.one.org', 'one.org'),
    });

    await firstValueFrom(svc.load('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')).toMatchObject({
      serverName: 'one.org',
      baseUrl: 'https://matrix.one.org',
      discovered: true,
    });
  });

  it('records an answer even when every remote field came back null', async () => {
    // An ABSENT record is a spinner, a record full of nulls is "Unknown".
    const { svc } = setup({
      '@me:one.org': probeOf('https://one.org', 'one.org', {
        specVersions: null,
        unstableFeatures: null,
      }),
    });
    expect(infoFor(svc, '@me:one.org')).toBeNull();

    await firstValueFrom(svc.load('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')).toMatchObject({
      software: null,
      specVersions: null,
      capabilities: null,
      serverName: 'one.org',
      baseUrl: 'https://one.org',
    });
  });

  it('caches per session — a second load asks nothing', async () => {
    const { svc, fake } = setup({
      '@me:one.org': probeOf('https://one.org', 'one.org'),
    });

    await firstValueFrom(svc.load('@me:one.org'));
    await firstValueFrom(svc.load('@me:one.org'));

    expect(fake?.calls).toEqual(['@me:one.org']);
  });

  it('re-probes on refresh, and picks up a version that changed', async () => {
    const { svc, fake } = setup({
      '@me:one.org': probeOf('https://one.org', 'one.org', {
        software: synapse('1.157.2'),
      }),
    });
    await firstValueFrom(svc.load('@me:one.org'));

    fake?.set(
      '@me:one.org',
      probeOf('https://one.org', 'one.org', { software: synapse('1.158.0') }),
    );
    await firstValueFrom(svc.refresh('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')?.software?.version).toBe('1.158.0');
  });

  it('resolves without an entry for an account the engine does not know', async () => {
    const { svc } = setup(
      { '@me:one.org': probeOf('https://one.org', 'one.org') },
      ['@pending:two.org'],
    );

    await firstValueFrom(svc.loadAll());

    expect(infoFor(svc, '@me:one.org')).not.toBeNull();
    expect(infoFor(svc, '@pending:two.org')).toBeNull();
  });

  it('drops an account that signs out', async () => {
    const { svc, ids, generations } = setup({
      '@me:one.org': probeOf('https://one.org', 'one.org'),
    });
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')).not.toBeNull();

    generations.set(new Map());
    ids.set([]);
    TestBed.tick();

    expect(infoFor(svc, '@me:one.org')).toBeNull();
  });

  it('re-probes when the same user id gets a new session generation', async () => {
    const { svc, generations, fake } = setup({
      '@me:one.org': probeOf('https://old.example', 'one.org'),
    });
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')?.baseUrl).toBe('https://old.example');

    fake?.set('@me:one.org', probeOf('https://new.example', 'one.org'));
    generations.set(new Map([['@me:one.org', 2]]));
    TestBed.tick();

    expect(infoFor(svc, '@me:one.org')).toBeNull(); // stale answer dropped, not kept
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')?.baseUrl).toBe('https://new.example');
  });

  it('discards a probe that finished after its account was removed', async () => {
    const answer = new Subject<HomeserverProbe | null>();
    const { svc, ids, generations } = setup({ '@me:one.org': null }, [], {
      probe: () => answer.pipe(take(1)),
    });

    const pending = firstValueFrom(svc.load('@me:one.org'));
    generations.set(new Map());
    ids.set([]);
    TestBed.tick();
    answer.next(probeOf('https://one.org', 'one.org'));
    await pending;

    expect(infoFor(svc, '@me:one.org')).toBeNull();
  });

  it('discards a probe that resolved after the account got a new generation', async () => {
    const answer = new Subject<HomeserverProbe | null>();
    const { svc, generations } = setup({ '@me:one.org': null }, [], {
      probe: () => answer.pipe(take(1)),
    });

    const pending = firstValueFrom(svc.load('@me:one.org'));
    generations.set(new Map([['@me:one.org', 2]]));
    TestBed.tick();
    answer.next(probeOf('https://old.example', 'one.org'));
    await pending;

    expect(infoFor(svc, '@me:one.org')).toBeNull();
  });

  it('refreshes every account at once', async () => {
    const { svc, fake } = setup({
      '@me:one.org': probeOf('https://one.org', 'one.org'),
      '@alt:two.org': probeOf('https://two.org', 'two.org'),
    });

    await firstValueFrom(svc.refreshAll());

    expect(fake?.calls).toHaveLength(2);
    expect(svc.infos().size).toBe(2);
  });

  it('resolves with nothing to do when no account is signed in', async () => {
    const { svc } = setup({});

    await expect(firstValueFrom(svc.loadAll())).resolves.toBeUndefined();
    await expect(firstValueFrom(svc.refreshAll())).resolves.toBeUndefined();
    expect(svc.infos().size).toBe(0);
  });
});
