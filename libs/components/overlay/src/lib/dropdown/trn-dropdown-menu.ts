import {
  CdkMenuItemCheckbox,
  CdkMenuItemRadio,
  CdkMenuTrigger,
} from '@angular/cdk/menu';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  booleanAttribute,
  effect,
  inject,
  input,
  output,
  TemplateRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  HlmDropdownMenu,
  HlmDropdownMenuCheckbox,
  HlmDropdownMenuCheckboxCdk,
  HlmDropdownMenuCheckboxIndicator,
  HlmDropdownMenuItem,
  HlmDropdownMenuItemSubIndicator,
  HlmDropdownMenuLabel,
  HlmDropdownMenuRadio,
  HlmDropdownMenuRadioCdk,
  HlmDropdownMenuRadioIndicator,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuSub,
  HlmDropdownMenuSubTrigger,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';

/** Trinity-owned dropdown surface. */
@Directive({
  selector: '[trnDropdownMenu]',
  hostDirectives: [
    { directive: HlmDropdownMenu, inputs: ['sideOffset'], outputs: [] },
  ],
})
export class TrnDropdownMenu {}

/** Trinity-owned dropdown trigger and its open/close lifecycle. */
@Directive({
  selector: '[trnDropdownMenuTrigger]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuTrigger,
      inputs: ['align', 'side'],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuTrigger {
  private readonly cdkTrigger = inject(CdkMenuTrigger, { host: true });

  readonly trnDropdownMenuTrigger = input<TemplateRef<unknown> | null>(null);
  readonly trnDropdownMenuTriggerData = input<unknown>();
  readonly trnDropdownMenuOpened = output<void>();
  readonly trnDropdownMenuClosed = output<void>();

  constructor() {
    effect(() => {
      this.cdkTrigger.menuTemplateRef = this.trnDropdownMenuTrigger();
      this.cdkTrigger.menuData = this.trnDropdownMenuTriggerData();
    });
    this.cdkTrigger.opened
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.trnDropdownMenuOpened.emit());
    this.cdkTrigger.closed
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.trnDropdownMenuClosed.emit());
  }

  /** Opens this trigger's configured menu without exposing the CDK trigger. */
  open(): void {
    this.cdkTrigger.open();
  }
}

/** Trinity-owned dropdown row. */
@Directive({
  selector: '[trnDropdownMenuItem]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuItem,
      inputs: ['disabled', 'variant', 'inset'],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuItem {}

@Directive({
  selector: '[trnDropdownMenuLabel]',
  hostDirectives: [
    { directive: HlmDropdownMenuLabel, inputs: ['inset'], outputs: [] },
  ],
})
export class TrnDropdownMenuLabel {}

@Directive({
  selector: '[trnDropdownMenuSeparator]',
  hostDirectives: [
    { directive: HlmDropdownMenuSeparator, inputs: [], outputs: [] },
  ],
})
export class TrnDropdownMenuSeparator {}

@Directive({
  selector: '[trnDropdownMenuRadio]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuRadio,
      inputs: [],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuRadio {
  private readonly cdkItem = inject(HlmDropdownMenuRadioCdk, { host: true });

  readonly disabled = input(false, { transform: booleanAttribute });
  readonly checked = input(false, { transform: booleanAttribute });
  readonly keepOpen = input(true, { transform: booleanAttribute });

  constructor() {
    effect(() => {
      this.cdkItem.disabled = this.disabled();
      this.cdkItem.checked = this.checked();
    });
    this.cdkItem.trigger = (options?: { keepOpen: boolean }) =>
      CdkMenuItemRadio.prototype.trigger.call(this.cdkItem, {
        ...options,
        keepOpen: this.keepOpen(),
      });
  }
}

@Directive({
  selector: '[trnDropdownMenuCheckbox]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuCheckbox,
      inputs: ['inset'],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuCheckbox {
  private readonly cdkItem = inject(HlmDropdownMenuCheckboxCdk, {
    host: true,
  });

  readonly disabled = input(false, { transform: booleanAttribute });
  readonly checked = input(false, { transform: booleanAttribute });
  readonly keepOpen = input(true, { transform: booleanAttribute });

  constructor() {
    effect(() => {
      this.cdkItem.disabled = this.disabled();
      this.cdkItem.checked = this.checked();
    });
    this.cdkItem.trigger = (options?: { keepOpen: boolean }) =>
      CdkMenuItemCheckbox.prototype.trigger.call(this.cdkItem, {
        ...options,
        keepOpen: this.keepOpen(),
      });
  }
}

@Directive({
  selector: '[trnDropdownMenuSubTrigger]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuSubTrigger,
      inputs: ['align', 'side'],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuSubTrigger {
  private readonly cdkTrigger = inject(CdkMenuTrigger, { host: true });

  readonly trnDropdownMenuSubTrigger = input<TemplateRef<unknown> | null>(null);
  readonly trnDropdownMenuTriggerData = input<unknown>();
  readonly trnDropdownMenuSubOpened = output<void>();
  readonly trnDropdownMenuSubClosed = output<void>();

  constructor() {
    effect(() => {
      this.cdkTrigger.menuTemplateRef = this.trnDropdownMenuSubTrigger();
      this.cdkTrigger.menuData = this.trnDropdownMenuTriggerData();
    });
    this.cdkTrigger.opened
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.trnDropdownMenuSubOpened.emit());
    this.cdkTrigger.closed
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.trnDropdownMenuSubClosed.emit());
  }
}

@Directive({
  selector: '[trnDropdownMenuSub]',
  hostDirectives: [{ directive: HlmDropdownMenuSub, inputs: [], outputs: [] }],
})
export class TrnDropdownMenuSub {}

@Component({
  selector: 'trn-dropdown-menu-checkbox-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuCheckboxIndicator],
  host: { class: 'contents' },
  template: `<hlm-dropdown-menu-checkbox-indicator />`,
})
export class TrnDropdownMenuCheckboxIndicatorComponent {}

@Component({
  selector: 'trn-dropdown-menu-radio-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuRadioIndicator],
  host: { class: 'contents' },
  template: `<hlm-dropdown-menu-radio-indicator />`,
})
export class TrnDropdownMenuRadioIndicatorComponent {}

@Component({
  selector: 'trn-dropdown-menu-item-sub-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuItemSubIndicator],
  host: { class: 'contents' },
  template: `<hlm-dropdown-menu-item-sub-indicator />`,
})
export class TrnDropdownMenuItemSubIndicatorComponent {}

export const TrnDropdownMenuImports = [
  TrnDropdownMenu,
  TrnDropdownMenuTrigger,
  TrnDropdownMenuItem,
  TrnDropdownMenuLabel,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuRadio,
  TrnDropdownMenuCheckbox,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuSub,
  TrnDropdownMenuCheckboxIndicatorComponent,
  TrnDropdownMenuRadioIndicatorComponent,
  TrnDropdownMenuItemSubIndicatorComponent,
] as const;
