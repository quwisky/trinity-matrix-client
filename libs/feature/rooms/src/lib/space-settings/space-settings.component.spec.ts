import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  HistoryVisibility,
  JoinRule,
  RoomActionPermissionsService,
  RoomAliasesService,
  RoomMembersService,
  RoomModerationService,
  RoomSettingsService,
  type ActionAvailability,
  type RoomSettingsPermissions,
  type RoomSettingsSnapshot,
} from '@trinity/data-access/room-administration';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  SpaceContentsService,
  SpaceRoomOrderService,
} from '@trinity/data-access/room-library';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { MockProvider } from 'ng-mocks';
import {
  BehaviorSubject,
  firstValueFrom,
  Subject,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { SpaceSettingsComponent } from './space-settings.component';

const TARGET = { accountId: '@opening:hs', roomId: '!space:hs' } as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };
const DENIED: ActionAvailability = {
  available: false,
  reason: 'Your role cannot change this Space detail.',
};
const ALL_ALLOWED: RoomSettingsPermissions = {
  name: ALLOWED,
  topic: ALLOWED,
  avatar: ALLOWED,
  joinRule: ALLOWED,
  history: DENIED,
  aliases: ALLOWED,
};

function spaceSnapshot(
  over: Partial<
    Omit<RoomSettingsSnapshot, 'identity' | 'access' | 'permissions'>
  > & {
    identity?: Partial<RoomSettingsSnapshot['identity']>;
    access?: Partial<RoomSettingsSnapshot['access']>;
    permissions?: Partial<RoomSettingsPermissions>;
  } = {},
): RoomSettingsSnapshot {
  const { identity, access, permissions, ...snapshot } = over;
  return {
    target: TARGET,
    availability: 'available',
    unavailableReason: null,
    openingAccountActive: true,
    identity: {
      name: 'Original space',
      topic: 'Original topic',
      avatarMxc: 'mxc://hs/space',
      ...identity,
    },
    access: {
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      allowedSpaceIds: [],
      ...access,
    },
    permissions: { ...ALL_ALLOWED, ...permissions },
    encrypted: false,
    supportsRestricted: true,
    ...snapshot,
  };
}

interface BuildOptions {
  readonly compact?: boolean;
  readonly initial?: RoomSettingsSnapshot;
  readonly setName?: Mock;
  readonly setTopic?: Mock;
  readonly setAvatar?: Mock;
  readonly setJoinRule?: Mock;
}

async function build(options: BuildOptions = {}) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: Boolean(options.compact && query.includes('767.98px')),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  const initial = options.initial ?? spaceSnapshot();
  const snapshots = new BehaviorSubject(initial);
  const setName = options.setName ?? vi.fn(() => of(undefined));
  const setTopic = options.setTopic ?? vi.fn(() => of(undefined));
  const setAvatar = options.setAvatar ?? vi.fn(() => of(undefined));
  const setJoinRule = options.setJoinRule ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const confirmResult = new Subject<boolean>();
  const confirm = vi.fn(() => confirmResult.asObservable());
  const toast = vi.fn();

  const { fixture, container } = await render(SpaceSettingsComponent, {
    inputs: {
      accountId: TARGET.accountId,
      spaceId: TARGET.roomId,
      spaceDisplayName: 'Fallback space',
    },
    providers: [
      MockProvider(RoomSettingsService, {
        snapshot: () => snapshots.value,
        observe: () => snapshots.asObservable(),
        setName,
        setTopic,
        setAvatar,
        setJoinRule,
      }),
      MockProvider(AccountIdentitiesService, {
        identityOf: () => ({
          userId: TARGET.accountId,
          displayName: 'Opening account',
          avatarMxc: 'mxc://hs/account',
        }),
      }),
      MockProvider(SpaceRoomOrderService, {
        retryHydration: () =>
          of({ accountId: TARGET.accountId, kind: 'ready' as const }),
        snapshotFor: () => ({
          defaultMode: 'recent',
          overrideMode: null,
          effectiveMode: 'recent',
        }),
        setForAccountSpace: () => of(undefined),
        clearForAccountSpace: () => of(undefined),
      }),
      MockProvider(SpaceContentsService, {
        observe: () =>
          of({
            target: { accountId: TARGET.accountId, spaceId: TARGET.roomId },
            availability: 'available',
            unavailableReason: null,
            items: [],
            curationLinks: [],
            candidates: [],
            canManage: false,
            managementUnavailableReason: 'Read only.',
            hierarchyError: null,
          }),
      }),
      MockProvider(RoomActionPermissionsService, {
        settings: () => snapshots.value.permissions,
        settingsFor: () => snapshots.value.permissions,
        unban: () => DENIED,
      }),
      MockProvider(RoomAliasesService, {
        serverName: () => 'hs',
        currentCanonical: () => null,
        localAliases: () => of([]),
        addAlias: () => of(undefined),
        removeAlias: () => of(undefined),
        setCanonicalAlias: () => of(undefined),
      }),
      MockProvider(RoomMembersService, {
        bannedView: () => ({
          availability: 'coherent',
          current: [],
          stale: null,
        }),
      }),
      MockProvider(RoomModerationService, { unban: () => of(undefined) }),
      MockProvider(TrnDialogService, { isTopmost: () => true }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnAlertService, { confirm$: confirm }),
      MockProvider(TrnToastService, { show: toast }),
    ],
  });

  const emit = async (next: RoomSettingsSnapshot): Promise<void> => {
    snapshots.next(next);
    await fixture.whenStable();
  };
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    emit,
    setName,
    setTopic,
    setAvatar,
    setJoinRule,
    close,
    confirm,
    confirmResult,
    toast,
  };
}

