import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HomeserverInfoService,
  type HomeserverInfo,
} from '@trinity/data-access/homeserver';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { BUILD_INFO } from '@trinity/platform-native';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { ServerSectionComponent } from './server-section.component';

function setup(
  accountIds: readonly string[],
  refreshAll: () => Observable<void> = () => of(undefined),
) {
  const ids = signal<readonly string[]>(accountIds);
  const infos = signal<ReadonlyMap<string, HomeserverInfo>>(new Map());
  return render(ServerSectionComponent, {
    providers: [
      {
        provide: BUILD_INFO,
        useValue: { version: '9.9.9', commit: 'abc1234', builtAt: '' },
      },
      MockProvider(MatrixClientService, { accountIds: ids.asReadonly() }),
      MockProvider(HomeserverInfoService, {
        infos: infos.asReadonly(),
        load: () => of(undefined),
        refreshAll,
      }),
      MockProvider(AccountIdentitiesService, {
        identityOf: (userId: string) => ({
          userId,
          displayName: userId,
          avatarMxc: null,
        }),
      }),
    ],
  });
}

const blocks = (container: Element) =>
  container.querySelectorAll('[data-testid="server-block"]');

/**
 * Report a narrow viewport for one test.
 *
 * `test-setup.base` stubs `matchMedia` to answer `matches: false` for everything, so the
 * default in every spec here is the wide layout. Restored in `afterEach` rather than left
 * global: the shell reads the same breakpoint.
 */
const realMatchMedia = globalThis.matchMedia;
function stubViewportBelowMd(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === BELOW_MD_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('ServerSectionComponent', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.stubGlobal('matchMedia', realMatchMedia));

  it('renders one block per signed-in account', async () => {
    // The requirement the whole section exists for: several accounts, each on its own
    // server, and the one you want to check may not be the one you are acting as.
    const { container } = await setup(['@me:one.org', '@alt:two.org']);

    expect(blocks(container).length).toBe(2);
    expect(
      [...blocks(container)].map((b) => b.getAttribute('data-account')),
    ).toEqual(['@me:one.org', '@alt:two.org']);
  });

  it('says so plainly when no account is signed in', async () => {
    const { container } = await setup([]);

    expect(blocks(container).length).toBe(0);
    expect(container.textContent).toContain('No account is signed in');
    // Nothing to check, so the button is not offered rather than offered and inert.
    expect(
      container.querySelector('[data-testid="server-check-again"]'),
    ).toBeNull();
  });

  it('re-probes every account when Check again is pressed', async () => {
    const refreshAll = vi.fn(() => of(undefined));
    const { container } = await setup(['@me:one.org'], refreshAll);

    container
      .querySelector<HTMLButtonElement>('[data-testid="server-check-again"]')
      ?.click();

    // refreshAll, not loadAll: the button's entire purpose is to ignore the cache, and a
    // version fetched once at login cannot show that anything changed.
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('disables the button and says so while a check is in flight', async () => {
    const { container, fixture } = await setup(
      ['@me:one.org'],
      () => new Observable<void>(), // never settles
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="server-check-again"]',
    );

    button?.click();
    fixture.detectChanges();

    expect(button?.disabled).toBe(true);
    expect(button?.textContent?.trim()).toBe('Checking…');
  });

  it('surfaces an error inline rather than swallowing it', async () => {
    // Unreachable today — `refreshAll()` resolves whatever the servers do, which its own
    // spec asserts — so this pins the wiring: if the service ever starts failing, the
    // section says so instead of stopping with nothing changed. The per-block branch is
    // pinned the same way; this one was not.
    const { container, fixture } = await setup(['@me:one.org'], () =>
      throwError(() => new Error('refresh exploded')),
    );

    container
      .querySelector<HTMLButtonElement>('[data-testid="server-check-again"]')
      ?.click();
    fixture.detectChanges();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'refresh exploded',
    );
  });

  it('does not repeat the client build line on a wide layout', async () => {
    // The shell renders it in the nav footer, which is on screen beside the section here —
    // repeating it would give one fact two sources. jsdom's matchMedia stub reports false
    // for every query, so this is the wide case.
    const { container } = await setup(['@me:one.org']);

    expect(container.textContent).not.toContain('Trinity v');
    expect(container.querySelector('[data-testid="server-build"]')).toBeNull();
  });

  it('shows the client build line where the shell hides its own', async () => {
    // Below 768px the shell hides the whole nav — and with it the build line — as soon as a
    // section is open, so on a phone the two halves could otherwise never be seen together.
    // That pairing is what #155 actually asked for.
    stubViewportBelowMd();
    const { container } = await setup(['@me:one.org']);

    expect(
      container.querySelector('[data-testid="server-build"]')?.textContent,
    ).toContain('Trinity v9.9.9 · abc1234');
  });

  it('gives the section a heading the assistive tree can use', async () => {
    const { container } = await setup(['@me:one.org']);

    expect(container.querySelector('h2')?.textContent?.trim()).toBe('Server');
  });
});
