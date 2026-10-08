import {
  ChangeDetectionStrategy,
  Component,
  input,
  signal,
} from '@angular/core';
import { form } from '@angular/forms/signals';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { RoomSettingsService } from '@trinity/data-access/room-administration';
import { TrnToastService } from '@trinity/components/overlay';
import { describe, expect, it, vi } from 'vitest';
import type { RoomSettingsPermissions } from '@trinity/data-access/room-administration';
import { PlaceGeneralSettingsComponent } from './place-general-settings.component';
import type { PlaceProfileDraft } from './place-profile-draft';

const allowed = { available: true, reason: null };
const permissions = {
  name: allowed,
  topic: allowed,
  avatar: allowed,
} as unknown as RoomSettingsPermissions;

function fakeDraft(over: Partial<PlaceProfileDraft> = {}): PlaceProfileDraft {
  const model = signal({ name: 'Lobby', topic: '' });
  return {
    form: form(model),
    model: model.asReadonly(),
    snapshot: signal(null),
    permissions: signal(permissions),
    mayEditAvatar: signal(true),
    mayEditName: signal(true),
    mayEditTopic: signal(true),
    nameHasPermissionBlockedEdit: signal(false),
    topicHasPermissionBlockedEdit: signal(false),
    generalFeedback: signal(null),
    generalDirty: signal(true),
    generalHasWritableChanges: signal(true),
    generalSaveUnavailableReason: signal(null),
    saving: signal(null),
    discardGeneral: vi.fn(),
    saveGeneral: vi.fn(),
    ...over,
  };
}

// The draft is built in the host's injection context, which Signal Forms needs.
let overrides: Partial<PlaceProfileDraft> = {};

@Component({
  imports: [PlaceGeneralSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<trn-place-general-settings
    [draft]="draft"
    [noun]="noun()"
    accountId="a"
    placeId="!p:hs"
    [displayName]="noun()"
    hint="Shown in lists."
  >
    <p data-testid="projected-encryption">Encrypted</p>
  </trn-place-general-settings>`,
})
class HostComponent {
  readonly noun = input<'Room' | 'Space'>('Room');
  readonly draft = fakeDraft(overrides);
}

async function build(noun: 'Room' | 'Space', over = {}) {
  overrides = over;
  const result = await render(HostComponent, {
    inputs: { noun },
    providers: [
      MockProvider(RoomSettingsService),
      MockProvider(TrnToastService),
    ],
  });
  return { ...result, draft: result.fixture.componentInstance.draft };
}

describe('PlaceGeneralSettingsComponent', () => {
  it.each([
    ['Room', 'room'],
    ['Space', 'space'],
  ] as const)('builds %s testids and copy from the noun', async (noun, p) => {
    const { container, getByText, draft } = await build(noun);
    for (const id of [
      'panel-general',
      'name',
      'topic',
      'general-actions',
      'save',
      'discard',
    ]) {
      expect(
        container.querySelector(`[data-testid="${p}-settings-${id}"]`),
      ).toBeTruthy();
    }
    expect(getByText(`${noun} details`)).toBeTruthy();
    (
      container.querySelector(
        `[data-testid="${p}-settings-discard"]`,
      ) as HTMLElement
    ).click();
    expect(draft.discardGeneral).toHaveBeenCalledOnce();
  });

  it('projects content between the details and the actions', async () => {
    const { container } = await build('Room');
    expect(
      container.querySelector('[data-testid="projected-encryption"]'),
    ).toBeTruthy();
  });

  it('blocks Save and explains an emptied Space name', async () => {
    const nameEmpty = signal(false);
    const { fixture, container, queryByText } = await build('Space', {
      nameEmpty,
    });
    const save = () =>
      container.querySelector(
        '[data-testid="space-settings-save"]',
      ) as HTMLButtonElement;
    expect(save().disabled).toBe(false);
    expect(queryByText('A space needs a name.')).toBeNull();
    nameEmpty.set(true);
    fixture.detectChanges();
    expect(save().disabled).toBe(true);
    expect(queryByText('A space needs a name.')).toBeTruthy();
  });
});
