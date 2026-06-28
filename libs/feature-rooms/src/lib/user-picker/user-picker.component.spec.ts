import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular/standalone';
import { RoomsService, type UserSearchResult } from '@trinity/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPickerComponent } from './user-picker.component';

const RESULTS: UserSearchResult[] = [
  { userId: '@bob:hs', displayName: 'Bob', avatarMxc: null },
];

describe('UserPickerComponent', () => {
  let dismiss: ReturnType<typeof vi.fn>;
  let searchUsers: ReturnType<typeof vi.fn>;

  function setInput(value: string, instance: UserPickerComponent): void {
    instance.onInput({ detail: { value } } as unknown as Event);
  }

  beforeEach(() => {
    dismiss = vi.fn().mockResolvedValue(true);
    searchUsers = vi.fn(() => of(RESULTS));
    TestBed.configureTestingModule({
      imports: [UserPickerComponent],
      providers: [
        { provide: ModalController, useValue: { dismiss } },
        { provide: RoomsService, useValue: { searchUsers } },
      ],
    });
  });

  it('enables Confirm only for a complete Matrix ID', () => {
    const { componentInstance: c } =
      TestBed.createComponent(UserPickerComponent);

    setInput('bob', c);
    expect(c.canConfirm()).toBe(false);

    setInput('@bob:hs', c);
    expect(c.canConfirm()).toBe(true);
  });

  it('confirms the typed MXID (trimmed) and dismisses with it', () => {
    const { componentInstance: c } =
      TestBed.createComponent(UserPickerComponent);
    setInput('  @bob:hs  ', c);

    c.confirmTyped();

    expect(dismiss).toHaveBeenCalledWith('@bob:hs');
  });

  it('does not dismiss when confirming an invalid MXID', () => {
    const { componentInstance: c } =
      TestBed.createComponent(UserPickerComponent);
    setInput('bob', c);

    c.confirmTyped();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('dismisses with the chosen directory result', () => {
    const { componentInstance: c } =
      TestBed.createComponent(UserPickerComponent);

    c.choose('@carol:hs');

    expect(dismiss).toHaveBeenCalledWith('@carol:hs');
  });

  it('cancels by dismissing with null', () => {
    const { componentInstance: c } =
      TestBed.createComponent(UserPickerComponent);

    c.cancel();

    expect(dismiss).toHaveBeenCalledWith(null);
  });

  it('does not search for a term shorter than two characters', async () => {
    const fixture = TestBed.createComponent(UserPickerComponent);
    fixture.detectChanges();

    setInput('b', fixture.componentInstance);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(searchUsers).not.toHaveBeenCalled();
  });

  it('searches the directory (debounced) and exposes the results', async () => {
    const fixture = TestBed.createComponent(UserPickerComponent);
    fixture.detectChanges();

    setInput('bob', fixture.componentInstance);
    fixture.detectChanges(); // flush the toObservable effect
    await new Promise((resolve) => setTimeout(resolve, 320)); // debounce window
    fixture.detectChanges();

    expect(searchUsers).toHaveBeenCalledWith('bob');
    expect(fixture.componentInstance.results()).toEqual(RESULTS);
  });
});
