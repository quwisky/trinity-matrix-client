import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HomeserverInfoService,
  type HomeserverInfo,
} from '@trinity/data-access/homeserver';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { HomeserverBlockComponent } from './homeserver-block.component';

const USER_ID = '@me:example.org';

/** A fully-answered record; each test narrows the field it is about. */
function info(overrides: Partial<HomeserverInfo> = {}): HomeserverInfo {
  return {
    userId: USER_ID,
    serverName: 'example.org',
    baseUrl: 'https://example.org',
    discovered: false,
    software: {
      name: 'Synapse',
      version: '1.158.0',
      source: 'base-url',
      host: 'https://example.org',
    },
    specVersions: ['v1.11', 'v1.12'],
    unstableFeatures: [],
    capabilities: { defaultRoomVersion: '10', canChangePassword: true },
    ...overrides,
  };
}

function renderBlock(
  record: HomeserverInfo | null,
  load: Observable<void> = of(undefined),
) {
  const infos = signal<ReadonlyMap<string, HomeserverInfo>>(
    record ? new Map([[USER_ID, record]]) : new Map(),
  );
  return render(HomeserverBlockComponent, {
    inputs: { userId: USER_ID },
    providers: [
      MockProvider(HomeserverInfoService, {
        infos: infos.asReadonly(),
        load: () => load,
      }),
      MockProvider(AccountIdentitiesService, {
        identityOf: (userId: string) => ({
          userId,
          displayName: 'Me',
          avatarMxc: null,
        }),
      }),
    ],
  });
}

const text = (container: Element, testid: string) =>
  container.querySelector(`[data-testid="${testid}"]`)?.textContent?.trim();

