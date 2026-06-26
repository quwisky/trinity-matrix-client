import { TestBed } from '@angular/core/testing';
import { AvatarComponent } from './avatar.component';

describe('AvatarComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [AvatarComponent] }),
  );

  it('renders the initials fallback when no url is given', () => {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('initial', 'A');
    fixture.componentRef.setInput('name', 'Alice');
    fixture.detectChanges();

    const fallback = fixture.nativeElement.querySelector('.avatar--fallback');
    expect(fallback).toBeTruthy();
    expect(fallback.textContent.trim()).toBe('A');
  });

  it('renders an image when a url is provided', () => {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('url', 'https://hs.example/avatar.png');
    fixture.detectChanges();

    const img = fixture.nativeElement.querySelector('img.avatar');
    expect(img.getAttribute('src')).toBe('https://hs.example/avatar.png');
  });

  it('falls back to initials after the image fails to load', () => {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('url', 'https://hs.example/broken.png');
    fixture.componentRef.setInput('initial', 'B');
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('img.avatar')
      .dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img.avatar')).toBeNull();
    expect(
      fixture.nativeElement
        .querySelector('.avatar--fallback')
        .textContent.trim(),
    ).toBe('B');
  });
});
