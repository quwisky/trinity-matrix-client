import { TrnDialogRef } from '@trinity/components/overlay';
import {
  RoomsService,
  type UserSearchResult,
} from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/ui';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { UserPickerComponent } from './user-picker.component';

const RESULTS: UserSearchResult[] = [
  { userId: '@bob:hs', displayName: 'Bob', avatarMxc: null },
];

describe('UserPickerComponent', () => {
  let dismiss: Mock;
  let searchUsers: Mock;

  function setInput(value: string, instance: UserPickerComponent): void {
    instance.onInput({ target: { value } } as unknown as Event);
  }

  beforeEach(() => {
    dismiss = vi.fn().mockResolvedValue(true);
    searchUsers = vi.fn(() => of(RESULTS));
  });

  /** Render the picker with the dialog ref and rooms service stubbed. */
  function renderPicker() {
    return render(UserPickerComponent, {
      providers: [
        { provide: TrnDialogRef, useValue: { close: dismiss } },
        MockProvider(RoomsService, { searchUsers }),
      ],
      imports: [MockComponent(AvatarComponent)],
    });
  }

  it('enables Confirm only for a complete Matrix ID', async () => {
    const { fixture } = await renderPicker();
    const c = fixture.componentInstance;

    setInput('bob', c);
    expect(c.canConfirm()).toBe(false);

    setInput('@bob:hs', c);
    expect(c.canConfirm()).toBe(true);
  });

  it('confirms the typed MXID (trimmed) and dismisses with it', async () => {
    const { fixture } = await renderPicker();
    const c = fixture.componentInstance;
    setInput('  @bob:hs  ', c);

    c.confirmTyped();

    expect(dismiss).toHaveBeenCalledWith('@bob:hs');
  });

  it('does not dismiss when confirming an invalid MXID', async () => {
    const { fixture } = await renderPicker();
    const c = fixture.componentInstance;
    setInput('bob', c);

    c.confirmTyped();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('dismisses with the chosen directory result', async () => {
    const { fixture } = await renderPicker();
    const c = fixture.componentInstance;

    c.choose('@carol:hs');

    expect(dismiss).toHaveBeenCalledWith('@carol:hs');
  });

  it('cancels by dismissing with null', async () => {
    const { fixture } = await renderPicker();
    const c = fixture.componentInstance;

    c.cancel();

    expect(dismiss).toHaveBeenCalledWith(null);
  });

  it('does not search for a term shorter than two characters', async () => {
    const { fixture } = await renderPicker();

    setInput('b', fixture.componentInstance);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(searchUsers).not.toHaveBeenCalled();
  });

  it('searches the directory (debounced) and exposes the results', async () => {
    const { fixture } = await renderPicker();

    setInput('bob', fixture.componentInstance);
    fixture.detectChanges(); // flush the toObservable effect
    await new Promise((resolve) => setTimeout(resolve, 320)); // debounce window
    fixture.detectChanges();

    expect(searchUsers).toHaveBeenCalledWith('bob');
    expect(fixture.componentInstance.results()).toEqual(RESULTS);
  });
});
