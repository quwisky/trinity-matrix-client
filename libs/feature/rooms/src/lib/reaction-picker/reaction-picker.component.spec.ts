import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TrnDialogRef } from '@trinity/components/overlay';
import { RecentEmojiService } from '@trinity/data-access/media';
import { render, screen, within } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ReactionPickerComponent } from './reaction-picker.component';
import {
  TrnEmojiPickerComponent,
  type TrnEmojiPick,
} from '@trinity/components/controls';

/** A pick as the wrapper emits it — always with a character; see TrnEmojiPick. */
const pick = (native: string): TrnEmojiPick => ({
  native,
  id: 'rocket',
  colons: ':rocket:',
});

describe('ReactionPickerComponent', () => {
  async function setup(presentation: 'dialog' | 'sheet' = 'dialog') {
    const close = vi.fn();
    const record = vi.fn();
    const { fixture } = await render(ReactionPickerComponent, {
      providers: [
        {
          provide: TrnDialogRef,
          useValue: new TrnDialogRef(
            { closed: new Subject(), close },
            presentation,
          ),
        },
        MockProvider(RecentEmojiService, {
          recent: signal(['🎉', '👍']).asReadonly(),
          run: () => of(undefined),
          record,
        }),
      ],
      componentImports: [MockComponent(TrnEmojiPickerComponent)],
    });
    const picker = fixture.debugElement.query(
      By.directive(TrnEmojiPickerComponent),
    ).componentInstance as TrnEmojiPickerComponent;
    return { cmp: fixture.componentInstance, close, record, picker };
  }

  it('names itself with the shared dialog shell heading', async () => {
    await setup();

    expect(
      within(screen.getByTestId('dialog-surface')).getByRole('heading', {
        level: 2,
        name: 'Pick a reaction',
      }),
    ).toBeTruthy();
  });

  it('keeps a Cancel block in a sheet, its one on-screen dismissal', async () => {
    const { close } = await setup('sheet');

    screen.getByRole('button', { name: 'Cancel' }).click();
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0][0]).toBeUndefined();
  });

  it('closes with the chosen native emoji', async () => {
    const { cmp, close } = await setup();
    cmp.onSelect(pick('🚀'));
    expect(close).toHaveBeenCalledWith('🚀');
  });

  it('keeps its own fixed card in a centred dialog', async () => {
    const { picker } = await setup('dialog');

    expect([picker.framed(), picker.layout(), picker.size()]).toEqual([
      true,
      'fixed',
      'md',
    ]);
  });

  it("fills a phone's sheet with touch-sized cells and no card of its own", async () => {
    const { picker } = await setup('sheet');

    expect([picker.framed(), picker.layout(), picker.size()]).toEqual([
      false,
      'fill',
      'lg',
    ]);
  });

  it("shows the account's recent emoji first", async () => {
    const { picker } = await setup();

    expect(picker.recent()).toEqual(['🎉', '👍']);
  });

  it('records the chosen emoji for the account', async () => {
    const { cmp, record } = await setup();

    cmp.onSelect(pick('🚀'));

    expect(record).toHaveBeenCalledWith('🚀');
  });

  // The "no native character" case is gone on purpose: it is now unreachable here. The
  // wrapper drops such a pick, so this component can no longer be asked to close with
  // null — which the caller could not tell apart from a dismissal. That guarantee is
  // asserted where it now lives, in the kit's own picker spec.

  // The two theme tests that stood here are gone with the boolean they asserted. The
  // vendor's `darkMode` could only express light-or-dark, so it was wrong under two of
  // Trinity's four mode x palette combinations regardless of what it was set to. The
  // picker is painted from design tokens now, which no unit test can meaningfully assert
  // — jsdom applies no stylesheet — so this is covered by the tokens themselves rather
  // than by a boolean that no longer exists.
});
