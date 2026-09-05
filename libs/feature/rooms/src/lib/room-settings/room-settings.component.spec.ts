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
import {
  WidgetManagementService,
  WidgetsService,
} from '@trinity/data-access/widgets';
import { ExternalBrowserService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import {
  BehaviorSubject,
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
      parentSpaces: [{ id: '!space:hs', name: 'Design' }],
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
      MockProvider(RoomActionPermissionsService, {
        settings: () => snapshots.value.permissions,
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
      'access',
      'widgets',
      'bans',
    ]);
  });

  it('pins General writes to the opening Account after the draft changes', async () => {
    const { cmp, setName } = await build();
    cmp.draft.form.name().value.set('Renamed');

    cmp.draft.saveGeneral();

    expect(setName).toHaveBeenCalledWith(TARGET, 'Renamed');
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

  it('keeps the legacy Access capability reachable and exact-targeted', async () => {
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

  it('does not expose legacy writers after switching away from the opening Account', async () => {
    const { cmp, fixture, container, emit } = await build();
    emit(roomSnapshot({ openingAccountActive: false }));

    cmp.selectSection('access');
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid="room-settings-panel-access"]')
        ?.textContent,
    ).toContain('Switch back to the opening Account');
    expect(
      container.querySelector('[data-testid="room-settings-join-rule"]'),
    ).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});
