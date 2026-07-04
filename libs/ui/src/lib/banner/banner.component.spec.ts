import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BannerComponent } from './banner.component';

@Component({
  imports: [BannerComponent],
  template: `
    <trn-banner [tone]="tone">
      <span trnBannerIcon class="icon">i</span>
      Hello there
      <span trnBannerActions><button>Do it</button></span>
    </trn-banner>
  `,
})
class HostComponent {
  tone: 'neutral' | 'accent' = 'neutral';
}

describe('BannerComponent', () => {
  it('projects the icon, message, and actions into their slots', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.banner__icon .icon')).toBeTruthy();
    expect(el.querySelector('.banner__text')?.textContent?.trim()).toBe(
      'Hello there',
    );
    // The polite live region wraps the message, not the actions.
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Hello there',
    );
    expect(
      el.querySelector('.banner__actions button')?.textContent?.trim(),
    ).toBe('Do it');
  });

  it('reflects the tone as a data attribute', () => {
    const fixture = TestBed.createComponent(BannerComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.banner').getAttribute('data-tone'),
    ).toBe('neutral');

    fixture.componentRef.setInput('tone', 'accent');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.banner').getAttribute('data-tone'),
    ).toBe('accent');
  });
});
