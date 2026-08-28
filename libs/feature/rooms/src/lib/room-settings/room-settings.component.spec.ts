import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  WidgetManagementService,
  WidgetsService,
} from '@trinity/data-access/widgets';
import { ExternalBrowserService } from '@trinity/platform-native';
import {
  RoomAliasesService,
  RoomModerationService,
  RoomSettingsService,
} from '@trinity/data-access/rooms';
import { HistoryVisibility, JoinRule } from '@trinity/data-access/rooms';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { RoomSettingsComponent } from './room-settings.component';

async function build(
  inputs: Partial<{
    name: string;
    topic: string;
    joinRule: JoinRule;
    historyVisibility: HistoryVisibility;
    canEditName: boolean;
    canEditTopic: boolean;
    canEditAvatar: boolean;
    canEditJoinRule: boolean;
    canEditHistory: boolean;
    canManageAliases: boolean;
    allowedSpaceIds: string[];
    parentSpaces: { id: string; name: string }[];
    supportsRestricted: boolean;
  }> = {},
  over: {
    setName?: Mock;
    setTopic?: Mock;
    setAvatar?: Mock;
    setJoinRule?: Mock;
    setHistoryVisibility?: Mock;
  } = {},
) {
  const setName = over.setName ?? vi.fn(() => of(undefined));
  const setTopic = over.setTopic ?? vi.fn(() => of(undefined));
  const setAvatar = over.setAvatar ?? vi.fn(() => of(undefined));
  const setJoinRule = over.setJoinRule ?? vi.fn(() => of(undefined));
  const setHistoryVisibility =
    over.setHistoryVisibility ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
  const widgets = signal([]);
  const canManageWidgets = signal(false);
  const { fixture, container } = await render(RoomSettingsComponent, {
    inputs: {
      roomId: '!r:hs',
      name: '',
      topic: '',
      canEditName: true,
      canEditTopic: true,
      canEditAvatar: true,
      ...inputs,
    },
    providers: [
      MockProvider(RoomSettingsService, {
        setName,
        setTopic,
        setAvatar,
        setJoinRule,
        setHistoryVisibility,
      }),
      MockProvider(RoomModerationService, {
        bannedMembers: () => [],
        unban: () => of(undefined),
      }),
      MockProvider(RoomAliasesService, {
        serverName: () => 'hs',
        currentCanonical: () => null,
        localAliases: () => of([]),
      }),
      MockProvider(WidgetsService, {
        widgetsFor: () => widgets.asReadonly(),
        canManageFor: () => canManageWidgets.asReadonly(),
        launchFor: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      MockProvider(ExternalBrowserService, { open: () => of(true) }),
      MockProvider(WidgetManagementService),
      MockProvider(TrnAlertService),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    fixture,
    setName,
    setTopic,
    setAvatar,
    setJoinRule,
    setHistoryVisibility,
    close,
    toastShow,
  };
}

/** A synthetic file-input change event carrying `file` (or none). */
describe('RoomSettingsComponent', () => {
  it('offers restricted only when the room sits in a space', async () => {
    const withSpace = await build({
      parentSpaces: [{ id: '!s:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    expect(withSpace.cmp.joinRuleOptions().map((o) => o.value)).toContain(
      JoinRule.Restricted,
    );
  });

  it('hides restricted for a spaceless room — nobody could join it', async () => {
    const { cmp } = await build({
      parentSpaces: [],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    expect(cmp.joinRuleOptions().map((o) => o.value)).not.toContain(
      JoinRule.Restricted,
    );
  });

  it('hides restricted in a room too old to enforce it', async () => {
    // Room version < 8 accepts the rule and enforces nothing, leaving the room as open as
    // it was — a silent no-op is worse than not offering the choice.
    const { cmp } = await build({
      parentSpaces: [{ id: '!s:hs', name: 'Design' }],
      supportsRestricted: false,
      canEditJoinRule: true,
    });

    expect(cmp.joinRuleOptions().map((o) => o.value)).not.toContain(
      JoinRule.Restricted,
    );
  });

  it('does not name the spaces in the restricted label', async () => {
    // The label is fixed text; the allow list is editable state. Naming spaces here would
    // state access the server may not grant the moment the two diverge.
    const { cmp } = await build({
      parentSpaces: [
        { id: '!a:hs', name: 'Design' },
        { id: '!b:hs', name: 'Eng' },
      ],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    const restricted = cmp
      .joinRuleOptions()
      .find((o) => o.value === JoinRule.Restricted);
    expect(restricted?.label).toBe('Space members can join');
  });

  it('ticks every parent space when switching into restricted', async () => {
    // Selecting "Space members can join" has to be immediately valid — an empty allow list
    // is a room nobody can join, and the service refuses to write it.
    const { cmp } = await build({
      joinRule: JoinRule.Invite,
      parentSpaces: [
        { id: '!a:hs', name: 'Design' },
        { id: '!b:hs', name: 'Eng' },
      ],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    expect(cmp.isSpaceChecked('!a:hs')).toBe(true);
    expect(cmp.isSpaceChecked('!b:hs')).toBe(true);
  });

  it('ticks only the already-allowed spaces for a restricted room', async () => {
    // The room is in two spaces but only A can join. The dialog has to show that, not the
    // access it could have.
    const { cmp } = await build({
      joinRule: JoinRule.Restricted,
      allowedSpaceIds: ['!a:hs'],
      parentSpaces: [
        { id: '!a:hs', name: 'Design' },
        { id: '!b:hs', name: 'Eng' },
      ],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    expect(cmp.isSpaceChecked('!a:hs')).toBe(true);
    expect(cmp.isSpaceChecked('!b:hs')).toBe(false);
  });

  it('sends the allow list when restricting the room', async () => {
    const { cmp, setJoinRule } = await build({
      parentSpaces: [{ id: '!s:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
      joinRule: JoinRule.Invite,
    });
    cmp.form.joinRule().value.set(JoinRule.Restricted);

    cmp.save();

    // A restricted write that dropped `allow` is exactly the failure that locks a room.
    expect(setJoinRule).toHaveBeenCalledWith('!r:hs', JoinRule.Restricted, [
      '!s:hs',
    ]);
  });

  it('keeps allow entries it did not add', async () => {
    // An existing entry may name a space this viewer cannot see; dropping it would revoke
    // its members' access as a side effect of an unrelated save.
    const { cmp, setJoinRule } = await build({
      allowedSpaceIds: ['!unknown:hs'],
      parentSpaces: [{ id: '!s:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
      joinRule: JoinRule.Invite,
    });
    cmp.form.joinRule().value.set(JoinRule.Restricted);

    cmp.save();

    expect(setJoinRule).toHaveBeenCalledWith('!r:hs', JoinRule.Restricted, [
      '!unknown:hs',
      '!s:hs',
    ]);
  });

  it('lets a newly-linked space in when its box is ticked', async () => {
    // The room was already restricted to A and has since been linked into B. This is the
    // action that had no reachable path before: re-picking an already-selected <select>
    // option fires no change event, so nothing was ever written.
    const { cmp, setJoinRule } = await build({
      joinRule: JoinRule.Restricted,
      allowedSpaceIds: ['!a:hs'],
      parentSpaces: [
        { id: '!a:hs', name: 'Design' },
        { id: '!b:hs', name: 'Eng' },
      ],
      supportsRestricted: true,
      canEditJoinRule: true,
    });
    cmp.toggleSpace('!b:hs', true);

    cmp.save();

    expect(setJoinRule).toHaveBeenCalledWith('!r:hs', JoinRule.Restricted, [
      '!a:hs',
      '!b:hs',
    ]);
  });

  it('revokes a space when its box is unticked', async () => {
    const { cmp, setJoinRule } = await build({
      joinRule: JoinRule.Restricted,
      allowedSpaceIds: ['!a:hs', '!b:hs'],
      parentSpaces: [
        { id: '!a:hs', name: 'Design' },
        { id: '!b:hs', name: 'Eng' },
      ],
      supportsRestricted: true,
      canEditJoinRule: true,
    });
    cmp.toggleSpace('!b:hs', false);

    cmp.save();

    expect(setJoinRule).toHaveBeenCalledWith('!r:hs', JoinRule.Restricted, [
      '!a:hs',
    ]);
  });

  it('blocks Save when a restricted room has no space ticked', async () => {
    // Writing this would be a room nobody can join and only an admin could reopen.
    const { cmp } = await build({
      joinRule: JoinRule.Restricted,
      allowedSpaceIds: ['!a:hs'],
      parentSpaces: [{ id: '!a:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
    });
    expect(cmp.noSpaceChosen()).toBe(false);

    cmp.toggleSpace('!a:hs', false);

    expect(cmp.noSpaceChosen()).toBe(true);
  });

  it('hides the space choices unless restricted is the selected rule', async () => {
    const { cmp } = await build({
      joinRule: JoinRule.Invite,
      parentSpaces: [{ id: '!a:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    expect(cmp.showSpaceChoices()).toBe(false);

    cmp.form.joinRule().value.set(JoinRule.Restricted);
    expect(cmp.showSpaceChoices()).toBe(true);
  });

  it('does not widen who can join when only an unrelated field was edited', async () => {
    // The room is restricted to space A and has since been linked into space B. Editing
    // the TOPIC must not hand every member of B the right to join a room they were never
    // allowed into — an access change has to be one the user actually made.
    const { cmp, setJoinRule, setTopic } = await build({
      topic: 'old',
      joinRule: JoinRule.Restricted,
      allowedSpaceIds: ['!a:hs'],
      parentSpaces: [
        { id: '!a:hs', name: 'Design' },
        { id: '!b:hs', name: 'Eng' },
      ],
      supportsRestricted: true,
      canEditJoinRule: true,
    });
    cmp.form.topic().value.set('new');

    cmp.save();

    expect(setTopic).toHaveBeenCalledWith('!r:hs', 'new');
    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('keeps a rule it would not otherwise offer, rather than rendering blank', async () => {
    // parentSpaceIds only sees spaces this user has JOINED, so an admin who is not in the
    // allowed space gets no restricted option — and a <select> seeded with a value it has
    // no option for shows nothing at all, misrepresenting the room's access.
    const { cmp } = await build({
      joinRule: JoinRule.Restricted,
      parentSpaces: [],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    expect(cmp.joinRuleOptions().map((o) => o.value)).toContain(
      JoinRule.Restricted,
    );
  });

  it('does not re-write an unchanged restricted rule', async () => {
    const { cmp, setJoinRule, close } = await build({
      joinRule: JoinRule.Restricted,
      allowedSpaceIds: ['!a:hs'],
      parentSpaces: [{ id: '!a:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
    });

    cmp.save();

    expect(setJoinRule).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('seeds the form from the current name and topic', async () => {
    const { cmp } = await build({ name: 'General', topic: 'The topic' });
    expect(cmp.form.name().value()).toBe('General');
    expect(cmp.form.topic().value()).toBe('The topic');
  });

  it('renames the room and closes resolving true on save', async () => {
    const { cmp, setName, close } = await build({ name: 'Old', topic: 'T' });
    cmp.form.name().value.set('New name');

    cmp.save();

    expect(setName).toHaveBeenCalledWith('!r:hs', 'New name');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('updates the topic on save', async () => {
    const { cmp, setTopic, close } = await build({ name: 'N', topic: 'old' });
    cmp.form.topic().value.set('new topic');

    cmp.save();

    expect(setTopic).toHaveBeenCalledWith('!r:hs', 'new topic');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('clears the topic on save when emptied (unlike the name)', async () => {
    const { cmp, setTopic, close } = await build({ name: 'N', topic: 'old' });
    cmp.form.topic().value.set('');

    cmp.save();

    expect(setTopic).toHaveBeenCalledWith('!r:hs', '');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('writes nothing and closes false when nothing changed', async () => {
    const { cmp, setName, setTopic, close } = await build({
      name: 'Same',
      topic: 'T',
    });

    cmp.save();

    expect(setName).not.toHaveBeenCalled();
    expect(setTopic).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('disables a field the user cannot edit and never writes it', async () => {
    const { cmp, setName } = await build({ name: 'N', canEditName: false });
    expect(cmp.form.name().disabled()).toBe(true);

    cmp.form.name().value.set('Attempted');
    cmp.save();

    expect(setName).not.toHaveBeenCalled();
  });

  it('seeds the join rule and history visibility from the current state', async () => {
    const { cmp } = await build({
      joinRule: JoinRule.Public,
      historyVisibility: HistoryVisibility.WorldReadable,
      canEditJoinRule: true,
      canEditHistory: true,
    });
    expect(cmp.form.joinRule().value()).toBe(JoinRule.Public);
    expect(cmp.form.historyVisibility().value()).toBe(
      HistoryVisibility.WorldReadable,
    );
  });

  it('writes a changed join rule and history visibility on save', async () => {
    const { cmp, setJoinRule, setHistoryVisibility, close } = await build({
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      canEditJoinRule: true,
      canEditHistory: true,
    });
    cmp.form.joinRule().value.set(JoinRule.Public);
    cmp.form.historyVisibility().value.set(HistoryVisibility.Joined);

    cmp.save();

    expect(setJoinRule).toHaveBeenCalledWith('!r:hs', JoinRule.Public, []);
    expect(setHistoryVisibility).toHaveBeenCalledWith(
      '!r:hs',
      HistoryVisibility.Joined,
    );
    expect(close).toHaveBeenCalledWith(true);
  });

  it('keeps the ban list readable when the viewer cannot unban', async () => {
    const { container } = await build();
    expect(
      container.querySelector('[data-testid=banned-members]'),
    ).not.toBeNull();
  });

  it('shows the banned-members section when the viewer can manage bans', async () => {
    const { container } = await build();
    expect(
      container.querySelector('[data-testid=banned-members]'),
    ).not.toBeNull();
  });

  it('splits the dialog into General, Access, Widgets, and Bans', async () => {
    const { cmp, container } = await build();

    expect(cmp.settingsTabs().map((tab) => tab.value)).toEqual([
      'general',
      'access',
      'widgets',
      'bans',
    ]);
    expect(
      container.querySelector('[data-testid=room-settings-tab-bans]'),
    ).not.toBeNull();
  });

  it('keeps the Bans tab when the viewer can manage bans', async () => {
    const { cmp, container } = await build();

    expect(cmp.settingsTabs().map((tab) => tab.value)).toEqual([
      'general',
      'access',
      'widgets',
      'bans',
    ]);
    expect(
      container.querySelector('[data-testid=room-settings-tab-bans]'),
    ).not.toBeNull();
  });

  it('puts each field on the panel its tab names', async () => {
    // The panels are eager and an inactive one is only `hidden`, so a query over the whole
    // dialog finds every field either way. Asserting CONTAINMENT is what tells a real split
    // from markup that merely gained some tab chrome.
    const { container } = await build({
      canManageAliases: true,
    });
    const panel = (name: string) =>
      container.querySelector(`[data-testid=room-settings-panel-${name}]`)!;
    const holds = (name: string, testId: string) =>
      panel(name).querySelector(`[data-testid=${testId}]`) !== null;

    expect(holds('general', 'room-settings-name')).toBe(true);
    expect(holds('general', 'room-settings-topic')).toBe(true);
    expect(holds('access', 'room-settings-join-rule')).toBe(true);
    expect(holds('access', 'room-settings-history')).toBe(true);
    expect(holds('access', 'room-aliases')).toBe(true);
    expect(holds('bans', 'banned-members')).toBe(true);
    // And not the other way round, which is the half a containment check usually forgets.
    expect(holds('general', 'room-settings-join-rule')).toBe(false);
    expect(holds('access', 'room-settings-name')).toBe(false);
  });

  it('keeps Save and Cancel outside the tabs, always reachable', async () => {
    // The panels are eager precisely so one form spans them; the actions must not sit on a
    // panel, or saving would depend on which tab happened to be open.
    const { container } = await build();
    const inAnyPanel = (testId: string) =>
      [
        ...container.querySelectorAll('[data-testid^=room-settings-panel-]'),
      ].some(
        (panel) => panel.querySelector(`[data-testid=${testId}]`) !== null,
      );

    expect(
      container.querySelector('[data-testid=room-settings-save]'),
    ).not.toBeNull();
    expect(inAnyPanel('room-settings-save')).toBe(false);
    expect(inAnyPanel('room-settings-cancel')).toBe(false);
  });

  it('says why Save is off when the field that blocks it is on another tab', async () => {
    const { cmp, container, fixture } = await build({
      parentSpaces: [{ id: '!s:hs', name: 'Design' }],
      supportsRestricted: true,
      canEditJoinRule: true,
    });
    expect(
      container.querySelector('[data-testid=room-settings-blocked]'),
    ).toBeNull();

    cmp.form.joinRule().value.set(JoinRule.Restricted);
    cmp.toggleSpace('!s:hs', false);
    expect(cmp.noSpaceChosen()).toBe(true);
    fixture.detectChanges();
    expect(
      container.querySelector('[data-testid=room-settings-blocked]'),
    ).not.toBeNull();
  });

  it('shows the addresses section only when the viewer can manage aliases', async () => {
    const { container } = await build({ canManageAliases: true });
    expect(
      container.querySelector('[data-testid=room-aliases]'),
    ).not.toBeNull();
  });

  it('disables the access controls and never writes them when not permitted', async () => {
    const { cmp, setJoinRule, setHistoryVisibility } = await build({
      joinRule: JoinRule.Invite,
      canEditJoinRule: false,
      canEditHistory: false,
    });
    expect(cmp.form.joinRule().disabled()).toBe(true);
    expect(cmp.form.historyVisibility().disabled()).toBe(true);

    cmp.form.joinRule().value.set(JoinRule.Public);
    cmp.save();

    expect(setJoinRule).not.toHaveBeenCalled();
    expect(setHistoryVisibility).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and toasts on a write failure', async () => {
    const setName = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, close, toastShow } = await build({ name: 'Old' }, { setName });
    cmp.form.name().value.set('New');

    cmp.save();

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
    expect(close).not.toHaveBeenCalledWith(true);
  });

  it('reports a partial failure accurately and stays open', async () => {
    const setTopic = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, close, toastShow } = await build(
      { name: 'Old', topic: 'oldT' },
      { setTopic },
    );
    cmp.form.name().value.set('New');
    cmp.form.topic().value.set('newT');

    cmp.save();

    // Name saved, topic failed → the toast names both, and the dialog stays open.
    const [message, options] = toastShow.mock.calls[0];
    expect(message).toContain('name');
    expect(message).toContain('topic');
    expect(options).toMatchObject({ variant: 'destructive' });
    expect(close).not.toHaveBeenCalledWith(true);
  });
});