describe('SpaceSettingsComponent', () => {
  it('opens General with the exact Account identity and readable Space details', async () => {
    const { cmp, container } = await build();

    expect(cmp.selectedSection()).toBe('general');
    expect(
      container.querySelector('[data-testid="space-settings-account"]')
        ?.textContent,
    ).toContain('Opening account');
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="space-settings-name"]',
      )?.value,
    ).toBe('Original space');
    expect(cmp.sections.map(({ value }) => value)).toEqual([
      'general',
      'for-you',
      'access',
      'contents',
      'members',
      'addresses',
    ]);
  });

  it('pins General writes to the opening Account and Space', async () => {
    const { cmp, setName } = await build();
    cmp.draft.form.name().value.set('Renamed');

    cmp.draft.saveGeneral();

    expect(setName).toHaveBeenCalledWith(TARGET, 'Renamed');
  });

  it('uploads the Space avatar immediately against the exact Account and Space', async () => {
    const setAvatar = vi.fn(() => of(undefined));
    const { fixture, container, toast } = await build({ setAvatar });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="space-settings"] input[type="file"]',
    );
    if (!input) throw new Error('Space avatar input was not rendered');
    const file = new File(['avatar'], 'space.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });

    input.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();

    expect(setAvatar).toHaveBeenCalledWith(TARGET, file);
    expect(toast).toHaveBeenCalledWith('Space photo updated.', {
      duration: 3000,
      variant: 'success',
    });
  });

  it('commits successful fields, retains failures, and retries only what remains', async () => {
    const setName = vi.fn(() => of(undefined));
    const setTopic = vi
      .fn<() => Observable<void>>()
      .mockReturnValueOnce(throwError(() => new Error('rejected')))
      .mockReturnValueOnce(of(undefined));
    const { cmp } = await build({ setName, setTopic });
    cmp.draft.form.name().value.set('New name');
    cmp.draft.form.topic().value.set('New topic');

    cmp.draft.saveGeneral();

    expect(cmp.draft.generalFeedback()?.message).toContain('Topic');
    expect(cmp.draft.generalDirty()).toBe(true);

    cmp.draft.saveGeneral();

    expect(setName).toHaveBeenCalledTimes(1);
    expect(setTopic).toHaveBeenCalledTimes(2);
    expect(cmp.draft.generalDirty()).toBe(false);
  });

  it('does not erase typing entered while a save response is late', async () => {
    const completion = new Subject<void>();
    const setName = vi.fn(() => completion.asObservable());
    const { cmp } = await build({ setName });
    cmp.draft.form.name().value.set('Submitted name');

    cmp.draft.saveGeneral();
    cmp.draft.form.name().value.set('Typed after submit');
    completion.next();
    completion.complete();

    expect(cmp.draft.model().name).toBe('Typed after submit');
    expect(cmp.draft.generalDirty()).toBe(true);
  });

  it('preserves drafts and disables writes when permission disappears live', async () => {
    const { cmp, container, emit } = await build();
    cmp.draft.form.name().value.set('Keep this');

    await emit(
      spaceSnapshot({
        permissions: { name: DENIED, topic: DENIED, avatar: DENIED },
      }),
    );

    expect(cmp.draft.model().name).toBe('Keep this');
    expect(cmp.draft.form.name().disabled()).toBe(true);
    expect(
      container
        .querySelector('[data-testid="space-settings-save"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('retains drafts and explains when the opening target becomes unavailable', async () => {
    const { cmp, container, emit } = await build();
    cmp.draft.form.topic().value.set('Keep after sign-out');

    await emit(
      spaceSnapshot({
        availability: 'room-unavailable',
        openingAccountActive: false,
        permissions: {
          name: DENIED,
          topic: DENIED,
          avatar: DENIED,
          joinRule: DENIED,
          aliases: DENIED,
        },
      }),
    );

    expect(cmp.draft.model().topic).toBe('Keep after sign-out');
    expect(cmp.draft.form.topic().disabled()).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Space is no longer joined',
    );
  });

  it('protects section changes and Close until the draft is discarded', async () => {
    const { cmp, close, confirmResult } = await build();
    cmp.draft.form.topic().value.set('Unfinished');

    cmp.selectSection('access');
    expect(cmp.selectedSection()).toBe('general');
    confirmResult.next(false);
    expect(cmp.selectedSection()).toBe('general');

    cmp.selectSection('access');
    confirmResult.next(true);
    expect(cmp.selectedSection()).toBe('access');
    expect(cmp.draft.model().topic).toBe('Original topic');

    cmp.selectSection('general');
    cmp.draft.form.name().value.set('Another draft');
    cmp.close();
    confirmResult.next(true);
    expect(close).toHaveBeenCalledWith(false);
  });

  it('protects Close while the personal Space order is staged', async () => {
    const { cmp, close, confirm, confirmResult } = await build();
    cmp.selectSection('for-you');
    cmp.forYou.setMode('space');

    cmp.close();

    expect(confirm).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    confirmResult.next(false);
    expect(cmp.forYou.model().mode).toBe('space');

    cmp.close();
    confirmResult.next(true);
    expect(close).toHaveBeenCalledWith(false);
  });

  it('uses the first mobile Back for section-to-directory navigation', async () => {
    const { cmp } = await build({ compact: true });

    expect(cmp.directoryVisible()).toBe(false);
    expect(cmp.requestExternalDismiss()).toBe(false);
    expect(cmp.directoryVisible()).toBe(true);
    expect(cmp.requestExternalDismiss()).toBe(true);
  });

  it('offers browser and host Back to the canonical Workspace surface', async () => {
    const { cmp, confirm } = await build();
    cmp.draft.form.topic().value.set('Protected by Workspace Back');

    const outcome = await firstValueFrom(
      TestBed.inject(WorkspaceBackService).back(),
    );

    expect(outcome).toMatchObject({
      kind: 'blocked',
      surface: {
        layer: 'room',
        surface: { kind: 'settings', ...TARGET },
      },
    });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('keeps unfamiliar access state readable and never offers new restricted choices', async () => {
    const { cmp } = await build({
      initial: spaceSnapshot({ access: { joinRule: JoinRule.Knock } }),
    });

    expect(cmp.draft.joinRuleOptions().map(({ value }) => value)).toEqual([
      JoinRule.Invite,
      JoinRule.Public,
      JoinRule.Knock,
    ]);
    expect(
      cmp.draft.joinRuleOptions().find(({ value }) => value === JoinRule.Knock)
        ?.label,
    ).toBe('Anyone can ask to join');
    expect(
      cmp.draft
        .joinRuleOptions()
        .some(({ value }) => value === JoinRule.Restricted),
    ).toBe(false);
  });

  it('keeps an existing restricted access rule readable without rewriting it', async () => {
    const { cmp, setJoinRule } = await build({
      initial: spaceSnapshot({
        access: { joinRule: JoinRule.Restricted },
      }),
    });

    expect(cmp.draft.joinRuleOptions()).toContainEqual({
      value: JoinRule.Restricted,
      label: 'Members of another space',
      testId: `join-rule-${JoinRule.Restricted}`,
    });

    cmp.draft.saveAccess();

    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('saves Access independently against the exact target', async () => {
    const { cmp, fixture, setJoinRule } = await build();
    cmp.selectSection('access');
    await fixture.whenStable();
    cmp.draft.form.joinRule().value.set(JoinRule.Public);

    cmp.draft.saveAccess();

    expect(setJoinRule).toHaveBeenCalledWith(TARGET, JoinRule.Public);
    expect(cmp.draft.generalDirty()).toBe(false);
  });

  it('shows member Space policy without a disabled Access footer', async () => {
    const { cmp, fixture, container } = await build({
      initial: spaceSnapshot({
        access: { joinRule: JoinRule.Public },
        permissions: { joinRule: DENIED },
      }),
    });

    cmp.selectSection('access');
    await fixture.whenStable();

    expect(
      container.querySelector('[data-testid="space-settings-join-rule"]'),
    ).toHaveTextContent('Anyone can find and join');
    expect(container.textContent).toContain(DENIED.reason);
    expect(container.textContent).toContain(
      'Rooms inside it keep their own access settings',
    );
    expect(
      container.querySelector('[data-testid="space-settings-access-actions"]'),
    ).toBeNull();
  });

  it('retains a failed Space policy draft and retries it', async () => {
    const setJoinRule = vi
      .fn<() => Observable<void>>()
      .mockReturnValueOnce(throwError(() => new Error('rejected')))
      .mockReturnValueOnce(of(undefined));
    const { cmp } = await build({ setJoinRule });
    cmp.draft.form.joinRule().value.set(JoinRule.Public);

    cmp.draft.saveAccess();
    expect(cmp.draft.accessFeedback()?.message).toContain('still here');
    expect(cmp.draft.accessDirty()).toBe(true);
    cmp.draft.saveAccess();

    expect(setJoinRule).toHaveBeenCalledTimes(2);
    expect(cmp.draft.accessDirty()).toBe(false);
  });

  it('keeps a Space Access draft when join-rule permission disappears', async () => {
    const { cmp, fixture, container, emit, setJoinRule } = await build();
    cmp.selectSection('access');
    cmp.draft.form.joinRule().value.set(JoinRule.Public);

    await emit(spaceSnapshot({ permissions: { joinRule: DENIED } }));
    await fixture.whenStable();

    expect(cmp.draft.model().joinRule).toBe(JoinRule.Public);
    expect(cmp.draft.form.joinRule().disabled()).toBe(true);
    expect(container.textContent).toContain(DENIED.reason);
    expect(
      container
        .querySelector('[data-testid="space-settings-save"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    cmp.draft.saveAccess();
    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('keeps a Space Access draft across an unrelated live policy update', async () => {
    const { cmp, emit, setJoinRule } = await build();
    cmp.draft.form.joinRule().value.set(JoinRule.Public);

    await emit(
      spaceSnapshot({
        access: { joinRule: JoinRule.Knock },
      }),
    );

    expect(cmp.draft.model().joinRule).toBe(JoinRule.Public);
    cmp.draft.saveAccess();
    expect(setJoinRule).toHaveBeenCalledWith(TARGET, JoinRule.Public);
  });

  it('keeps exact-Account Addresses reachable after the Active Account changes', async () => {
    const { cmp, fixture, container, emit } = await build();

    cmp.selectSection('addresses');
    await fixture.whenStable();
    expect(container.querySelector('trn-room-aliases')).not.toBeNull();

    await emit(spaceSnapshot({ openingAccountActive: false }));
    expect(container.querySelector('trn-room-aliases')).not.toBeNull();
  });

  it('does not acquire Room-only history, encryption or widgets controls', async () => {
    const { container } = await build();

    expect(
      container.querySelector('[data-testid="space-settings-history"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="space-settings-encryption"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="space-settings-tab-widgets"]'),
    ).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});
