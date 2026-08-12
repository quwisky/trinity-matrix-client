import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrnCheckbox } from '@trinity/kit/checkbox';
import { FeatureFlagsService } from '@trinity/platform-native';
import { ExperimentalSettingsComponent } from './experimental-settings.component';

describe('ExperimentalSettingsComponent', () => {
  let virtualTimeline: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    virtualTimeline = signal(false);
  });

  function renderPage() {
    return render(ExperimentalSettingsComponent, {
      providers: [MockProvider(FeatureFlagsService, { virtualTimeline })],
    });
  }

  it('reflects and toggles the virtualized-timeline flag', async () => {
    const { fixture, container } = await renderPage();

    expect(
      container.querySelector('[data-testid=flag-virtual-timeline]'),
    ).not.toBeNull();
    const checkbox = fixture.debugElement.query(By.directive(TrnCheckbox));
    expect(checkbox.componentInstance.checked()).toBe(false); // off by default

    // The checkbox reflects the persisted signal.
    virtualTimeline.set(true);
    fixture.detectChanges();
    expect(checkbox.componentInstance.checked()).toBe(true);

    // Toggling emits checkedChange → the flag is persisted.
    checkbox.componentInstance.checkedChange.emit(false);
    expect(
      TestBed.inject(FeatureFlagsService).setVirtualTimeline,
    ).toHaveBeenCalledWith(false);
  });
});
