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
});
