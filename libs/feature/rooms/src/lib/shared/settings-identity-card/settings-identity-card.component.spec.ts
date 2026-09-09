import { ChangeDetectionStrategy, Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { SettingsIdentityCardComponent } from './settings-identity-card.component';

@Component({
  imports: [SettingsIdentityCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<trn-settings-identity-card heading="Space photo">
    <button type="button" (click)="changePhoto()">Change photo</button>
  </trn-settings-identity-card>`,
})
class IdentityCardHostComponent {
  readonly changePhoto = vi.fn();
}

describe('SettingsIdentityCardComponent', () => {
  it('keeps the projected photo control interactive and explains immediate saving', async () => {
    const { fixture, getByRole, getByText } = await render(
      IdentityCardHostComponent,
    );
    expect(
      getByRole('heading', { name: 'Space photo', level: 3 }),
    ).toBeTruthy();
    expect(
      getByText(
        'Photo changes save immediately and are not undone by Discard.',
      ),
    ).toBeTruthy();
    getByRole('button', { name: 'Change photo' }).click();
    expect(fixture.componentInstance.changePhoto).toHaveBeenCalledOnce();
  });

  it('updates a permission restriction and removes it when permission returns', async () => {
    const { fixture, getByText, queryByText } = await render(
      SettingsIdentityCardComponent,
      {
        inputs: {
          heading: 'Room photo',
          permissionReason: 'You need permission to change this photo.',
        },
      },
    );
    expect(getByText('You need permission to change this photo.')).toBeTruthy();
    fixture.componentRef.setInput(
      'permissionReason',
      'The Room is unavailable.',
    );
    fixture.detectChanges();
    expect(getByText('The Room is unavailable.')).toBeTruthy();
    expect(queryByText('You need permission to change this photo.')).toBeNull();
    fixture.componentRef.setInput('permissionReason', null);
    fixture.detectChanges();
    expect(queryByText('The Room is unavailable.')).toBeNull();
  });
});
