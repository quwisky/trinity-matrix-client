import { Directive } from '@angular/core';

/** Prototype-aligned label/description/control row for Settings detail panes. */
@Directive({
  selector: '[trnSettingsFieldRow]',
  host: {
    class:
      'grid min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))] grid-cols-1 items-center gap-[var(--trinity-space-3)] border-t border-solid border-[var(--trinity-border-subtle)] py-[var(--trinity-space-3)] md:grid-cols-[minmax(0,1fr)_minmax(10rem,12rem)] md:gap-[var(--trinity-space-5)]',
  },
})
export class SettingsFieldRowDirective {}
