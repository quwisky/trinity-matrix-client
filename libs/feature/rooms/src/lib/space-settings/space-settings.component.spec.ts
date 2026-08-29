import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import {
  RoomAliasesService,
  RoomActionPermissionsService,
  RoomModerationService,
  RoomSettingsService,
} from '@trinity/data-access/rooms';
import { JoinRule } from '@trinity/data-access/rooms';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { SpaceSettingsComponent } from './space-settings.component';

async function build(
  inputs: Partial<{
    name: string;
    topic: string;
    joinRule: JoinRule;
    canEditName: boolean;
    canEditTopic: boolean;
    canEditAvatar: boolean;
    canEditJoinRule: boolean;
    canManageAliases: boolean;
  }> = {},
  over: {
    setName?: Mock;
    setTopic?: Mock;
    setJoinRule?: Mock;
    settingsPermissions?: Mock;
  } = {},
) {
  const setName = over.setName ?? vi.fn(() => of(undefined));
  const setTopic = over.setTopic ?? vi.fn(() => of(undefined));
  const setJoinRule = over.setJoinRule ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
  const availability = (allowed: boolean) => ({
    available: allowed,
    reason: allowed ? null : 'Not allowed.',
  });
  const settingsPermissions =
    over.settingsPermissions ??
    vi.fn(() => ({
      name: availability(inputs.canEditName ?? true),
      topic: availability(inputs.canEditTopic ?? true),
      avatar: availability(inputs.canEditAvatar ?? true),
      joinRule: availability(inputs.canEditJoinRule ?? false),
      history: availability(false),
      aliases: availability(inputs.canManageAliases ?? false),
    }));
  const { fixture, container } = await render(SpaceSettingsComponent, {
    inputs: {
      spaceId: '!space:hs',
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
        setJoinRule,
        setAvatar: vi.fn(() => of(undefined)),
      }),
      MockProvider(RoomActionPermissionsService, {
        settings: settingsPermissions,
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
    setJoinRule,
    close,
    toastShow,
  };
}

describe('SpaceSettingsComponent', () => {
  it('disables fields and Save when permission changes while open', async () => {
    const allowed = signal(true);
    const permission = () => ({
      available: allowed(),
      reason: allowed() ? null : 'Not allowed.',
    });
    const { container, fixture } = await build(
      { name: 'N' },
      {
        settingsPermissions: vi.fn(() => ({
          name: permission(),
          topic: permission(),
          avatar: permission(),
          joinRule: permission(),
          history: permission(),
          aliases: permission(),
        })),
      },
    );
    const name = container.querySelector<HTMLInputElement>(
      '[data-testid="space-settings-name"]',
    )!;
    const save = container.querySelector<HTMLElement>(
      '[data-testid="space-settings-save"]',
    )!;
    expect(name.disabled).toBe(false);

    allowed.set(false);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(name.disabled).toBe(true);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(
      container.querySelector('[data-testid="space-aliases-unavailable"]'),
    ).not.toBeNull();
  });

  it('seeds the form from the current name, topic and join rule', async () => {
    const { cmp } = await build({
      name: 'Design',
      topic: 'Where design happens',
      joinRule: JoinRule.Public,
      canEditJoinRule: true,
    });

    expect(cmp.form.name().value()).toBe('Design');
    expect(cmp.form.topic().value()).toBe('Where design happens');
    expect(cmp.form.joinRule().value()).toBe(JoinRule.Public);
  });

  it('renames the space and closes resolving true on save', async () => {
    const { cmp, setName, close } = await build({ name: 'Old', topic: 'T' });
    cmp.form.name().value.set('New name');

    cmp.save();

    expect(setName).toHaveBeenCalledWith('!space:hs', 'New name');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('writes the topic, including clearing it', async () => {
    // The name guard below is deliberately not applied to the topic: a space with no topic
    // is ordinary, a space with no name is not.
    const { cmp, setTopic } = await build({ name: 'N', topic: 'old topic' });
    cmp.form.topic().value.set('');

    cmp.save();

    expect(setTopic).toHaveBeenCalledWith('!space:hs', '');
  });

  it('never blanks the name, even if the field is emptied', async () => {
    const { cmp, setName, close } = await build({ name: 'Design', topic: '' });
    cmp.form.name().value.set('   ');

    cmp.save();

    expect(setName).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('writes only the fields that actually changed', async () => {
    const { cmp, setName, setTopic, setJoinRule } = await build({
      name: 'Design',
      topic: 'T',
      joinRule: JoinRule.Invite,
      canEditJoinRule: true,
    });
    cmp.form.topic().value.set('T2');

    cmp.save();

    expect(setTopic).toHaveBeenCalledWith('!space:hs', 'T2');
    expect(setName).not.toHaveBeenCalled();
    expect(setJoinRule).not.toHaveBeenCalled();
  });

  it('publishes the space by changing its join rule', async () => {
    const { cmp, setJoinRule } = await build({
      name: 'Design',
      joinRule: JoinRule.Invite,
      canEditJoinRule: true,
    });
    cmp.form.joinRule().value.set(JoinRule.Public);

    cmp.save();

    expect(setJoinRule).toHaveBeenCalledWith('!space:hs', JoinRule.Public);
  });

  it('closes without writing when nothing changed', async () => {
    const { cmp, setName, setTopic, close } = await build({
      name: 'Design',
      topic: 'T',
    });

    cmp.save();

    expect(setName).not.toHaveBeenCalled();
    expect(setTopic).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and names both halves of a partial failure', async () => {
    const { cmp, close, toastShow } = await build(
      { name: 'Design', topic: 'T' },
      { setTopic: vi.fn(() => throwError(() => new Error('forbidden'))) },
    );
    cmp.form.name().value.set('Design 2');
    cmp.form.topic().value.set('T2');

    cmp.save();

    expect(close).not.toHaveBeenCalled();
    expect(cmp.saving()).toBe(false);
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('topic'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('disables the fields the viewer cannot change', async () => {
    const { cmp } = await build({
      name: 'Design',
      canEditName: false,
      canEditTopic: false,
      canEditJoinRule: false,
    });

    expect(cmp.form.name().disabled()).toBe(true);
    expect(cmp.form.topic().disabled()).toBe(true);
    expect(cmp.form.joinRule().disabled()).toBe(true);
  });

  it('does not offer restricted as a space join rule', async () => {
    // A space gated on membership of another space is a shape this client can neither
    // create nor navigate — see the comment on JOIN_RULE_OPTIONS.
    const { cmp } = await build();

    expect(cmp.joinRuleOptions().map((o) => o.value)).toEqual([
      JoinRule.Invite,
      JoinRule.Public,
    ]);
  });

  it('shows a rule it does not offer rather than rendering blank', async () => {
    // A <select> seeded with a value it has no option for shows NO setting at all, which
    // misrepresents the space — and then any pick silently changes who can join it.
    const { cmp } = await build({ joinRule: JoinRule.Knock });

    const values = cmp.joinRuleOptions().map((o) => o.value);
    expect(values).toContain(JoinRule.Knock);
    expect(
      cmp.joinRuleOptions().find((o) => o.value === JoinRule.Knock)?.label,
    ).toBe('Anyone can ask to join');
  });

  it('does not duplicate a rule it already offers', async () => {
    const { cmp } = await build({ joinRule: JoinRule.Public });

    expect(cmp.joinRuleOptions().map((o) => o.value)).toEqual([
      JoinRule.Invite,
      JoinRule.Public,
    ]);
  });

  it('disables Save when no field this dialog has is editable', async () => {
    // The room dialog's canSave() also counts canEditHistory; copying it here would light
    // Save up for a field this dialog does not have.
    const { cmp } = await build({
      canEditName: false,
      canEditTopic: false,
      canEditJoinRule: false,
    });

    expect(cmp.canSave()).toBe(false);
  });

  it('keeps Save alive when a single field is editable', async () => {
    const { cmp } = await build({
      canEditName: false,
      canEditTopic: true,
      canEditJoinRule: false,
    });

    expect(cmp.canSave()).toBe(true);
  });

  it('keeps bans readable but hides addresses the viewer cannot manage', async () => {
    const { container } = await build({
      canManageAliases: false,
    });

    expect(container.querySelector('trn-banned-members')).not.toBeNull();
    expect(container.querySelector('trn-room-aliases')).toBeNull();
  });

  it('offers no history visibility — a space has no timeline to hide', async () => {
    const { container } = await build();

    expect(
      container.querySelector('[data-testid="space-settings-history"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="space-settings-join-rule"]'),
    ).not.toBeNull();
  });

  it('splits the dialog into General, Access, and Bans', async () => {
    const { cmp, container } = await build();

    expect(cmp.settingsTabs().map((tab) => tab.value)).toEqual([
      'general',
      'access',
      'bans',
    ]);
    expect(
      container.querySelector('[data-testid=space-settings-tab-bans]'),
    ).not.toBeNull();
  });

  it('keeps the Bans tab when the viewer can manage bans', async () => {
    const { cmp, container } = await build();

    expect(cmp.settingsTabs().map((tab) => tab.value)).toEqual([
      'general',
      'access',
      'bans',
    ]);
    expect(
      container.querySelector('[data-testid=space-settings-tab-bans]'),
    ).not.toBeNull();
  });

  it('puts each field on the panel its tab names', async () => {
    // Eager panels mean an inactive one is only `hidden`, so a dialog-wide query finds every
    // field either way; containment is what distinguishes a real split from added chrome.
    const { container } = await build({
      canManageAliases: true,
    });
    const panel = (name: string) =>
      container.querySelector(`[data-testid=space-settings-panel-${name}]`)!;
    const holds = (name: string, testId: string) =>
      panel(name).querySelector(`[data-testid=${testId}]`) !== null;

    expect(holds('general', 'space-settings-name')).toBe(true);
    expect(holds('general', 'space-settings-topic')).toBe(true);
    expect(holds('access', 'space-settings-join-rule')).toBe(true);
    expect(holds('access', 'room-aliases')).toBe(true);
    expect(holds('bans', 'banned-members')).toBe(true);
    expect(holds('general', 'space-settings-join-rule')).toBe(false);
    expect(holds('access', 'space-settings-name')).toBe(false);
  });

  it('closes resolving false on cancel', async () => {
    const { cmp, close } = await build();

    cmp.close();

    expect(close).toHaveBeenCalledWith(false);
  });
});
