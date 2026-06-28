import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AvatarComponent } from './avatar.component';
import { AVATAR_RESOLVER } from './avatar-resolver';

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

  it('resolves an mxc via the resolver and shows the resolved url', () => {
    const resolver = vi.fn(() => of('blob:resolved'));
    TestBed.configureTestingModule({
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('mxc', 'mxc://hs/a');
    fixture.componentRef.setInput('size', 64);
    fixture.detectChanges();

    expect(resolver).toHaveBeenCalledWith('mxc://hs/a', 64);
    expect(
      fixture.nativeElement.querySelector('img.avatar').getAttribute('src'),
    ).toBe('blob:resolved');
  });

  it('falls back to initials when the resolver yields null', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: AVATAR_RESOLVER, useValue: () => of(null) }],
    });
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('mxc', 'mxc://hs/missing');
    fixture.componentRef.setInput('initial', 'C');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img.avatar')).toBeNull();
    expect(
      fixture.nativeElement
        .querySelector('.avatar--fallback')
        .textContent.trim(),
    ).toBe('C');
  });
});
