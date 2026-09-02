import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { RoomSettingsService } from '@trinity/data-access/room-administration';
import { TrnToastService } from '@trinity/components/overlay';
import { AvatarFieldComponent } from './avatar-field.component';

// These cases moved here verbatim from room-settings.component.spec.ts when the avatar row was
// extracted — the validation and the upload live on this component now, not on the dialog.
async function build(
  inputs: Partial<{
    name: string;
    avatarMxc: string | null;
    initial: string;
    editable: boolean;
    noun: string;
    testid: string;
    shape: 'person' | 'place';
  }> = {},
  over: { setAvatar?: Mock } = {},
) {
  const setAvatar = over.setAvatar ?? vi.fn(() => of(undefined));
  const toastShow = vi.fn();
  const { fixture, container } = await render(AvatarFieldComponent, {
    inputs: { roomId: '!r:hs', editable: true, ...inputs },
    providers: [
      MockProvider(RoomSettingsService, { setAvatar }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    setAvatar,
    toastShow,
  };
}

/** A change event carrying `file`, the shape `onAvatarPicked` reads. */
function pickEvent(file?: File): Event {
  return {
    target: { files: file ? [file] : [], value: '' },
  } as unknown as Event;
}

describe('AvatarFieldComponent', () => {
  it('uploads a picked image as the avatar', async () => {
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
      expect.objectContaining({ variant: 'danger' }),
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
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('names the surface it belongs to in its toasts', async () => {
    // The whole reason `noun` exists: the space dialog must not say "Room photo updated."
    const { cmp, toastShow } = await build({ noun: 'space' });

    cmp.onAvatarPicked(
      pickEvent(new File(['x'], 'p.png', { type: 'image/png' })),
    );

    expect(toastShow).toHaveBeenCalledWith(
      'Space photo updated.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('reports a failed upload without claiming success', async () => {
    const { cmp, toastShow } = await build(
      { noun: 'space' },
      { setAvatar: vi.fn(() => throwError(() => new Error('nope'))) },
    );

    cmp.onAvatarPicked(
      pickEvent(new File(['x'], 'p.png', { type: 'image/png' })),
    );

    expect(toastShow).toHaveBeenCalledWith(
      'Could not update the space photo.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('carries the opening dialog’s own testid, so each stays drivable', async () => {
    const { container } = await build({ testid: 'space-settings-avatar' });

    expect(
      container.querySelector('[data-testid="space-settings-avatar"]'),
    ).not.toBeNull();
  });

  it('keeps an unavailable photo action visible with an explanation', async () => {
    const { container } = await build({ editable: false });

    expect(
      container.querySelector('button')?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      container.querySelector('button')?.getAttribute('aria-description'),
    ).toContain('cannot change');
    expect(container.querySelector('trn-avatar')).not.toBeNull();
  });

  it('uses place geometry for room and space settings by default', async () => {
    const { container } = await build();

    expect(
      container.querySelector('trn-avatar')?.getAttribute('data-shape'),
    ).toBe('place');
  });

  afterEach(() => TestBed.resetTestingModule());
});
