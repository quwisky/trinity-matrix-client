import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  TrnAlertService,
  TrnSurfaceService,
  type ActionSheetData,
} from '@trinity/components/overlay';
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

async function build(entries: readonly PackEntry[] | null = [FOX]) {
  const personal = signal<readonly PackEntry[] | null>(entries);
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
    providers: [
      provideTrnIcons(),
      MockProvider(ImagePackEditorService, {
        personal,
        run,
        rename,
        setUsage,
        remove,
      }),
      MockProvider(TrnAlertService, { confirm$ }),
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

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
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
        },
      }),
    );
  });

  it('disables Add with the full-pack copy at 500', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      ...FOX,
      shortcode: `e${i}`,
    }));
    await build(full);
    expect(screen.getByRole('button', { name: 'Add images' })).toBeDisabled();
    expect(screen.getByText('Your emoji pack is full.')).toBeTruthy();
  });

  it('Delete asks "Remove :code: from your emoji?" and removes it', async () => {
    const view = await build();
    view.pick('fox', 'Delete');
    expect(view.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Remove :fox: from your emoji?',
        variant: 'danger',
      }),
    );
    expect(view.remove).toHaveBeenCalledWith('fox');
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
    expect(view.setUsage).toHaveBeenCalledWith('fox', ['emoticon', 'sticker']);
  });

  it('rename validates inline', async () => {
    const view = await build([FOX, LEAF]);
    view.pick('fox', 'Rename shortcode');
    const field = screen.getByLabelText(
      'New shortcode for :fox:',
    ) as HTMLInputElement;
    expect(field.value).toBe('fox');
    await new Promise((resolve) => setTimeout(resolve));
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
    expect(view.rename).toHaveBeenCalledWith('fox', 'leaf');
    expect(view.byTestId('personal-pack-rename-error')).toHaveTextContent(
      'You already have :leaf:. Choose another shortcode.',
    );

    type(field, 'kitsune');
    screen.getByRole('button', { name: 'Save' }).click();
    view.settle();
    expect(view.rename).toHaveBeenLastCalledWith('fox', 'kitsune');
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

  it('each tile is a button named :code: with alt text', async () => {
    const view = await build([FOX, LEAF]);
    expect(screen.getByRole('button', { name: ':fox:' })).toBeTruthy();
    expect(screen.getByRole('button', { name: ':leaf:' })).toBeTruthy();
    expect(screen.getByAltText('fox')).toHaveAttribute('src', 'blob:image');
    expect(view.container.querySelectorAll('img')).toHaveLength(2);
  });
});
