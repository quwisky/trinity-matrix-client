import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  TrnAlertService,
  TrnSurfaceService,
  type ActionSheetData,
} from '@trinity/components/overlay';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  ImagePackEditError,
  ImagePackEditorService,
  MediaService,
  type PackEntry,
} from '@trinity/data-access/media';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AddToPackDialogComponent } from '../add-to-pack-dialog/add-to-pack-dialog.component';
import { PersonalPackComponent } from './personal-pack.component';

const FOX: PackEntry = {
  shortcode: 'fox',
  url: 'mxc://hs/fox',
  usage: ['emoticon'],
};
const LEAF: PackEntry = {
  shortcode: 'leaf',
  url: 'mxc://hs/leaf',
  usage: ['emoticon', 'sticker'],
};
const PARTY: PackEntry = {
  shortcode: 'party',
  url: 'mxc://hs/party',
  usage: ['sticker'],
};

const PERSONAL = { kind: 'personal' } as const;
const ROOM = { kind: 'room', accountId: '@a:hs', roomId: '!r:hs' } as const;

async function build(
  entries: readonly PackEntry[] | null = [FOX],
  inputs: Record<string, unknown> = {},
  roomEntries$: Observable<readonly PackEntry[]> = of(entries ?? []),
) {
  const personal = signal<readonly PackEntry[] | null>(entries);
  const entries$ = vi.fn(() => roomEntries$);
  const activeUserId = signal<string | null>('@a:hs');
  let running = 0;
  const run = vi.fn(
    () =>
      new Observable<void>(() => {
        running++;
        return () => running--;
      }),
  );
  const rename = vi.fn((): Observable<void> => of(undefined));
  const setUsage = vi.fn((): Observable<void> => of(undefined));
  const remove = vi.fn((): Observable<void> => of(undefined));
  const confirm$ = vi.fn(() => of(true));
  const dialogs: Subject<PackEntry | null>[] = [];
  const openActions = vi.fn(
    (_data: ActionSheetData, _options?: unknown) => undefined,
  );
  const openAndWait$ = vi.fn((..._args: unknown[]) => {
    const closed = new Subject<PackEntry | null>();
    dialogs.push(closed);
    return closed;
  });
  const rendered = await render(PersonalPackComponent, {
    inputs,
    providers: [
      provideTrnIcons(),
      MockProvider(ImagePackEditorService, {
        personal,
        entries$,
        run,
        rename,
        setUsage,
        remove,
      }),
      MockProvider(TrnAlertService, { confirm$ }),
      MockProvider(SessionStateService, { activeAccountId: activeUserId }),
      MockProvider(TrnSurfaceService, {
        openAndWait$: openAndWait$ as TrnSurfaceService['openAndWait$'],
        openActions: openActions as unknown as TrnSurfaceService['openActions'],
      }),
      MockProvider(MediaService, {
        resolveMedia: () => of('blob:image'),
        pin: vi.fn(),
        unpin: vi.fn(),
      }),
    ],
  });
  const byTestId = (id: string) =>
    rendered.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = () => rendered.fixture.detectChanges();
  /** Opens a tile's actions and runs the one named `text`. */
  const pick = (shortcode: string, text: string) => {
    screen.getByRole('button', { name: `:${shortcode}:` }).click();
    const button = openActions.mock.lastCall![0].buttons.find(
      (row) => row.text === text,
    );
    button!.handler!();
    settle();
  };
  return {
    ...rendered,
    personal,
    entries$,
    activeUserId,
    running: () => running,
    rename,
    setUsage,
    remove,
    confirm$,
    openAndWait$,
    dialogs,
    byTestId,
    settle,
    openActions,
    pick,
  };
}