describe('HomeserverBlockComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('heads the block with the account it describes', async () => {
    // Nothing else asserted the heading, so the whole `AccountIdentitiesService` dependency —
    // which exists only for this line — could be dropped for the bare mxid unnoticed.
    const { container } = await renderBlock(info());

    expect(text(container, 'hs-account')).toBe('Me');
  });

  it('shows the software name and version as the headline', async () => {
    const { container } = await renderBlock(info());

    expect(text(container, 'hs-software')).toBe('Synapse 1.158.0');
  });

  it('shows a build-suffixed version verbatim rather than tidying it up', async () => {
    // matrix.org's real answer. The suffix is the half that says WHICH build is live, which
    // is the question that asked for this feature — trimming to `1.158.0` would throw away
    // exactly the information the reader came for.
    const version = '1.158.0 (b=matrix-org-hotfixes-priv,5569b9e479)';
    const { container } = await renderBlock(
      info({
        software: {
          name: 'Synapse',
          version,
          source: 'delegated',
          host: 'https://matrix-federation.example.org',
        },
      }),
    );

    expect(text(container, 'hs-software')).toBe(`Synapse ${version}`);
  });

  it('reads Unknown, not blank, when neither attempt answered', async () => {
    // The requirement in the issue: unknown or hidden, never an error. A blank value would
    // read as a rendering bug rather than as an answer.
    const { container } = await renderBlock(info({ software: null }));

    expect(text(container, 'hs-software')).toBe('Unknown');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('still shows the URL when every remote field is unknown', async () => {
    // The local half of the block never needed the network, so an unreachable server must
    // not blank the whole thing.
    const { container } = await renderBlock(
      info({ software: null, specVersions: null, capabilities: null }),
    );

    expect(text(container, 'hs-url')).toBe('https://example.org');
    expect(text(container, 'hs-spec-versions')).toBe('Unknown');
  });

  it('omits the server-name row when it IS the homeserver', async () => {
    // One render per test: `render()` configures the TestBed, which cannot be reconfigured
    // once instantiated, so the two halves of this pair are two tests.
    const { container } = await renderBlock(info({ discovered: false }));

    expect(
      container.querySelector('[data-testid="hs-server-name"]'),
    ).toBeNull();
  });

  it('shows the server name when it differs from the homeserver', async () => {
    const { container } = await renderBlock(
      info({
        discovered: true,
        serverName: 'example.org',
        baseUrl: 'https://matrix.example.org',
      }),
    );

    expect(text(container, 'hs-server-name')).toContain('example.org');
  });

  it('describes a differing server name without claiming .well-known', async () => {
    // Trinity does not record HOW the URL was arrived at, and a hand-typed address that
    // happens to differ looks identical from here. The copy therefore states what is true —
    // the two values — rather than naming a mechanism it cannot verify.
    const { container } = await renderBlock(
      info({ discovered: true, baseUrl: 'https://matrix.example.org' }),
    );

    const row = text(container, 'hs-server-name') ?? '';
    expect(row).toContain('a different address');
    expect(row).not.toContain('.well-known');
    // Nor any other word for the mechanism: "discovered" was the previous wording and it
    // claimed the same unverifiable thing in softer clothes.
    expect(row).not.toContain('discovered');
  });

  it('lists the spec versions the server advertises', async () => {
    const { container } = await renderBlock(info());

    expect(text(container, 'hs-spec-versions')).toBe('v1.11, v1.12');
  });

  it('shows the capability rows the server stated', async () => {
    const { container } = await renderBlock(info());

    expect(text(container, 'hs-room-version')).toBe('10');
    expect(text(container, 'hs-change-password')).toBe('Supported here');
  });

  it('omits a capability row the server left unstated', async () => {
    // null means "the server did not say", which is not the same as "no" — rendering it as
    // a definite answer would be a guess presented as a fact.
    const { container } = await renderBlock(
      info({
        capabilities: { defaultRoomVersion: null, canChangePassword: null },
      }),
    );

    expect(
      container.querySelector('[data-testid="hs-room-version"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="hs-change-password"]'),
    ).toBeNull();
  });

  it('puts unstable features behind a disclosure, counted', async () => {
    const { container } = await renderBlock(
      info({ unstableFeatures: ['org.matrix.msc3916', 'org.matrix.msc4028'] }),
    );

    const details = container.querySelector('[data-testid="hs-unstable"]');
    expect(details?.querySelector('summary')?.textContent?.trim()).toBe(
      '2 enabled',
    );
    expect(details?.querySelectorAll('li').length).toBe(2);
  });

  it('omits the unstable row entirely when none are enabled', async () => {
    const { container } = await renderBlock(info({ unstableFeatures: [] }));

    expect(container.querySelector('[data-testid="hs-unstable"]')).toBeNull();
  });

  it('shows a status line while the first probe is still running', async () => {
    // An absent record is "not asked yet" and a record full of nulls is "asked, unknown".
    // Collapsing the two would leave an unreachable server spinning forever.
    const { container } = await renderBlock(null, new Observable<void>());

    expect(text(container, 'hs-loading')).toContain('Checking');
    expect(container.querySelector('[data-testid="hs-software"]')).toBeNull();
  });

  it('announces the ANSWER, not only that it is looking', async () => {
    // The live region is persistent and its CONTENT changes. Wired the other way round — a
    // region inserted with its loading text and then removed when the rows replace it — a
    // screen reader hears "Checking…" and then silence, on a surface whose entire point is
    // a value that arrives seconds later. Same rule the banner component states.
    const { container } = await renderBlock(info());
    const live = container.querySelector('[data-testid="hs-status"]');

    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toContain('Synapse 1.158.0');
    // And the loading line is gone — the region above is the one thing that persists across
    // both states, which is what lets it be updated rather than replaced.
    expect(container.querySelector('[data-testid="hs-loading"]')).toBeNull();
  });

  it('announces an unknown version rather than falling silent', async () => {
    const { container } = await renderBlock(info({ software: null }));

    expect(
      container.querySelector('[data-testid="hs-status"]')?.textContent,
    ).toContain('server version unknown');
  });

  it('keeps the visible status out of the announcement', async () => {
    // Two live regions saying the same thing double-announce; the visible line is decoration
    // for the region above it.
    const { container } = await renderBlock(null, new Observable<void>());

    expect(
      container
        .querySelector('[data-testid="hs-loading"]')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="hs-status"]')?.textContent,
    ).toContain('Checking');
  });

  it('says so when a probe finished without storing anything', async () => {
    // The third state. It used to render a bare heading and nothing else — the exact silent
    // blank the error branch below is wired to prevent.
    const { container } = await renderBlock(null, of(undefined));

    expect(text(container, 'hs-unchecked')).toContain('Not checked yet');
  });

  it('loads through the service on first render', async () => {
    const load = vi.fn(() => of(undefined));
    const infos = signal<ReadonlyMap<string, HomeserverInfo>>(new Map());
    await render(HomeserverBlockComponent, {
      inputs: { userId: USER_ID },
      providers: [
        MockProvider(HomeserverInfoService, {
          infos: infos.asReadonly(),
          load,
        }),
        MockProvider(AccountIdentitiesService, {
          identityOf: (userId: string) => ({
            userId,
            displayName: 'Me',
            avatarMxc: null,
          }),
        }),
      ],
    });

    // `load`, not `refresh`: opening the section a second time must not re-probe. The
    // deliberate re-check is the section's Check again button.
    expect(load).toHaveBeenCalledWith(USER_ID);
  });

  it('surfaces an error inline rather than leaving the block blank', async () => {
    // The branch is unreachable today — the service resolves rather than throws, which its
    // own spec asserts — so this pins the wiring, not a live path: if the service ever does
    // start failing, the block says so instead of rendering nothing.
    const { container } = await renderBlock(
      null,
      throwError(() => new Error('probe exploded')),
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'probe exploded',
    );
  });
});
