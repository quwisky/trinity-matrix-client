import { TrnDialogRef } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import { MockComponent } from 'ng-mocks';
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
  async function setup() {
    const close = vi.fn();
    const { fixture } = await render(ReactionPickerComponent, {
      providers: [{ provide: TrnDialogRef, useValue: { close } }],
      componentImports: [MockComponent(TrnEmojiPickerComponent)],
    });
    return { cmp: fixture.componentInstance, close };
  }

  it('closes with the chosen native emoji', async () => {
    const { cmp, close } = await setup();
    cmp.onSelect(pick('🚀'));
    expect(close).toHaveBeenCalledWith('🚀');
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