function choose(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

const tick = () => new Promise((resolve) => setTimeout(resolve));

function type(input: HTMLElement, value: string): void {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PersonalPackComponent', () => {
  it('keeps the pack live while shown', async () => {
    const view = await build();
    expect(view.running()).toBe(1);
    view.fixture.destroy();
    expect(view.running()).toBe(0);
  });

  it('shows nothing until the pack is known', async () => {
    const view = await build(null);
    expect(view.container.textContent?.trim()).toBe('');
  });

  it('lists each image with :code: and its usage tag', async () => {
    const view = await build([FOX, LEAF, PARTY]);
    const tiles = view.container.querySelectorAll(
      '[data-testid="personal-pack-tile"]',
    );
    expect(
      [...tiles].map((tile) => tile.textContent?.replace(/\s+/g, '')),
    ).toEqual([':fox:Emoji', ':leaf:Both', ':party:Sticker']);
  });

  it('shows the empty state copy', async () => {
    await build([]);
    expect(
      screen.getByText(
        'Add images to use your own emoji and stickers in every room.',
      ),
    ).toBeTruthy();
  });

  it('Add images opens the file chooser and the dialog for each chosen file', async () => {
    const view = await build();
    const input = view.byTestId('personal-pack-files') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    screen.getByRole('button', { name: 'Add images' }).click();
    expect(click).toHaveBeenCalled();
    expect(input.multiple).toBe(true);

    const fox = new File(['x'], 'fox.png', { type: 'image/png' });
    const leaf = new File(['y'], 'leaf.webp', { type: 'image/webp' });
    choose(input, [fox, leaf]);
    expect(view.openAndWait$).toHaveBeenCalledTimes(1);
    expect(view.openAndWait$).toHaveBeenLastCalledWith(
      AddToPackDialogComponent,
      expect.objectContaining({
        inputs: {
          input: { kind: 'file', file: fox },
          suggestedName: 'fox.png',
          ref: PERSONAL,
        },
        autoFocus: '[data-autofocus]',
      }),
    );
    const options = view.openAndWait$.mock.calls[0][1] as {
      dismissGuard: (d: { canDismiss(): boolean } | null) => boolean;
    };
    expect(options.dismissGuard(null)).toBe(true);
    expect(options.dismissGuard({ canDismiss: () => false })).toBe(false);

    view.dialogs[0].next(FOX);
    view.dialogs[0].complete();
    expect(view.openAndWait$).toHaveBeenCalledTimes(2);
    expect(view.openAndWait$).toHaveBeenLastCalledWith(
      AddToPackDialogComponent,
      expect.objectContaining({
        inputs: {
          input: { kind: 'file', file: leaf },
          suggestedName: 'leaf.webp',
          ref: PERSONAL,
        },
      }),
    );
  });

  it('drops the queued files when the account changes', async () => {
    const view = await build();
    const input = view.byTestId('personal-pack-files') as HTMLInputElement;
    const fox = new File(['x'], 'fox.png', { type: 'image/png' });

    choose(input, [fox, fox, fox]);
    view.activeUserId.set('@b:hs');
    // The dialog closes itself on the switch.
    view.dialogs[0].next(null);
    view.dialogs[0].complete();

    expect(view.openAndWait$).toHaveBeenCalledOnce();
  });

  it("keeps a room's queued files when the active account changes", async () => {
    const view = await build([FOX], { ref: ROOM });
    const input = view.byTestId('personal-pack-files') as HTMLInputElement;
    const fox = new File(['x'], 'fox.png', { type: 'image/png' });

    choose(input, [fox, fox]);
    view.activeUserId.set('@b:hs');
    view.dialogs[0].next(FOX);
    view.dialogs[0].complete();

    expect(view.openAndWait$).toHaveBeenCalledTimes(2);
  });

  it('disables Add with the full-pack copy at 500', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      ...FOX,
      shortcode: `e${i}`,
    }));
    await build(full);
    expect(screen.getByRole('button', { name: 'Add images' })).toBeDisabled();
    expect(screen.getByText('Your emoji pack is full.')).toBeTruthy();
    // Rendering 500 tiles takes over 5 s on CI runners.
  }, 30_000);

  it('Delete asks "Remove :code: from your emoji?" and removes it', async () => {
    const view = await build();
    view.pick('fox', 'Delete');
    expect(view.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Remove :fox: from your emoji?',
        variant: 'danger',
      }),
    );
    expect(view.remove).toHaveBeenCalledWith('fox', PERSONAL);
  });

  it('changes how an image is used from its menu', async () => {
    const view = await build();
    view.pick('fox', 'Use as emoji and sticker');
    expect(
      view.openActions.mock.lastCall![0].buttons.map((b) => b.text),
    ).toEqual([
      'Rename shortcode',
      'Use as emoji',
      'Use as sticker',
      'Use as emoji and sticker',
      'Delete',
      'Cancel',
    ]);
    expect(view.openActions.mock.lastCall![0].buttons[1].icon).toBe('check');
    expect(view.setUsage).toHaveBeenCalledWith(
      'fox',
      ['emoticon', 'sticker'],
      PERSONAL,
    );
  });

  it('rename validates inline', async () => {
    const view = await build([FOX, LEAF]);
    view.pick('fox', 'Rename shortcode');
    const field = screen.getByLabelText(
      'New shortcode for :fox:',
    ) as HTMLInputElement;
    expect(field.value).toBe('fox');
    await tick();
    expect(document.activeElement).toBe(field);

    type(field, 'bad name');
    screen.getByRole('button', { name: 'Save' }).click();
    view.settle();
    expect(view.rename).not.toHaveBeenCalled();
    expect(view.byTestId('personal-pack-rename-error')).toHaveTextContent(
      'Use 1–100 letters, digits, underscores or hyphens.',
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');

    view.rename.mockReturnValueOnce(
      throwError(() => new ImagePackEditError('shortcode-taken')),
    );
    type(field, 'leaf');
    screen.getByRole('button', { name: 'Save' }).click();
    view.settle();
    expect(view.rename).toHaveBeenCalledWith('fox', 'leaf', PERSONAL);
    expect(view.byTestId('personal-pack-rename-error')).toHaveTextContent(
      'You already have :leaf:. Choose another shortcode.',
    );

    type(field, 'kitsune');
    screen.getByRole('button', { name: 'Save' }).click();
    view.settle();
    expect(view.rename).toHaveBeenLastCalledWith('fox', 'kitsune', PERSONAL);
    expect(screen.queryByLabelText('New shortcode for :fox:')).toBeNull();
  });

  it('announces a failed change', async () => {
    const view = await build();
    view.remove.mockReturnValueOnce(throwError(() => new Error('offline')));
    view.pick('fox', 'Delete');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t change your emoji. Try again.',
    );
  });

  it('words failed changes for the change, not for an add', async () => {
    const view = await build();
    view.remove.mockReturnValueOnce(
      throwError(() => new ImagePackEditError('not-signed-in')),
    );
    view.pick('fox', 'Delete');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sign in to change your emoji.',
    );
    view.setUsage.mockReturnValueOnce(
      throwError(() => new ImagePackEditError('invalid-usage')),
    );
    view.pick('fox', 'Use as sticker');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t change your emoji. Try again.',
    );
  });

  it('Cancel returns focus to the tile that opened rename', async () => {
    const view = await build([FOX, LEAF]);
    view.pick('leaf', 'Rename shortcode');
    await tick();
    screen.getByRole('button', { name: 'Cancel' }).click();
    view.settle();
    await tick();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: ':leaf:' }),
    );
  });

  it('Save focuses the renamed tile once it renders', async () => {
    const view = await build();
    view.pick('fox', 'Rename shortcode');
    await tick();
    type(screen.getByLabelText('New shortcode for :fox:'), 'kitsune');
    screen.getByRole('button', { name: 'Save' }).click();
    view.settle();
    await tick();
    // The echo has not arrived yet: focus waits on Add images.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Add images' }),
    );
    view.personal.set([{ ...FOX, shortcode: 'kitsune' }]);
    view.settle();
    await tick();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: ':kitsune:' }),
    );
  });

  it('a failed Save keeps focus in the field', async () => {
    const view = await build([FOX, LEAF]);
    view.rename.mockReturnValueOnce(
      throwError(() => new ImagePackEditError('shortcode-taken')),
    );
    view.pick('fox', 'Rename shortcode');
    await tick();
    const field = screen.getByLabelText('New shortcode for :fox:');
    type(field, 'leaf');
    screen.getByRole('button', { name: 'Save' }).focus();
    screen.getByRole('button', { name: 'Save' }).click();
    view.settle();
    await tick();
    expect(document.activeElement).toBe(field);
  });

  it('a double Save sends one rename', async () => {
    const view = await build();
    view.rename.mockReturnValueOnce(new Subject<void>());
    view.pick('fox', 'Rename shortcode');
    type(screen.getByLabelText('New shortcode for :fox:'), 'kitsune');
    screen.getByRole('button', { name: 'Save' }).click();
    screen.getByRole('button', { name: 'Save' }).click();
    expect(view.rename).toHaveBeenCalledTimes(1);
  });

  it('shows an image added after the first render', async () => {
    const view = await build([FOX]);
    view.personal.set([FOX, LEAF]);
    view.settle();
    expect(screen.getByRole('button', { name: ':leaf:' })).toBeTruthy();
  });

  it('each tile opens a menu and is described by how it is used', async () => {
    await build([FOX, PARTY]);

    const fox = screen.getByRole('button', { name: ':fox:' });
    expect(fox).toHaveAttribute('aria-haspopup', 'menu');
    expect(fox).toHaveAccessibleDescription('Emoji');
    expect(
      screen.getByRole('button', { name: ':party:' }),
    ).toHaveAccessibleDescription('Sticker');
  });

  it('each tile is a button named :code: with alt text', async () => {
    const view = await build([FOX, LEAF]);
    expect(screen.getByRole('button', { name: ':fox:' })).toBeTruthy();
    expect(screen.getByRole('button', { name: ':leaf:' })).toBeTruthy();
    expect(screen.getByAltText('fox')).toHaveAttribute('src', 'blob:image');
    expect(view.container.querySelectorAll('img')).toHaveLength(2);
  });

  it("edits a room's pack with the room's copy", async () => {
    const view = await build([FOX], { ref: ROOM });
    expect(view.entries$).toHaveBeenCalledWith(ROOM);
    expect(screen.getByText('Room emoji')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Room emoji' }),
    ).toBeInTheDocument();

    view.pick('fox', 'Delete');
    expect(view.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        header: "Remove :fox: from this room's emoji?",
      }),
    );
    expect(view.remove).toHaveBeenCalledWith('fox', ROOM);
  });

  it("shows the room's empty state and adds files to the room", async () => {
    const view = await build([], { ref: ROOM });
    expect(
      screen.getByText(
        'Add images to give everyone in this room its own emoji and stickers.',
      ),
    ).toBeInTheDocument();
    const fox = new File(['f'], 'fox.png', { type: 'image/png' });
    choose(view.byTestId('personal-pack-files') as HTMLInputElement, [fox]);
    await tick();
    expect(view.openAndWait$).toHaveBeenCalledWith(
      AddToPackDialogComponent,
      expect.objectContaining({
        inputs: {
          input: { kind: 'file', file: fox },
          suggestedName: 'fox.png',
          ref: ROOM,
        },
      }),
    );
  });

  it('notes that an encrypted room stores its emoji unencrypted', async () => {
    const note =
      'Images added here are stored unencrypted on the server, like the room photo.';
    await build([FOX], { ref: ROOM, encrypted: true });
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it("a room's pack-full copy names the room", async () => {
    await build(
      Array.from({ length: 500 }, (_, i) => ({ ...FOX, shortcode: `e${i}` })),
      { ref: ROOM },
    );
    expect(
      screen.getByText("This room's emoji pack is full."),
    ).toBeInTheDocument();
  }, 30_000);

  it("keeps a room's grid when its ref is rebuilt for the same room", async () => {
    const view = await build([FOX], { ref: ROOM });
    view.fixture.componentRef.setInput('ref', { ...ROOM });
    view.settle();
    expect(view.entries$).toHaveBeenCalledTimes(1);
  });

  it("says why a room's pack can't be shown", async () => {
    await build(
      [FOX],
      { ref: ROOM },
      throwError(() => new ImagePackEditError('not-signed-in')),
    );
    expect(
      screen.getByText("Sign in again to change this room's emoji."),
    ).toBeInTheDocument();
  });

  it("words a room's failed changes for the room", async () => {
    const view = await build([FOX], { ref: ROOM });
    view.remove.mockReturnValueOnce(
      throwError(() => new ImagePackEditError('not-signed-in')),
    );
    view.pick('fox', 'Delete');
    expect(screen.getByRole('status')).toHaveTextContent(
      "Sign in again to change this room's emoji.",
    );
    view.setUsage.mockReturnValueOnce(
      throwError(() => new ImagePackEditError('not-allowed')),
    );
    view.pick('fox', 'Use as sticker');
    expect(screen.getByRole('status')).toHaveTextContent(
      "Your role can no longer change this room's emoji.",
    );
  });

  it("announces that a room's pack couldn't load", async () => {
    await build(
      [FOX],
      { ref: ROOM },
      throwError(() => new Error('offline')),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      "Couldn’t load this room's emoji.",
    );
  });
});
