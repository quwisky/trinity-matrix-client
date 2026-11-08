import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnInput,
  TrnPasswordInputComponent,
  TrnSelectComponent,
  TrnTextarea,
} from '@trinity/components/controls';
import {
  TrnDialogShellComponent,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import { fireEvent, render, screen } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TrnFieldLockComponent } from './trn-field-lock.component';

@Component({
  imports: [
    TrnFieldLockComponent,
    TrnInput,
    TrnPasswordInputComponent,
    TrnSelectComponent,
    TrnTextarea,
  ],
  template: `
    <trn-field-lock data-testid="text">
      <input trnInput [disabled]="disabled()" [disabledReason]="reason()" />
    </trn-field-lock>
    <trn-field-lock data-testid="small">
      <input trnInput size="sm" [disabled]="disabled()" />
    </trn-field-lock>
    <trn-field-lock data-testid="password">
      <trn-password-input>
        <input trnInput [disabled]="disabled()" />
      </trn-password-input>
    </trn-field-lock>
    <span id="join-label">Who can join</span>
    <trn-field-lock data-testid="select">
      <trn-select
        aria-labelledby="join-label"
        [options]="options"
        [disabled]="disabled()"
        disabledReason="Only admins can change this"
      />
    </trn-field-lock>
    <trn-field-lock data-testid="topic">
      <textarea trnTextarea [disabled]="disabled()"></textarea>
    </trn-field-lock>
  `,
})
class HostComponent {
  readonly disabled = signal(false);
  readonly reason = signal('Wait for sign-in to finish');
  readonly options = [{ value: 'invite', label: 'Invite only' }];
}

@Component({
  imports: [TrnDialogShellComponent, TrnFieldLockComponent, TrnInput],
  template: `
    <trn-dialog-shell title="Edit room">
      <trn-field-lock>
        <input trnInput disabled aria-label="Room name" />
      </trn-field-lock>
    </trn-dialog-shell>
  `,
})
class LockDialogComponent {}

const bubble = () =>
  document.querySelector('p[data-testid="field-lock-reason"]');

async function setup() {
  const view = await render(HostComponent);
  const lock = (id: string) =>
    view.container.querySelector(
      `[data-testid="${id}"] [data-testid="field-lock"]`,
    );
  const disable = async () => {
    view.fixture.componentInstance.disabled.set(true);
    view.fixture.detectChanges();
    await view.fixture.whenStable();
    view.fixture.detectChanges();
  };
  const settle = async () => {
    view.fixture.detectChanges();
    await view.fixture.whenStable();
    view.fixture.detectChanges();
  };
  return { ...view, lock, disable, settle };
}

afterEach(() => {
  // Each bubble renders in CDK's overlay container, which outlives a test's fixture.
  document.querySelector('.cdk-overlay-container')?.replaceChildren();
});

