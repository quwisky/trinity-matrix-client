import { signal } from '@angular/core';
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
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { WorkspaceBackService } from '@trinity/application/workspace';
import {
  WidgetManagementService,
  WidgetsService,
} from '@trinity/data-access/widgets';
import { ExternalBrowserService } from '@trinity/platform-native';
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
import { RoomSettingsComponent } from './room-settings.component';

const TARGET = { accountId: '@opening:hs', roomId: '!room:hs' } as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };
const DENIED: ActionAvailability = {
  available: false,
  reason: 'Your role cannot change this Room detail.',
};
const ALL_ALLOWED: RoomSettingsPermissions = {
  name: ALLOWED,
  topic: ALLOWED,
  avatar: ALLOWED,
  joinRule: ALLOWED,
  history: ALLOWED,
  aliases: ALLOWED,
};

function roomSnapshot(
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
      name: 'Original room',
      topic: 'Original topic',
      avatarMxc: 'mxc://hs/room',
      ...identity,
    },
    access: {
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      allowedSpaceIds: [],
      ...access,
    },
    permissions: { ...ALL_ALLOWED, ...permissions },
    encrypted: true,
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
  readonly setHistoryVisibility?: Mock;
  readonly parentSpaces?: readonly {
    readonly id: string;
    readonly name: string;
  }[];
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
  const initial = options.initial ?? roomSnapshot();
  const snapshots = new BehaviorSubject(initial);
  const setName = options.setName ?? vi.fn(() => of(undefined));
  const setTopic = options.setTopic ?? vi.fn(() => of(undefined));
  const setAvatar = options.setAvatar ?? vi.fn(() => of(undefined));
  const setJoinRule = options.setJoinRule ?? vi.fn(() => of(undefined));
  const setHistoryVisibility =
    options.setHistoryVisibility ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const confirmResult = new Subject<boolean>();
  const confirm = vi.fn(() => confirmResult.asObservable());
  const toast = vi.fn();
  const widgets = signal([]);
  const canManageWidgets = signal(false);

  const { fixture, container } = await render(RoomSettingsComponent, {
    inputs: {
      accountId: TARGET.accountId,
      roomId: TARGET.roomId,
      roomDisplayName: 'Fallback room',
      parentSpaces: options.parentSpaces ?? [
        { id: '!space:hs', name: 'Design' },
      ],
    },
    providers: [
      MockProvider(RoomSettingsService, {
        snapshot: () => snapshots.value,
        observe: () => snapshots.asObservable(),
        setName,
        setTopic,
        setAvatar,
        setJoinRule,
        setHistoryVisibility,
      }),
      MockProvider(AccountIdentitiesService, {
        identityOf: () => ({
          userId: TARGET.accountId,
          displayName: 'Opening account',
          avatarMxc: 'mxc://hs/account',
        }),
      }),
      MockProvider(RoomNotificationsService, {
        readMode: () => of('mentions'),
        setMode: () => of(undefined),
      }),
      MockProvider(RoomLibraryService, {
        organisationFor: () => ({ favourite: false, lowPriority: false }),
        setFavourite: () => of(undefined),
        setLowPriority: () => of(undefined),
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
      MockProvider(WidgetsService, {
        widgetsFor: () => widgets.asReadonly(),
        canManageFor: () => canManageWidgets.asReadonly(),
        launchFor: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      MockProvider(WidgetManagementService),
      MockProvider(ExternalBrowserService, { open: () => of(true) }),
      MockProvider(TrnDialogService),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnAlertService, { confirm$: confirm }),
      MockProvider(TrnToastService, { show: toast }),
    ],
  });

  const emit = (next: RoomSettingsSnapshot): void => {
    snapshots.next(next);
    fixture.detectChanges();
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
    setHistoryVisibility,
    close,
    confirm,
    confirmResult,
    toast,
  };
}

describe('RoomSettingsComponent', () => {
  it('opens General with the exact Account identity and readable Room details', async () => {
    const { cmp, container } = await build();

    expect(cmp.selectedSection()).toBe('general');
    expect(
      container.querySelector('[data-testid="room-settings-account"]')
        ?.textContent,
    ).toContain('Opening account');
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="room-settings-name"]',
      )?.value,
    ).toBe('Original room');
    expect(
      container.querySelector('[data-testid="room-settings-encryption"]')
        ?.textContent,
    ).toContain('end-to-end encrypted');
    expect(cmp.sections.map(({ value }) => value)).toEqual([
      'general',
      'for-you',
      'access',
      'members',
      'addresses',
      'widgets',
    ]);
  });

  it('protects Close when For you has an unsaved preference', async () => {
    const { cmp, close, confirmResult } = await build();
    cmp.forYouDraft.setFavourite(true);

    cmp.close();
    confirmResult.next(false);
    expect(close).not.toHaveBeenCalled();
    expect(cmp.forYouDraft.model().favourite).toBe(true);

    cmp.close();
    confirmResult.next(true);
    expect(close).toHaveBeenCalledWith(false);
  });

  it('pins General writes to the opening Account after the draft changes', async () => {
    const { cmp, setName } = await build();
    cmp.draft.form.name().value.set('Renamed');

    cmp.draft.saveGeneral();

    expect(setName).toHaveBeenCalledWith(TARGET, 'Renamed');
  });

  it('allows clearing an optional Room name while saving the section', async () => {
    const { cmp, setName } = await build();
    cmp.draft.form.name().value.set('');

    cmp.draft.saveGeneral();

    expect(setName).toHaveBeenCalledWith(TARGET, '');
    expect(cmp.draft.form.name().invalid()).toBe(false);
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

  it('protects a dirty section change until the user explicitly discards', async () => {
    const { cmp, confirm, confirmResult } = await build();
    cmp.draft.form.name().value.set('Unsaved');

    cmp.selectSection('access');

    expect(confirm).toHaveBeenCalled();
    expect(cmp.selectedSection()).toBe('general');
    confirmResult.next(false);
    expect(cmp.selectedSection()).toBe('general');

    cmp.selectSection('access');
    confirmResult.next(true);
    expect(cmp.selectedSection()).toBe('access');
    expect(cmp.draft.model().name).toBe('Original room');
  });

  it('protects Close, retains the draft on cancel, and closes on discard', async () => {
    const { cmp, close, confirmResult } = await build();
    cmp.draft.form.topic().value.set('Unfinished topic');

    cmp.close();
    confirmResult.next(false);

    expect(close).not.toHaveBeenCalled();
    expect(cmp.draft.model().topic).toBe('Unfinished topic');

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

  it('requires discard before mobile Back can abandon a dirty section', async () => {
    const { cmp, confirmResult } = await build({ compact: true });
    cmp.draft.form.name().value.set('Mobile draft');

    expect(cmp.requestExternalDismiss()).toBe(false);
    expect(cmp.directoryVisible()).toBe(false);

    confirmResult.next(true);
    expect(cmp.directoryVisible()).toBe(true);
    expect(cmp.draft.model().name).toBe('Original room');
  });

  it('keeps a dirty field while reconciling an untouched authoritative field', async () => {
    const { cmp, emit } = await build();
    cmp.draft.form.name().value.set('Typed locally');

    emit(
      roomSnapshot({
        identity: {
          name: 'Remote name',
          topic: 'Remote topic',
        },
      }),
    );

    expect(cmp.draft.model()).toMatchObject({
      name: 'Typed locally',
      topic: 'Remote topic',
    });
  });

  it('preserves drafts and disables writes when permission disappears live', async () => {
    const { cmp, container, emit } = await build();
    cmp.draft.form.name().value.set('Keep this');

    emit(
      roomSnapshot({
        permissions: { name: DENIED, topic: DENIED, avatar: DENIED },
      }),
    );

    expect(cmp.draft.model().name).toBe('Keep this');
    expect(cmp.draft.form.name().disabled()).toBe(true);
    expect(
      container
        .querySelector('[data-testid="room-settings-save"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('retains drafts with an explanation when the opening Account signs out', async () => {
    const { cmp, container, emit } = await build();
    cmp.draft.form.topic().value.set('Keep after sign-out');

    emit(
      roomSnapshot({
        availability: 'account-unavailable',
        unavailableReason:
          'This Account is no longer available. Your unfinished edits are still here.',
        openingAccountActive: false,
        permissions: {
          name: DENIED,
          topic: DENIED,
          avatar: DENIED,
          joinRule: DENIED,
          history: DENIED,
          aliases: DENIED,
        },
      }),
    );

    expect(cmp.draft.model().topic).toBe('Keep after sign-out');
    expect(cmp.draft.form.topic().disabled()).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'unfinished edits',
    );
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

  it('keeps Access reachable and exact-targeted', async () => {
    const { cmp, fixture, setJoinRule } = await build();
    cmp.selectSection('access');
    fixture.detectChanges();
    await fixture.whenStable();

    cmp.draft.form.joinRule().value.set(JoinRule.Public);
    cmp.draft.saveAccess();

    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="room-settings-panel-access"]',
      ),
    ).not.toBeNull();
    expect(setJoinRule).toHaveBeenCalledWith(TARGET, JoinRule.Public, []);
  });

  it('shows member policy explanations without an unusable Access footer', async () => {
    const { cmp, fixture, container } = await build({
      initial: roomSnapshot({
        access: {
          joinRule: JoinRule.Public,
          historyVisibility: HistoryVisibility.Joined,
        },
        permissions: { joinRule: DENIED, history: DENIED },
      }),
    });

    cmp.selectSection('access');
    await fixture.whenStable();

    expect(
      container.querySelector('[data-testid="room-settings-join-rule"]'),
    ).toHaveTextContent('Anyone can join');
    expect(
      container.querySelector('[data-testid="room-settings-history"]'),
    ).toHaveTextContent('Members — since they joined');
    expect(container.textContent).toContain(DENIED.reason);
    expect(
      container.querySelector('[data-testid="room-settings-access-actions"]'),
    ).toBeNull();
  });

  it('keeps unfamiliar Room history readable', async () => {
    const unfamiliar = 'org.example.archive' as HistoryVisibility;
    const { cmp } = await build({
      initial: roomSnapshot({
        access: { historyVisibility: unfamiliar },
      }),
    });

    expect(cmp.draft.historyOptions()).toContainEqual({
      value: unfamiliar,
      label: 'Server value (org.example.archive)',
      testId: 'history-org.example.archive',
    });
  });

  it('keeps an unfamiliar Room join rule readable without rewriting it', async () => {
    const unfamiliar = 'org.example.approval' as JoinRule;
    const { cmp, setJoinRule } = await build({
      initial: roomSnapshot({ access: { joinRule: unfamiliar } }),
    });

    expect(cmp.draft.joinRuleOptions()).toContainEqual({
      value: unfamiliar,
      label: 'Server value (org.example.approval)',
      testId: 'join-rule-org.example.approval',
    });
    cmp.draft.saveAccess();
    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('blocks a restricted rule until an allowed Space is selected', async () => {
    const { cmp, setJoinRule } = await build({ parentSpaces: [] });
    cmp.draft.form.joinRule().value.set(JoinRule.Restricted);

    cmp.draft.saveAccess();

    expect(cmp.draft.noSpaceChosen()).toBe(true);
    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('saves an authorized history change despite an unrelated invalid restricted rule', async () => {
    const { cmp, setJoinRule, setHistoryVisibility } = await build({
      initial: roomSnapshot({
        access: { joinRule: JoinRule.Restricted, allowedSpaceIds: [] },
        permissions: { joinRule: DENIED, history: ALLOWED },
      }),
    });
    cmp.draft.form
      .historyVisibility()
      .value.set(HistoryVisibility.WorldReadable);

    cmp.draft.saveAccess();

    expect(cmp.draft.noSpaceChosen()).toBe(false);
    expect(setJoinRule).not.toHaveBeenCalled();
    expect(setHistoryVisibility).toHaveBeenCalledWith(
      TARGET,
      HistoryVisibility.WorldReadable,
    );
  });

  it('preserves unlisted allowed Spaces while changing the visible selection', async () => {
    const { cmp, setJoinRule } = await build({
      initial: roomSnapshot({
        access: {
          joinRule: JoinRule.Restricted,
          allowedSpaceIds: ['!space:hs', '!unlisted:hs'],
        },
      }),
    });
    cmp.draft.toggleSpace('!space:hs', false);

    cmp.draft.saveAccess();

    expect(cmp.draft.unlistedAllowedSpaceCount()).toBe(1);
    expect(setJoinRule).toHaveBeenCalledWith(TARGET, JoinRule.Restricted, [
      '!unlisted:hs',
    ]);
  });

  it('keeps an Access draft when permission disappears live', async () => {
    const { cmp, fixture, container, emit, setJoinRule } = await build();
    cmp.selectSection('access');
    cmp.draft.form.joinRule().value.set(JoinRule.Public);

    emit(
      roomSnapshot({
        permissions: { joinRule: DENIED, history: DENIED },
      }),
    );
    await fixture.whenStable();

    expect(cmp.draft.model().joinRule).toBe(JoinRule.Public);
    expect(cmp.draft.form.joinRule().disabled()).toBe(true);
    expect(container.textContent).toContain(DENIED.reason);
    expect(
      container
        .querySelector('[data-testid="room-settings-save"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    cmp.draft.saveAccess();
    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('reconciles untouched Room policy without overwriting a related draft', async () => {
    const { cmp, emit, setJoinRule, setHistoryVisibility } = await build();
    cmp.draft.form.joinRule().value.set(JoinRule.Public);

    emit(
      roomSnapshot({
        access: { historyVisibility: HistoryVisibility.WorldReadable },
      }),
    );

    expect(cmp.draft.model()).toMatchObject({
      joinRule: JoinRule.Public,
      historyVisibility: HistoryVisibility.WorldReadable,
    });
    cmp.draft.saveAccess();
    expect(setJoinRule).toHaveBeenCalledWith(TARGET, JoinRule.Public, []);
    expect(setHistoryVisibility).not.toHaveBeenCalled();
  });

  it('commits one Room policy field and retries only the failed field', async () => {
    const setJoinRule = vi.fn(() => of(undefined));
    const setHistoryVisibility = vi
      .fn<() => Observable<void>>()
      .mockReturnValueOnce(throwError(() => new Error('rejected')))
      .mockReturnValueOnce(of(undefined));
    const { cmp } = await build({ setJoinRule, setHistoryVisibility });
    cmp.draft.form.joinRule().value.set(JoinRule.Public);
    cmp.draft.form
      .historyVisibility()
      .value.set(HistoryVisibility.WorldReadable);

    cmp.draft.saveAccess();
    expect(cmp.draft.accessFeedback()?.message).toContain('still unsaved');
    cmp.draft.saveAccess();

    expect(setJoinRule).toHaveBeenCalledTimes(1);
    expect(setHistoryVisibility).toHaveBeenCalledTimes(2);
    expect(cmp.draft.accessDirty()).toBe(false);
  });

  it('keeps Room addresses reachable in their own section', async () => {
    const { cmp, fixture, container, emit } = await build();

    cmp.selectSection('addresses');
    await fixture.whenStable();

    expect(
      container.querySelector('[data-testid="room-settings-panel-addresses"]'),
    ).not.toBeNull();
    expect(container.querySelector('trn-room-aliases')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="room-settings-panel-access"]'),
    ).toBeNull();

    emit(roomSnapshot({ openingAccountActive: false }));
    expect(container.querySelector('trn-room-aliases')).not.toBeNull();
  });

  it('does not expose legacy writers after switching away from the opening Account', async () => {
    const { cmp, fixture, container, emit } = await build();
    emit(roomSnapshot({ openingAccountActive: false }));

    cmp.selectSection('widgets');
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid="room-settings-panel-widgets"]')
        ?.textContent,
    ).toContain('Switch back to the opening Account');
    expect(container.querySelector('trn-room-widgets')).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});
