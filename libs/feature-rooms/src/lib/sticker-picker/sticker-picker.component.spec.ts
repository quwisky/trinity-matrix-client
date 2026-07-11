import { render } from '@testing-library/angular';
import { MockComponent, MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { StickerPacksService } from '@trinity/data-access-timeline';
import { type StickerPack } from '@trinity/util-matrix';
import { StickerComponent } from '../sticker/sticker.component';
import { StickerPickerComponent } from './sticker-picker.component';

const PACK: StickerPack = {
  id: 'user',
  displayName: 'Blobs',
  images: [
    { shortcode: 'party', url: 'mxc://hs/party', body: 'Party' },
    { shortcode: 'wave', url: 'mxc://hs/wave', body: 'Wave' },
  ],
};

async function build(packs: StickerPack[]) {
  const emitted: unknown[] = [];
  const { container, fixture } = await render(StickerPickerComponent, {
    imports: [MockComponent(StickerComponent)],
    providers: [MockProvider(StickerPacksService, { packs: () => packs })],
  });
  fixture.componentInstance.stickerSelect.subscribe((i) => emitted.push(i));
  return { container, emitted };
}

describe('StickerPickerComponent', () => {
  it('lists each pack image as a selectable option', async () => {
    const { container } = await build([PACK]);
    expect(container.textContent).toContain('Blobs');
    expect(
      container.querySelectorAll('[data-testid=sticker-option]'),
    ).toHaveLength(2);
  });

  it('emits the chosen image on click', async () => {
    const { container, emitted } = await build([PACK]);
    const options = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid=sticker-option]',
    );
    options[1].click();

    expect(emitted).toEqual([PACK.images[1]]);
  });

  it('shows a hint when no packs are configured', async () => {
    const { container } = await build([]);
    expect(
      container.querySelector('[data-testid=sticker-picker-empty]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid=sticker-option]')).toBeNull();
  });
});
