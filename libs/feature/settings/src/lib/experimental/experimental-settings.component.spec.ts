import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrnSwitchComponent } from '@trinity/components/controls';
import { FeatureFlagsService } from '@trinity/platform-native';
import { ExperimentalSettingsComponent } from './experimental-settings.component';

describe('ExperimentalSettingsComponent', () => {
  let virtualTimeline: ReturnType<typeof signal<boolean>>;
  let deferMediaWhileScrolling: ReturnType<typeof signal<boolean>>;
  let flingPlaceholders: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    virtualTimeline = signal(false);
    deferMediaWhileScrolling = signal(false);
    flingPlaceholders = signal(false);
  });

  function renderPage() {
    return render(ExperimentalSettingsComponent, {
      providers: [
        MockProvider(FeatureFlagsService, {
          virtualTimeline,
          deferMediaWhileScrolling,
          flingPlaceholders,
        }),
      ],
    });
  }

  /** The switch inside one flag's row. */
  function switchIn(
    fixture: Awaited<ReturnType<typeof renderPage>>['fixture'],
    testId: string,
  ): TrnSwitchComponent {
    return fixture.debugElement
      .query(By.css(`[data-testid=${testId}]`))
      .query(By.directive(TrnSwitchComponent)).componentInstance;
  }

  it('reflects and toggles the virtualized-timeline flag', async () => {
    const { fixture, container } = await renderPage();

    expect(
      container.querySelector('[data-testid=flag-virtual-timeline]'),
    ).not.toBeNull();
    const control = fixture.debugElement.query(
      By.directive(TrnSwitchComponent),
    );
    expect(control.componentInstance.checked()).toBe(false); // off by default

    // The switch reflects the persisted signal.
    virtualTimeline.set(true);
    fixture.detectChanges();
    expect(control.componentInstance.checked()).toBe(true);

    // Toggling emits checkedChange → the flag is persisted.
    control.componentInstance.checkedChange.emit(false);
    expect(
      TestBed.inject(FeatureFlagsService).setVirtualTimeline,
    ).toHaveBeenCalledWith(false);
  });

  it('offers loading images after fast scrolling as an opt-in, and toggles it', async () => {
    const { fixture } = await renderPage();

    // Named by its own label, with the description that says what it is for.
    const control = screen.getByRole('switch', {
      name: 'Load images after fast scrolling',
    });
    expect(control).toHaveAccessibleDescription(
      'Images in the timeline wait until scrolling slows down, which uses less memory.',
    );
    const toggle = switchIn(fixture, 'flag-defer-media');
    expect(toggle.checked()).toBe(false);

    deferMediaWhileScrolling.set(true);
    fixture.detectChanges();
    expect(toggle.checked()).toBe(true);

    toggle.checkedChange.emit(false);
    expect(
      TestBed.inject(FeatureFlagsService).setDeferMediaWhileScrolling,
    ).toHaveBeenCalledWith(false);
  });

  it('offers blank rows while scrolling fast as an opt-in, and toggles it', async () => {
    const { fixture } = await renderPage();

    const control = screen.getByRole('switch', {
      name: 'Blank rows while scrolling fast',
    });
    expect(control).toHaveAccessibleDescription(
      'Messages that fly past show as blank space until scrolling slows down, which uses less memory.',
    );
    const toggle = switchIn(fixture, 'flag-fling-placeholders');
    expect(toggle.checked()).toBe(false);

    flingPlaceholders.set(true);
    fixture.detectChanges();
    expect(toggle.checked()).toBe(true);

    toggle.checkedChange.emit(false);
    expect(
      TestBed.inject(FeatureFlagsService).setFlingPlaceholders,
    ).toHaveBeenCalledWith(false);
  });
});
