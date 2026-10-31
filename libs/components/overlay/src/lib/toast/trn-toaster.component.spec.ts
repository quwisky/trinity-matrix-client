import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnToastService } from './trn-toast.service';
import { TrnToasterComponent } from './trn-toaster.component';

describe('TrnToasterComponent', () => {
  it('mounts the public toast viewport over the vendored renderer', async () => {
    const { container } = await render(TrnToasterComponent);

    expect(container.querySelector('brn-sonner-toaster')).not.toBeNull();
  });

  it('shows toasts at the top, where they cannot cover a composer', async () => {
    await render(TrnToasterComponent);

    TestBed.inject(TrnToastService).show('position-marker', { duration: 0 });
    TestBed.inject(ApplicationRef).tick();
    await Promise.resolve();
    TestBed.inject(ApplicationRef).tick();

    const list = document.querySelector<HTMLElement>('[data-sonner-toaster]');
    expect(list?.getAttribute('data-y-position')).toBe('top');
    expect(list?.getAttribute('data-x-position')).toBe('center');
  });

  it("gives toasts the app's font stack instead of Sonner's system-ui stack", async () => {
    await render(TrnToasterComponent);

    TestBed.inject(TrnToastService).show('font-marker', { duration: 0 });
    TestBed.inject(ApplicationRef).tick();
    await Promise.resolve();
    TestBed.inject(ApplicationRef).tick();

    const list = document.querySelector<HTMLElement>('[data-sonner-toaster]');
    expect(list?.style.getPropertyValue('--brn-sonner-font-family')).toBe(
      'var(--default-font-family)',
    );
  });
});
