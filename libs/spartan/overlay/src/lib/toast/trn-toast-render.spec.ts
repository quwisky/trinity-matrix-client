import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { HlmToaster } from '@trinity/helm/sonner';
import { TrnToastService } from './trn-toast.service';

// Regression guard for the toast producer/consumer store mismatch.
//
// `<hlm-toaster/>` wraps `@spartan-ng/brain/sonner`'s `<brn-sonner-toaster/>`, which
// renders from brain's own `toastState`. Since spartan 1.1 brain ships its own sonner
// port and no longer depends on ngx-sonner, so TrnToastService MUST call brain's
// `toast()` — calling ngx-sonner's pushes into a different store the toaster never
// observes, and the toast silently never renders (no error). The existing
// trn-toast.service.spec mocks ngx-sonner, so it cannot catch this; this test mounts
// the real toaster and asserts the message actually reaches the DOM.
@Component({
  selector: 'trn-toaster-host',
  imports: [HlmToaster],
  template: `<hlm-toaster />`,
})
class ToasterHost {}

// Brain's sonner adds toasts to a signal and renders on the following render pass;
// tick + drain a microtask + tick lets that settle under zoneless.
async function settle(): Promise<void> {
  TestBed.inject(ApplicationRef).tick();
  await Promise.resolve();
  TestBed.inject(ApplicationRef).tick();
}

describe('TrnToastService → <hlm-toaster/> (shared brain sonner state)', () => {
  it('actually renders a shown toast in the mounted toaster', async () => {
    await render(ToasterHost);

    TestBed.inject(TrnToastService).show('regression-toast-marker', {
      variant: 'success',
    });
    await settle();

    expect(document.body.textContent).toContain('regression-toast-marker');
  });

  it('renders an action button and runs its handler on click', async () => {
    // The same class of bug as the store mismatch above, one layer up: an `action`
    // the service accepts but never forwards produces a toast that looks right and
    // does nothing. Only mounting the real toaster and clicking the button proves
    // the option survives the trip — asserting on the object handed to `toast()`
    // would pass just as happily against a key sonner ignores.
    await render(ToasterHost);
    let activated = 0;

    TestBed.inject(TrnToastService).show('A new version is available.', {
      duration: 0,
      action: {
        label: 'Reload',
        onClick: () => {
          activated += 1;
        },
      },
    });
    await settle();

    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Reload',
    );
    expect(button).toBeTruthy();

    button!.click();
    await settle();

    expect(activated).toBe(1);
  });
});