describe('TrnFieldLockComponent', () => {
  it('draws no lock while the field is enabled', async () => {
    const { lock } = await setup();

    expect(lock('text')).toBeNull();
    expect(
      screen.getAllByRole('button', { name: 'Show password' }),
    ).toHaveLength(1);
  });

  it('gives a disabled field a focusable lock that says why', async () => {
    const { lock, disable } = await setup();
    await disable();

    const button = lock('text') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.disabled).toBe(false);
    expect(button).toHaveAccessibleName('Why is this locked?');
    expect(button).toHaveAccessibleDescription('Wait for sign-in to finish');
    expect(lock('topic')).toHaveAccessibleDescription(
      'You can’t change this right now',
    );
    expect(lock('topic')?.hasAttribute('data-multiline')).toBe(true);
  });

  it('locks a disabled select beside the fields', async () => {
    const { lock, disable } = await setup();
    await disable();

    expect(lock('select')).toHaveAccessibleDescription(
      'Only admins can change this',
    );
  });

  it('leaves a small field without a lock', async () => {
    const { lock, disable } = await setup();
    await disable();

    expect(lock('small')).toBeNull();
  });

  it('puts the lock where a disabled password field’s reveal toggle was', async () => {
    const { lock, disable } = await setup();
    await disable();

    expect(lock('password')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Show password' })).toBeNull();
  });

  it('opens the reason on a press and closes it on Escape, a second press or outside', async () => {
    const { lock, disable, fixture } = await setup();
    await disable();
    const button = lock('text') as HTMLButtonElement;
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
    };

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(bubble()).toBeNull();

    button.click();
    await settle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(bubble()?.textContent?.trim()).toBe('Wait for sign-in to finish');
    expect(button.getAttribute('aria-controls')).toBe(bubble()?.id);

    fireEvent.keyDown(button, { key: 'Escape', keyCode: 27 });
    await settle();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(bubble()).toBeNull();

    button.click();
    await settle();
    button.click();
    await settle();
    expect(bubble()).toBeNull();

    button.click();
    await settle();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await settle();
    expect(bubble()).toBeNull();
  });

  it('still describes the lock after its reason has opened and closed', async () => {
    const { lock, disable, fixture } = await setup();
    await disable();
    const button = lock('text') as HTMLButtonElement;

    for (let i = 0; i < 2; i += 1) {
      button.focus();
      button.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fireEvent.keyDown(button, { key: 'Escape', keyCode: 27 });
      fixture.detectChanges();
      await fixture.whenStable();
      button.blur();
    }

    expect(button).toHaveAccessibleDescription('Wait for sign-in to finish');
  });

  it('stops Escape only while the bubble is open', async () => {
    const { lock, disable, settle } = await setup();
    await disable();
    const button = lock('text') as HTMLButtonElement;
    let reachedDocument = 0;
    const count = (event: KeyboardEvent) => {
      if (event.key === 'Escape') reachedDocument += 1;
    };
    document.addEventListener('keydown', count);

    button.click();
    await settle();
    fireEvent.keyDown(button, { key: 'Escape', keyCode: 27 });
    await settle();
    expect(reachedDocument).toBe(0);

    fireEvent.keyDown(button, { key: 'Escape', keyCode: 27 });
    expect(reachedDocument).toBe(1);
    document.removeEventListener('keydown', count);
  });

  it('updates the reason live in both the bubble and the description', async () => {
    const { lock, disable, settle, fixture } = await setup();
    await disable();
    const button = lock('text') as HTMLButtonElement;
    button.click();
    await settle();

    fixture.componentInstance.reason.set('Only admins can change this');
    await settle();

    expect(bubble()?.textContent?.trim()).toBe('Only admins can change this');
    expect(button).toHaveAccessibleDescription('Only admins can change this');
  });

  it('closes the bubble when the field unlocks, and stays closed when it locks again', async () => {
    const { lock, disable, settle, fixture } = await setup();
    await disable();
    (lock('text') as HTMLButtonElement).click();
    await settle();
    expect(bubble()).not.toBeNull();

    fixture.componentInstance.disabled.set(false);
    await settle();
    expect(lock('text')).toBeNull();
    expect(bubble()).toBeNull();

    await disable();
    expect(lock('text')?.getAttribute('aria-expanded')).toBe('false');
    expect(bubble()).toBeNull();
  });

  it('keeps two locks independent', async () => {
    const { lock, disable, settle } = await setup();
    await disable();
    const text = lock('text') as HTMLButtonElement;
    const topic = lock('topic') as HTMLButtonElement;

    text.click();
    await settle();
    expect(text.getAttribute('aria-expanded')).toBe('true');
    expect(topic.getAttribute('aria-expanded')).toBe('false');

    // Escape on the other lock leaves this one open.
    fireEvent.keyDown(topic, { key: 'Escape', keyCode: 27 });
    await settle();
    expect(text.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelectorAll('p[data-testid="field-lock-reason"]'),
    ).toHaveLength(1);
  });

  it('closes the bubble when focus leaves the lock', async () => {
    const { lock, disable, settle } = await setup();
    await disable();
    const button = lock('text') as HTMLButtonElement;
    button.focus();
    button.click();
    await settle();
    expect(bubble()).not.toBeNull();

    fireEvent.focusOut(button);
    await settle();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(bubble()).toBeNull();
  });
});

describe('TrnFieldLockComponent in a dialog', () => {
  afterEach(() => TestBed.inject(TrnSurfaceService).closeAll());

  it('closes only its bubble on the first Escape and the dialog on the second', async () => {
    const surfaces = TestBed.inject(TrnSurfaceService);
    const tick = () => TestBed.inject(ApplicationRef).tick();
    surfaces.open(LockDialogComponent);
    tick();
    await TestBed.inject(ApplicationRef).whenStable();
    const button = screen.getByRole('button', { name: 'Why is this locked?' });

    button.click();
    tick();
    expect(bubble()).not.toBeNull();

    fireEvent.keyDown(button, { key: 'Escape', keyCode: 27 });
    tick();
    expect(bubble()).toBeNull();
    expect(surfaces.hasOpen()).toBe(true);

    fireEvent.keyDown(button, { key: 'Escape', keyCode: 27 });
    tick();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(surfaces.hasOpen()).toBe(false);
  });
});
