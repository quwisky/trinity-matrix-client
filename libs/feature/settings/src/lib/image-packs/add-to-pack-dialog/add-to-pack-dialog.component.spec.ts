import { signal } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { TrnDialogRef } from '@trinity/components/overlay';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  ImagePackEditError,
  ImagePackEditorService,
  ImagePackImageError,
  MediaService,
  type AddInput,
  type PackEntry,
} from '@trinity/data-access/media';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddToPackDialogComponent } from './add-to-pack-dialog.component';

const FILE_INPUT: AddInput = {
  kind: 'file',
  file: new File(['x'], 'My Fox.png', { type: 'image/png' }),
};

const ENTRY: PackEntry = {
  shortcode: 'My_Fox',
  url: 'mxc://hs/fox',
  usage: ['emoticon'],
};

async function build(
  add: (...args: unknown[]) => Observable<PackEntry>,
  input: AddInput = FILE_INPUT,
  extra: Record<string, unknown> = {},
) {
  const addSpy = vi.fn(add);
  const close = vi.fn();
  const activeUserId = signal<string | null>('@me:hs');
  const rendered = await render(AddToPackDialogComponent, {
    inputs: { input, suggestedName: 'My Fox.png', ...extra },
    providers: [
      MockProvider(ImagePackEditorService, { add: addSpy }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(SessionStateService, { activeAccountId: activeUserId }),
      MockProvider(MediaService, {
        resolveMedia: () => NEVER,
        pin: vi.fn(),
        unpin: vi.fn(),
      }),
    ],
  });
  const byTestId = (id: string) =>
    rendered.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = () => rendered.fixture.detectChanges();
  const submit = () => {
    byTestId('add-to-pack-confirm')!.click();
    settle();
  };
  return {
    ...rendered,
    add: addSpy,
    close,
    activeUserId,
    byTestId,
    settle,
    submit,
  };
}

describe('AddToPackDialogComponent', () => {
  // jsdom has no object URLs.
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  it('prefills the shortcode from the sanitised name', async () => {
    await build(() => NEVER);
    expect(screen.getByLabelText('Shortcode')).toHaveValue('My_Fox');
  });

  it('shows the clash error inline and keeps the dialog open', async () => {
    const view = await build(() =>
      throwError(() => new ImagePackEditError('shortcode-taken')),
    );
    view.submit();
    expect(view.byTestId('add-to-pack-shortcode-error')).toHaveTextContent(
      'You already have :My_Fox:. Choose another shortcode.',
    );
    expect(view.close).not.toHaveBeenCalled();
  });

  it('shows the animated-too-large and server-limit messages', async () => {
    const errors: unknown[] = [
      new ImagePackImageError('animated-too-large'),
      new ImagePackEditError('too-large-for-server', 8),
    ];
    const view = await build(() => throwError(() => errors.shift()));
    view.submit();
    expect(view.byTestId('add-to-pack-error')).toHaveTextContent(
      'This animated image is too large (max 1 MB).',
    );
    view.submit();
    expect(view.byTestId('add-to-pack-error')).toHaveTextContent(
      'This image is larger than your server allows (max 8 MB).',
    );
  });

  it('Try again re-runs add with the same input', async () => {
    let calls = 0;
    const view = await build(() =>
      calls++ === 0 ? throwError(() => new Error('offline')) : of(ENTRY),
    );
    view.submit();
    screen.getByRole('button', { name: 'Try again' }).click();
    view.settle();
    expect(view.add).toHaveBeenCalledTimes(2);
    expect(view.add.mock.calls[1]).toEqual(view.add.mock.calls[0]);
    expect(view.add.mock.calls[1][0]).toBe(FILE_INPUT);
    expect(view.close).toHaveBeenCalledWith(ENTRY);
  });

  it('Use as defaults to Emoji', async () => {
    const view = await build(() => of(ENTRY));
    expect(screen.getByRole('radio', { name: 'Emoji' })).toBeChecked();
    view.submit();
    expect(view.add).toHaveBeenCalledWith(FILE_INPUT, 'My_Fox', ['emoticon'], {
      kind: 'personal',
    });
    expect(view.close).toHaveBeenCalledWith(ENTRY);
  });

  it('announces progress and errors in a live region', async () => {
    const result = new Subject<PackEntry>();
    const view = await build(() => result);
    view.submit();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Adding to your emoji…',
    );
    result.error(new ImagePackEditError('pack-full'));
    view.settle();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your emoji pack is full.',
    );
  });

  it('closes without writing when the active account changes while idle', async () => {
    const view = await build(() => of(ENTRY));
    view.activeUserId.set('@other:hs');
    view.settle();
    expect(view.close).toHaveBeenCalledWith(null);
    expect(view.add).not.toHaveBeenCalled();
  });

  it('stays open for a room on its own account when the active account changes', async () => {
    const ref = { kind: 'room', accountId: '@me:hs', roomId: '!r:hs' };
    const view = await build(() => of(ENTRY), FILE_INPUT, { ref });
    view.activeUserId.set('@other:hs');
    view.settle();
    expect(view.close).not.toHaveBeenCalled();
  });

  it('cannot be dismissed while an add runs', async () => {
    const result = new Subject<PackEntry>();
    const view = await build(() => result);
    const dialog = view.fixture.componentInstance;
    expect(dialog.canDismiss()).toBe(true);
    view.submit();
    expect(dialog.canDismiss()).toBe(false);
    result.error(new Error('offline'));
    view.settle();
    expect(dialog.canDismiss()).toBe(true);
  });

  it("adds to a room's pack with the room's copy", async () => {
    const ref = { kind: 'room', accountId: '@me:hs', roomId: '!r:hs' };
    const view = await build(() => of(ENTRY), FILE_INPUT, { ref });
    expect(screen.getByText('Add to room emoji')).toBeInTheDocument();
    view.submit();
    expect(view.add).toHaveBeenCalledWith(
      FILE_INPUT,
      'My_Fox',
      ['emoticon'],
      ref,
    );
  });

  it('words a full room pack for the room', async () => {
    const ref = { kind: 'room', accountId: '@me:hs', roomId: '!r:hs' };
    const view = await build(
      () => throwError(() => new ImagePackEditError('pack-full')),
      FILE_INPUT,
      { ref },
    );
    view.submit();
    expect(
      screen.getAllByText("This room's emoji pack is full.").length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['not-signed-in', "Sign in again to change this room's emoji."],
    ['not-allowed', "Your role can no longer change this room's emoji."],
  ] as const)(
    'words a room add that fails with %s for the room, without a retry',
    async (code, copy) => {
      const ref = { kind: 'room', accountId: '@me:hs', roomId: '!r:hs' };
      const view = await build(
        () => throwError(() => new ImagePackEditError(code)),
        FILE_INPUT,
        { ref },
      );
      view.submit();
      expect(screen.getAllByText(copy).length).toBeGreaterThan(0);
      expect(view.byTestId('add-to-pack-retry')).toBeNull();
    },
  );
});
