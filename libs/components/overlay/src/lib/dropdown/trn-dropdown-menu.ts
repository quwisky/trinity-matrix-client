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
  computed,
  effect,
  forwardRef,
  inject,
  input,
  output,
  TemplateRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MENU_SIDE, createMenuPosition } from '@spartan-ng/brain/core';
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
import { classes } from '@trinity/helm/utils';
import type {
  TrnOverlayAlign,
  TrnOverlaySide,
} from '../position/trn-overlay-position';
import {
  normalizeTrnDropdownMenuItemVariant,
  trnDropdownMenuItemRecipe,
  type TrnDropdownMenuItemVariantInput,
} from './trn-dropdown-menu-recipe';

export type {
  TrnDropdownMenuItemVariant,
  TrnDropdownMenuItemVariantInput,
} from './trn-dropdown-menu-recipe';

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
  providers: [
    {
      provide: MENU_SIDE,
      useExisting: forwardRef(() => TrnDropdownMenuTrigger),
    },
  ],
  hostDirectives: [
    {
      directive: HlmDropdownMenuTrigger,
      inputs: [],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuTrigger {
  private readonly cdkTrigger = inject(CdkMenuTrigger, { host: true });
  private readonly positions = computed(() =>
    createMenuPosition(this.align(), this.side()),
  );

  readonly trnDropdownMenuTrigger = input<TemplateRef<unknown> | null>(null);
  readonly trnDropdownMenuTriggerData = input<unknown>();
  readonly trnDropdownMenuOpened = output<void>();
  readonly trnDropdownMenuClosed = output<void>();
  readonly align = input<TrnOverlayAlign>('start');
  readonly side = input<TrnOverlaySide>('bottom');

  constructor() {
    effect(() => {
      this.cdkTrigger.menuTemplateRef = this.trnDropdownMenuTrigger();
      this.cdkTrigger.menuData = this.trnDropdownMenuTriggerData();
    });
    effect(() => {
      this.cdkTrigger.menuPosition = this.positions();
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
      inputs: ['disabled', 'inset'],
      outputs: [],
    },
  ],
  host: {
    '[attr.data-trn-variant]': 'normalizedVariant()',
  },
})
export class TrnDropdownMenuItem {
  protected readonly normalizedVariant = computed(() =>
    normalizeTrnDropdownMenuItemVariant(this.variant()),
  );
  readonly variant = input<TrnDropdownMenuItemVariantInput>('neutral');

  constructor() {
    classes(() => trnDropdownMenuItemRecipe(this.normalizedVariant()));
  }
}

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
  providers: [
    {
      provide: MENU_SIDE,
      useExisting: forwardRef(() => TrnDropdownMenuSubTrigger),
    },
  ],
  hostDirectives: [
    {
      directive: HlmDropdownMenuSubTrigger,
      inputs: [],
      outputs: [],
    },
  ],
})
export class TrnDropdownMenuSubTrigger {
  private readonly cdkTrigger = inject(CdkMenuTrigger, { host: true });
  private readonly positions = computed(() =>
    createMenuPosition(this.align(), this.side()),
  );

  readonly trnDropdownMenuSubTrigger = input<TemplateRef<unknown> | null>(null);
  readonly trnDropdownMenuTriggerData = input<unknown>();
  readonly trnDropdownMenuSubOpened = output<void>();
  readonly trnDropdownMenuSubClosed = output<void>();
  readonly align = input<TrnOverlayAlign>('start');
  readonly side = input<TrnOverlaySide>('right');

  constructor() {
    effect(() => {
      this.cdkTrigger.menuTemplateRef = this.trnDropdownMenuSubTrigger();
      this.cdkTrigger.menuData = this.trnDropdownMenuTriggerData();
    });
    effect(() => {
      this.cdkTrigger.menuPosition = this.positions();
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
