import { DialogRef } from '@trinity/helm/overlay';
import { render } from '@trinity/testing';
import { MockComponent } from 'ng-mocks';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { type EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { describe, expect, it, vi } from 'vitest';
import { ThemeService } from '@trinity/platform-native';
import { ReactionPickerComponent } from './reaction-picker.component';

/** An EmojiEvent carrying just the native character onSelect reads. */
function emojiEvent(native: string | undefined): EmojiEvent {
  return { emoji: { native } } as unknown as EmojiEvent;
}

describe('ReactionPickerComponent', () => {
  async function setup(resolved: 'light' | 'dark' = 'light') {
    const close = vi.fn();
    const { fixture } = await render(ReactionPickerComponent, {
      providers: [
        { provide: DialogRef, useValue: { close } },
        { provide: ThemeService, useValue: { resolved: () => resolved } },
      ],
      componentImports: [MockComponent(PickerComponent)],
    });
    return { cmp: fixture.componentInstance, close };
  }

  it('closes with the chosen native emoji', async () => {
    const { cmp, close } = await setup();
    cmp.onSelect(emojiEvent('🚀'));
    expect(close).toHaveBeenCalledWith('🚀');
  });

  it('closes with null when the emoji has no native character', async () => {
    const { cmp, close } = await setup();
    cmp.onSelect(emojiEvent(undefined));
    expect(close).toHaveBeenCalledWith(null);
  });

  it('reports a light picker chrome under the light theme', async () => {
    const { cmp } = await setup('light');
    expect(cmp.isDarkMode()).toBe(false);
  });

  it('reports a dark picker chrome under the dark theme', async () => {
    const { cmp } = await setup('dark');
    expect(cmp.isDarkMode()).toBe(true);
  });
});
