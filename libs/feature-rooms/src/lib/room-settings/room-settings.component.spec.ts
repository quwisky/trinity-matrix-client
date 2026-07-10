import { render } from '@testing-library/angular';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  RoomAliasesService,
  RoomModerationService,
  RoomSettingsService,
} from '@trinity/data-access-rooms';
import { HistoryVisibility, JoinRule } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
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
    canManageBans: boolean;
    canManageAliases: boolean;
  }> = {},
  over: {
    setName?: ReturnType<typeof vi.fn>;
    setTopic?: ReturnType<typeof vi.fn>;
    setAvatar?: ReturnType<typeof vi.fn>;
    setJoinRule?: ReturnType<typeof vi.fn>;
    setHistoryVisibility?: ReturnType<typeof vi.fn>;
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
      MockProvider(DialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
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
function pickEvent(file?: File): Event {
  return {
    target: { files: file ? [file] : [], value: '' },
  } as unknown as Event;
}

describe('RoomSettingsComponent', () => {
  it('seeds the form from the current name and topic', async () => {
    const { cmp } = await build({ name: 'General', topic: 'The topic' });
    expect(cmp.form.controls.name.value).toBe('General');
    expect(cmp.form.controls.topic.value).toBe('The topic');
  });

  it('renames the room and closes resolving true on save', async () => {
    const { cmp, setName, close } = await build({ name: 'Old', topic: 'T' });
    cmp.form.controls.name.setValue('New name');

    cmp.save();

    expect(setName).toHaveBeenCalledWith('!r:hs', 'New name');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('updates the topic on save', async () => {
    const { cmp, setTopic, close } = await build({ name: 'N', topic: 'old' });
    cmp.form.controls.topic.setValue('new topic');

    cmp.save();

    expect(setTopic).toHaveBeenCalledWith('!r:hs', 'new topic');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('clears the topic on save when emptied (unlike the name)', async () => {
    const { cmp, setTopic, close } = await build({ name: 'N', topic: 'old' });
    cmp.form.controls.topic.setValue('');

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
    expect(cmp.form.controls.name.disabled).toBe(true);

    cmp.form.controls.name.setValue('Attempted');
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
    expect(cmp.form.controls.joinRule.value).toBe(JoinRule.Public);
    expect(cmp.form.controls.historyVisibility.value).toBe(
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
    cmp.form.controls.joinRule.setValue(JoinRule.Public);
    cmp.form.controls.historyVisibility.setValue(HistoryVisibility.Joined);

    cmp.save();

    expect(setJoinRule).toHaveBeenCalledWith('!r:hs', JoinRule.Public);
    expect(setHistoryVisibility).toHaveBeenCalledWith(
      '!r:hs',
      HistoryVisibility.Joined,
    );
    expect(close).toHaveBeenCalledWith(true);
  });

  it('hides the banned-members section when the viewer cannot manage bans', async () => {
    const { container } = await build({ canManageBans: false });
    expect(container.querySelector('[data-testid=banned-members]')).toBeNull();
  });

  it('shows the banned-members section when the viewer can manage bans', async () => {
    const { container } = await build({ canManageBans: true });
    expect(
      container.querySelector('[data-testid=banned-members]'),
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
    expect(cmp.form.controls.joinRule.disabled).toBe(true);
    expect(cmp.form.controls.historyVisibility.disabled).toBe(true);

    cmp.form.controls.joinRule.setValue(JoinRule.Public);
    cmp.save();

    expect(setJoinRule).not.toHaveBeenCalled();
    expect(setHistoryVisibility).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and toasts on a write failure', async () => {
    const setName = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, close, toastShow } = await build({ name: 'Old' }, { setName });
    cmp.form.controls.name.setValue('New');

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
    cmp.form.controls.name.setValue('New');
    cmp.form.controls.topic.setValue('newT');

    cmp.save();

    // Name saved, topic failed → the toast names both, and the dialog stays open.
    const [message, options] = toastShow.mock.calls[0];
    expect(message).toContain('name');
    expect(message).toContain('topic');
    expect(options).toMatchObject({ variant: 'destructive' });
    expect(close).not.toHaveBeenCalledWith(true);
  });

  it('uploads a picked image as the room avatar', async () => {
    const { cmp, setAvatar, toastShow } = await build();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    cmp.onAvatarPicked(pickEvent(file));

    expect(setAvatar).toHaveBeenCalledWith('!r:hs', file);
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('rejects a non-image file without uploading', async () => {
    const { cmp, setAvatar, toastShow } = await build();
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });

    cmp.onAvatarPicked(pickEvent(file));

    expect(setAvatar).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('rejects an image larger than 8 MB without uploading', async () => {
    const { cmp, setAvatar, toastShow } = await build();
    const file = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 8 * 1024 * 1024 + 1 });

    cmp.onAvatarPicked(pickEvent(file));

    expect(setAvatar).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
