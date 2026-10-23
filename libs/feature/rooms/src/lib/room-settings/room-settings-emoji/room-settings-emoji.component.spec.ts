import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IMAGE_PACK_EDITOR, type PackRef } from '@trinity/data-access/media';
import { render, screen } from '@trinity/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { RoomSettingsEmojiComponent } from './room-settings-emoji.component';

@Component({
  selector: 'trn-pack-editor-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ ref().kind }} {{ $any(ref()).roomId }} {{ encrypted() }}`,
})
class PackEditorStubComponent {
  readonly ref = input.required<PackRef>();
  readonly encrypted = input(false);
}

const INPUTS = { accountId: '@a:hs', roomId: '!r:hs', encrypted: true };

describe('RoomSettingsEmojiComponent', () => {
  it('loads the pack editor for this room on this account', async () => {
    await render(RoomSettingsEmojiComponent, {
      inputs: INPUTS,
      providers: [
        {
          provide: IMAGE_PACK_EDITOR,
          useValue: () => of(PackEditorStubComponent),
        },
      ],
    });
    expect(await screen.findByText('room !r:hs true')).toBeInTheDocument();
  });

  it('renders nothing without a pack editor', async () => {
    const { container } = await render(RoomSettingsEmojiComponent, {
      inputs: INPUTS,
    });
    expect(container.textContent?.trim()).toBe('');
  });
});
