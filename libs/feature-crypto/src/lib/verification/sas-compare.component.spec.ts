import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SasCompareComponent } from './sas-compare.component';

const EMOJI = [
  { glyph: '🐶', name: 'Dog' },
  { glyph: '🐱', name: 'Cat' },
];

describe('SasCompareComponent', () => {
  function render() {
    const fixture = TestBed.createComponent(SasCompareComponent);
    fixture.componentRef.setInput('emoji', EMOJI);
    fixture.detectChanges();
    return fixture;
  }

  it('renders an item per emoji, labelled by name', () => {
    const el = render().nativeElement;
    expect(el.querySelectorAll('.emoji__item').length).toBe(2);
    expect(el.textContent).toContain('Dog');
    expect(el.textContent).toContain('Cat');
    // Glyphs are decorative for assistive tech.
    expect(el.querySelector('.emoji__glyph').getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('emits match / mismatch / cancel from the action buttons', () => {
    const fixture = render();
    const events: string[] = [];
    fixture.componentInstance.match.subscribe(() => events.push('match'));
    fixture.componentInstance.mismatch.subscribe(() => events.push('mismatch'));
    fixture.componentInstance.cancelled.subscribe(() => events.push('cancel'));

    const buttons = [
      ...fixture.nativeElement.querySelectorAll('ion-button'),
    ] as HTMLElement[];
    buttons
      .find(
        (b) =>
          b.textContent?.includes('match') && !b.textContent?.includes("don't"),
      )!
      .click();
    buttons.find((b) => b.textContent?.includes("don't"))!.click();
    buttons.find((b) => b.textContent?.includes('Cancel'))!.click();

    expect(events).toEqual(['match', 'mismatch', 'cancel']);
  });
});
