import { render } from '@testing-library/angular';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { RoomSettingsService } from '@trinity/data-access-rooms';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomSettingsComponent } from './room-settings.component';

async function build(
  inputs: Partial<{
    name: string;
    topic: string;
    canEditName: boolean;
    canEditTopic: boolean;
  }> = {},
  over: { setName?: ReturnType<typeof vi.fn> } = {},
) {
  const setName = over.setName ?? vi.fn(() => of(undefined));
  const setTopic = vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
  const { fixture } = await render(RoomSettingsComponent, {
    inputs: {
      roomId: '!r:hs',
      name: '',
      topic: '',
      canEditName: true,
      canEditTopic: true,
      ...inputs,
    },
    providers: [
      MockProvider(RoomSettingsService, { setName, setTopic }),
      MockProvider(DialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    setName,
    setTopic,
    close,
    toastShow,
  };
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
});
