import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HomeserverInfoService,
  type HomeserverInfo,
} from '@trinity/data-access/homeserver';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountProfilesService } from '@trinity/data-access/profile';
import { ServerSectionComponent } from './server-section.component';

function setup(
  accountIds: readonly string[],
  refreshAll: () => Observable<void> = () => of(undefined),
) {
  const ids = signal<readonly string[]>(accountIds);
  const infos = signal<ReadonlyMap<string, HomeserverInfo>>(new Map());
  return render(ServerSectionComponent, {
    providers: [
      MockProvider(MatrixClientService, { accountIds: ids.asReadonly() }),
      MockProvider(HomeserverInfoService, {
        infos: infos.asReadonly(),
        load: () => of(undefined),
        refreshAll,
      }),
      MockProvider(AccountProfilesService, {
        profileOf: (userId: string) => ({
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

describe('ServerSectionComponent', () => {
  beforeEach(() => vi.clearAllMocks());

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

  it('does not repeat the client build line', async () => {
    // The settings shell renders it in the footer of every section, so both halves are
    // already on screen together; repeating it here would be two sources for one fact.
    const { container } = await setup(['@me:one.org']);

    expect(container.textContent).not.toContain('Trinity v');
  });

  it('gives the section a heading the assistive tree can use', async () => {
    const { container } = await setup(['@me:one.org']);

    expect(container.querySelector('h2')?.textContent?.trim()).toBe('Server');
  });
});
