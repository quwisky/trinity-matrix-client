import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import {
  SpaceRoomOrderService,
  type RoomSortMode,
} from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { SpaceSettingsDraftService } from '../space-settings-draft.service';
import { SpaceSettingsForYouDraftService } from './space-settings-for-you-draft.service';
import { SpaceSettingsForYouComponent } from './space-settings-for-you.component';

const TARGET = { accountId: '@opening:hs', spaceId: '!space:hs' } as const;

interface BuildOptions {
  readonly defaultMode?: RoomSortMode;
  readonly overrideMode?: RoomSortMode | null;
  readonly retryHydration?: Mock;
  readonly setForAccountSpace?: Mock;
  readonly clearForAccountSpace?: Mock;
}

async function build(options: BuildOptions = {}) {
  const defaultMode = options.defaultMode ?? 'recent';
  const overrideMode = options.overrideMode ?? null;
  const retryHydration =
    options.retryHydration ??
    vi.fn(() => of({ accountId: TARGET.accountId, kind: 'ready' as const }));
  const setForAccountSpace =
    options.setForAccountSpace ?? vi.fn(() => of(undefined));
  const clearForAccountSpace =
    options.clearForAccountSpace ?? vi.fn(() => of(undefined));
  const targetAvailable = signal(true);

  const { fixture, container } = await render(SpaceSettingsForYouComponent, {
    providers: [
      SpaceSettingsForYouDraftService,
      MockProvider(SpaceSettingsDraftService, {
        targetAvailable: targetAvailable.asReadonly(),
      }),
      MockProvider(SpaceRoomOrderService, {
        retryHydration,
        snapshotFor: () => ({
          defaultMode,
          overrideMode,
          effectiveMode: overrideMode ?? defaultMode,
        }),
        setForAccountSpace,
        clearForAccountSpace,
      }),
    ],
  });
  const draft = fixture.componentInstance.draft;
  draft.start(TARGET);
  await fixture.whenStable();
  return {
    fixture,
    container,
    draft,
    targetAvailable,
    retryHydration,
    setForAccountSpace,
    clearForAccountSpace,
  };
}

describe('SpaceSettingsForYouComponent', () => {
  it('shows all described choices with exactly one selected option and device scope', async () => {
    const { container } = await build({
      defaultMode: 'alphabetical',
      overrideMode: 'space',
    });
    const labels = container.querySelectorAll('[role="radiogroup"] label');

    expect([...labels].map((label) => label.textContent)).toEqual([
      expect.stringContaining('Use my default'),
      expect.stringContaining('Recent activity'),
      expect.stringContaining('Space order'),
      expect.stringContaining('Alphabetical'),
    ]);
    expect(labels[0].textContent).toContain('any later change');
    expect(labels[2].textContent).toContain('space itself arranges');
    expect(
      container.querySelectorAll('input[type="radio"]:checked'),
    ).toHaveLength(1);
    expect(
      container
        .querySelector('[data-testid="space-settings-order-space"] input')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(container.textContent).toContain('For this account on this device');
  });

  it('stages and saves an exact Account-and-Space override with pending feedback', async () => {
    const write = new Subject<void>();
    const setForAccountSpace = vi.fn<() => Observable<void>>(() => write);
    const { container, fixture, draft } = await build({ setForAccountSpace });

    container
      .querySelector<HTMLElement>('[data-testid="space-settings-order-space"]')
      ?.click();
    await fixture.whenStable();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="space-settings-for-you-save"]',
      )
      ?.click();
    await fixture.whenStable();

    expect(setForAccountSpace).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      'space',
    );
    expect(draft.feedback()?.tone).toBe('pending');
    expect(draft.saving()).toBe(true);

    write.next();
    write.complete();
    await fixture.whenStable();

    expect(draft.dirty()).toBe(false);
    expect(draft.feedback()?.tone).toBe('success');
  });

  it('removes the override for Use my default and retains a failed choice', async () => {
    const clearForAccountSpace = vi.fn(() =>
      throwError(() => new Error('storage unavailable')),
    );
    const { container, fixture, draft } = await build({
      overrideMode: 'space',
      clearForAccountSpace,
    });

    container
      .querySelector<HTMLElement>(
        '[data-testid="space-settings-order-default"]',
      )
      ?.click();
    await fixture.whenStable();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="space-settings-for-you-save"]',
      )
      ?.click();
    await fixture.whenStable();

    expect(clearForAccountSpace).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
    );
    expect(draft.model().mode).toBe('default');
    expect(draft.dirty()).toBe(true);
    expect(draft.feedback()).toMatchObject({ tone: 'danger' });
  });

  it('fails closed on an unreadable preference and can retry the exact Account', async () => {
    const retryHydration = vi
      .fn()
      .mockReturnValueOnce(
        of({
          accountId: TARGET.accountId,
          kind: 'defaulted' as const,
          diagnostic: { code: 'room-order-storage-unavailable' as const },
        }),
      )
      .mockReturnValueOnce(
        of({ accountId: TARGET.accountId, kind: 'ready' as const }),
      );
    const { container, fixture, draft } = await build({ retryHydration });

    expect(draft.loadState()).toBe('failed');
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="space-settings-for-you-retry"]',
      )
      ?.click();
    await fixture.whenStable();

    expect(retryHydration).toHaveBeenNthCalledWith(2, TARGET.accountId);
    expect(draft.loadState()).toBe('ready');
  });

  it('discards a staged selection without writing it', async () => {
    const { container, fixture, draft, setForAccountSpace } = await build();
    container
      .querySelector<HTMLElement>(
        '[data-testid="space-settings-order-alphabetical"]',
      )
      ?.click();
    await fixture.whenStable();

    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="space-settings-for-you-discard"]',
      )
      ?.click();
    await fixture.whenStable();

    expect(draft.model().mode).toBe('default');
    expect(draft.dirty()).toBe(false);
    expect(setForAccountSpace).not.toHaveBeenCalled();
  });
});
