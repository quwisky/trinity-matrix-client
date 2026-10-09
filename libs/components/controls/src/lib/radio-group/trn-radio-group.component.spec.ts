import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TrnRadioComponent,
  TrnRadioGroupComponent,
  type TrnRadioGroupLayout,
  type TrnRadioOption,
} from './trn-radio-group.component';

const OPTIONS: readonly TrnRadioOption<string>[] = [
  {
    value: 'system',
    label: 'Use system setting',
    description: 'Follow this device automatically.',
    testId: 'theme-system',
  },
  { value: 'light', label: 'Light', testId: 'theme-light' },
  { value: 'dark', label: 'Dark', testId: 'theme-dark' },
];

@Component({
  imports: [TrnRadioGroupComponent],
  template: `
    <h2 id="mode-heading">Appearance</h2>
    <trn-radio-group
      aria-labelledby="mode-heading"
      layout="segmented"
      [options]="options"
      [value]="value()"
      [disabled]="disabled()"
      (valueChange)="value.set($event)"
    />
  `,
})
class HostComponent {
  readonly options = OPTIONS;
  readonly value = signal('system');
  readonly disabled = signal(false);
}

@Component({
  imports: [TrnRadioGroupComponent],
  template: `
    <trn-radio-group
      layout="segmented"
      invalid
      aria-labelledby="mode-heading"
      [options]="options"
      value="system"
    />
  `,
})
class CanonicalHostComponent {
  readonly options = OPTIONS;
}

@Component({
  imports: [TrnRadioGroupComponent, TrnRadioComponent],
  template: `
    <trn-radio-group
      aria-labelledby="notify-heading"
      [value]="value()"
      [disabled]="disabled()"
      (valueChange)="value.set($event)"
    >
      <label for="notify-all">All</label>
      <trn-radio value="all" inputId="notify-all" data-testid="notify-all" />
      <label for="notify-mute">Mute</label>
      <trn-radio value="mute" inputId="notify-mute" data-testid="notify-mute" />
    </trn-radio-group>
  `,
})
class ProjectedHostComponent {
  readonly value = signal('all');
  readonly disabled = signal(false);
}

describe('TrnRadioComponent', () => {
  it('shares one native name across projected radios, so the arrow keys move between them', async () => {
    const { container } = await render(ProjectedHostComponent);
    const radios = [
      ...container.querySelectorAll<HTMLInputElement>('input[type=radio]'),
    ];

    expect(radios.length).toBe(2);
    expect(radios[0].name).not.toBe('');
    expect(radios[0].name).toBe(radios[1].name);
    expect(
      container.querySelector('[role=radiogroup]')?.contains(radios[1]),
    ).toBe(true);
  });

  it('is operated by its label, reports its state and follows the group disabled state', async () => {
    const { container, fixture } = await render(ProjectedHostComponent);
    const host = fixture.componentInstance;
    const mute = container.querySelector('[data-testid=notify-mute]');

    expect(mute?.getAttribute('data-state')).toBe('idle');
    container.querySelector<HTMLElement>('label[for=notify-mute]')!.click();
    fixture.detectChanges();
    expect(host.value()).toBe('mute');
    expect(mute?.getAttribute('data-state')).toBe('selected');
    expect(
      container.querySelector<HTMLInputElement>('#notify-mute')?.checked,
    ).toBe(true);

    host.disabled.set(true);
    fixture.detectChanges();
    expect(
      container.querySelector<HTMLInputElement>('#notify-all')?.disabled,
    ).toBe(true);
  });
});

describe('TrnRadioGroupComponent', () => {
  it('limits the structural layout', () => {
    expectTypeOf<TrnRadioGroupLayout>().toEqualTypeOf<'list' | 'segmented'>();
  });

  it('renders the layout and invalid state on the radiogroup', async () => {
    const { container } = await render(CanonicalHostComponent);
    const host = container.querySelector('trn-radio-group');
    const group = container.querySelector('[role=radiogroup]');

    expect(host?.getAttribute('data-layout')).toBe('segmented');
    expect(group?.getAttribute('aria-invalid')).toBe('true');
  });
  it('renders one label per option, and wraps the radio in it', async () => {
    const { container } = await render(HostComponent);
    const labels = container.querySelectorAll('label');

    expect(labels.length).toBe(3);
    // The label WRAPPING the radio is the point, not decoration. It is what makes the text
    // a click target — e2e clicks `getByTestId('theme-dark')`, which is this label, not the
    // radio. A wrapper that emitted them as siblings would shrink the pointer target to the
    // indicator and visible text would no longer activate its native input.
    expect(labels[2].getAttribute('data-testid')).toBe('theme-dark');
    expect(labels[2].textContent?.trim()).toBe('Dark');
    expect(labels[2].querySelector('input[type=radio]')).not.toBeNull();
    expect(labels[0].textContent).toContain(
      'Follow this device automatically.',
    );
  });

  it('points the group at its heading, and only the group', async () => {
    // Rule 7: `aria-labelledby` has to reach the element that actually carries the role.
    // Left on the wrapper host it would name an element with no role at all, and the
    // radiogroup would stay anonymous — which is how it behaves today at the call site.
    const { container } = await render(HostComponent);

    expect(
      container
        .querySelector('[role="radiogroup"]')
        ?.getAttribute('aria-labelledby'),
    ).toBe('mode-heading');
    expect(
      container
        .querySelector('trn-radio-group')
        ?.hasAttribute('aria-labelledby'),
    ).toBe(false);
  });

  it('reports the chosen value', async () => {
    const { container, fixture } = await render(HostComponent);
    container.querySelectorAll('label')[1].click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('light');
  });

  it('forwards disabled to every radio option', async () => {
    const { container, fixture } = await render(HostComponent);

    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    expect(
      container.querySelectorAll('input[type=radio]:disabled'),
    ).toHaveLength(OPTIONS.length);
  });

  it('marks the active option in the segmented presentation', async () => {
    const { container } = await render(HostComponent);
    const host = container.querySelector('trn-radio-group');
    const selected = container.querySelector('[data-testid=theme-system]');

    expect(host?.getAttribute('data-layout')).toBe('segmented');
    expect(selected?.getAttribute('data-state')).toBe('selected');
  });
});
