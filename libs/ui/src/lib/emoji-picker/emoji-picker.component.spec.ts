import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { EmojiPickerComponent } from './emoji-picker.component';

describe('EmojiPickerComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [EmojiPickerComponent] }),
  );

  it('renders a tab per category and emits the clicked emoji', () => {
    const fixture = TestBed.createComponent(EmojiPickerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    const el = fixture.nativeElement;

    expect(el.querySelectorAll('.picker__tab').length).toBe(
      cmp.categories.length,
    );

    let picked = '';
    cmp.pick.subscribe((e) => (picked = e));
    el.querySelector<HTMLButtonElement>('.picker__emoji').click();
    expect(picked).toBe(cmp.emojis()[0]);
  });

  it('switches the visible emojis when a category tab is selected', () => {
    const fixture = TestBed.createComponent(EmojiPickerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const firstCategory = cmp.emojis();
    cmp.active.set(cmp.categories[2].id);
    fixture.detectChanges();

    expect(cmp.emojis()).toEqual(cmp.categories[2].emojis);
    expect(cmp.emojis()).not.toEqual(firstCategory);
  });
});
