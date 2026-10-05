import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TrnIconComponent } from '@trinity/components/foundations';
import { fireEvent, render, screen } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnInput } from '../input/trn-input';
import { TrnPasswordInputComponent } from './trn-password-input.component';

@Component({
  imports: [TrnPasswordInputComponent, TrnInput],
  template: `
    <trn-password-input [disabled]="disabled()">
      <input trnInput id="pw" aria-label="Password" />
    </trn-password-input>
  `,
})
class HostComponent {
  readonly disabled = signal(false);
}

const field = (container: Element) =>
  container.querySelector<HTMLInputElement>('#pw') as HTMLInputElement;

describe('TrnPasswordInputComponent', () => {
  it('starts hidden and offers to show the password', async () => {
    const { container } = await render(HostComponent);

    expect(field(container).type).toBe('password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('type', 'button');
  });

  it('toggles the projected input type and the button name', async () => {
    const { container, fixture } = await render(HostComponent);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    fixture.detectChanges();

    expect(field(container).type).toBe('text');
    const toggle = screen.getByRole('button', { name: 'Hide password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);
    fixture.detectChanges();

    expect(field(container).type).toBe('password');
    expect(
      screen.getByRole('button', { name: 'Show password' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables the button with the disabled input', async () => {
    const { fixture } = await render(HostComponent);

    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    expect(
      screen.getByRole('button', { name: 'Show password' }),
    ).toBeDisabled();
  });

  it('places the button after the input, inside the same relative box', async () => {
    const { container } = await render(HostComponent);
    const host = container.querySelector('trn-password-input') as HTMLElement;
    const toggle = screen.getByRole('button', { name: 'Show password' });

    expect(host.classList).toContain('relative');
    expect(field(container).parentElement).toBe(host);
    expect(toggle.parentElement).toBe(host);
    expect(field(container).nextElementSibling).toBe(toggle);
    // Logical end edge so RTL flips, centred vertically.
    expect(toggle.classList).toContain('absolute');
    expect(toggle.classList).toContain('end-0.5');
    expect(toggle.classList).toContain('top-1/2');
    // The input reserves room so text never runs under the icon.
    expect(host.className).toContain('[&>input]:pe-12');
  });

  it('swaps the icon between eye and eye-off', async () => {
    const { fixture } = await render(HostComponent);
    const icon = () =>
      fixture.debugElement.query(By.directive(TrnIconComponent))
        .componentInstance as TrnIconComponent;

    expect(icon().name()).toBe('eye');
    expect(icon().motion()).toBe('pop');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    fixture.detectChanges();

    expect(icon().name()).toBe('eye-off');
  });
});
