import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  HOST_LIFECYCLE_OPERATION,
  HostSystemUiService,
} from '@trinity/runtime/host';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackFileChooserDirective } from './track-file-chooser.directive';

@Component({
  imports: [TrackFileChooserDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input type="file" hidden trnTrackFileChooser />`,
})
class FileInputHostComponent {}

function setup() {
  const lifecycle = new Subject<{ readonly kind: 'active' | 'background' }>();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: HOST_LIFECYCLE_OPERATION,
        useValue: { events: lifecycle.asObservable() },
      },
    ],
  });
  const fixture = TestBed.createComponent(FileInputHostComponent);
  fixture.detectChanges();
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    'input',
  ) as HTMLInputElement;
  const ui = TestBed.inject(HostSystemUiService);
  return { fixture, input, ui, lifecycle };
}

describe('TrackFileChooserDirective', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('counts the file chooser as Trinity’s own system UI from its opening click until a choice', () => {
    const { input, ui } = setup();
    expect(ui.active()).toBe(false);
    // The composer and Settings open their hidden inputs with `click()`.
    input.click();
    expect(ui.active()).toBe(true);
    input.dispatchEvent(new Event('change'));
    expect(ui.active()).toBe(false);
  });

  it('stops counting when the chooser is cancelled', () => {
    const { input, ui } = setup();
    input.click();
    input.dispatchEvent(new Event('cancel'));
    expect(ui.active()).toBe(false);
  });

  it('counts a chooser opened twice once', () => {
    const { input, ui } = setup();
    input.click();
    input.click();
    input.dispatchEvent(new Event('change'));
    expect(ui.active()).toBe(false);
  });

  it('releases a chooser whose end was missed when the window gets focus back', () => {
    const { input, ui } = setup();
    input.click();
    window.dispatchEvent(new Event('blur'));
    expect(ui.active()).toBe(true);
    window.dispatchEvent(new Event('focus'));
    expect(ui.active()).toBe(false);
  });

  it('releases a chooser whose end was missed when the app is back in the foreground', () => {
    // Android's document picker sends Trinity to the background.
    const { input, ui, lifecycle } = setup();
    input.click();
    lifecycle.next({ kind: 'background' });
    expect(ui.active()).toBe(true);
    lifecycle.next({ kind: 'active' });
    expect(ui.active()).toBe(false);
  });

  it('counts again for the next opening after a release', () => {
    const { input, ui } = setup();
    input.click();
    window.dispatchEvent(new Event('focus'));
    input.click();
    expect(ui.active()).toBe(true);
    input.dispatchEvent(new Event('change'));
    expect(ui.active()).toBe(false);
  });

  it('stops counting when the input leaves the page', () => {
    const { fixture, input, ui } = setup();
    input.click();
    fixture.destroy();
    expect(ui.active()).toBe(false);
  });
});
