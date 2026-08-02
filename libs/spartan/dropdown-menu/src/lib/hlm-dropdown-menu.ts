import { CdkMenu, CdkMenuGroup, CdkMenuItem, CdkMenuItemCheckbox, CdkMenuItemRadio, CdkMenuItemSelectable, CdkMenuTrigger, CdkTargetMenuAim } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, Directive, ElementRef, HOST_TAG_NAME, InjectionToken, booleanAttribute, computed, effect, forwardRef, inject, input, numberAttribute, signal, type ValueProvider } from '@angular/core';
import { InputModalityDetector } from '@angular/cdk/a11y';
import { MENU_SIDE, createMenuPosition, deriveMenuSideFromTransformOrigin, type MenuAlign, type MenuSide } from '@spartan-ng/brain/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { classes } from '@trinity/helm/utils';
import { lucideCheck, lucideChevronRight } from '@ng-icons/lucide';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type BooleanInput, type NumberInput } from '@angular/cdk/coercion';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ────────────────────────────┐
 *
 * Five deliberate local overrides live in this file. A regenerate drops all five; each is
 * commented at its site and pinned by a test in libs/spartan/overlay (the only spartan lib
 * with a Vitest target), so a lost override fails the suite rather than shipping.
 *
 *   1. HlmDropdownMenuSubTrigger — `_handleClick` shadowed so a sub-trigger click OPENS the
 *      submenu instead of toggling it closed under zoneless CD. See docs/architecture/state-and-reactivity.md.
 *   2. HlmDropdownMenuSubTrigger — the shadowed `_handleClick` also re-does CDK's focus move,
 *      so keyboard Enter/Space lands in the submenu.
 *   3. HlmDropdownMenuSubTrigger — `side` defaults to 'right' rather than the root-menu
 *      config, so a submenu opens BESIDE its parent instead of over it.
 *   4. HlmDropdownMenu / HlmDropdownMenuSub — CdkTargetMenuAim host directive, so travelling
 *      diagonally into an open submenu doesn't close it on the way.
 *   5. HlmDropdownMenuItem — a destructive item's TEXT and ICON use `text-danger`, not
 *      upstream's `text-destructive`. Helm's `--destructive` is a fill/tint token whose dark
 *      value is a near-black maroon (hsl(0 62.8% 30.6%)); on the dark popover surface that
 *      measured 1.38:1, so "Leave room" read as an empty strip. The `bg-destructive/10`
 *      hover tints are left alone — that IS the sanctioned use of the token. See CLAUDE.md
 *      ("never use Helm's --destructive as a foreground") and docs/architecture/ui-and-theming.md.
 *
 * The register lives in docs/architecture/ui-and-theming.md. Note this file is already a fork in shape as
 * well as content: the generator emits ~16 one-directive files, this is one module.
 *
 * └───────────────────────────────────────────────────────────────────────────────────────┘
 */

/**
 * @internal
 * Moves DOM focus to the hovered menu item. CDK menus only move focus with the keyboard, so on a pointer
 * the highlight would otherwise stay on the last keyboard-focused item (leaving two rows highlighted) and,
 * when a submenu closes, focus would fall to <body>, the menu stack would report no focus, and the whole
 * dropdown would collapse. Following the pointer with focus (Radix/shadcn behaviour) keeps a single
 * highlight and keeps focus inside the menu stack. setActiveMenuItem also syncs the key manager so keyboard
 * navigation continues from the hovered item.
 *
 * Applied as a host directive on every dropdown item type (item, checkbox, radio, sub-trigger).
 */
@Directive({
  selector: '[hlmDropdownMenuFocusOnHover]',
  host: {
    '(mouseenter)': '_focusOnHover()',
  },
})
export class HlmDropdownMenuFocusOnHover {
  private readonly _cdkMenuItem = inject(CdkMenuItem, { self: true });
  private readonly _parentMenu = inject(CdkMenu, { optional: true });
  private readonly _inputModality = inject(InputModalityDetector);

  protected _focusOnHover(): void {
    // Only skip synthetic hovers from touch taps; every real hover (mouse, or keyboard-then-hover,
    // which leaves the modality as 'keyboard') should move focus to keep a single highlight.
    if (this._inputModality.mostRecentModality === 'touch' || this._cdkMenuItem.disabled) {
      return;
    }
    this._parentMenu?.setActiveMenuItem(this._cdkMenuItem);
  }
}

@Component({
  selector: 'hlm-dropdown-menu-checkbox-indicator',
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-slot': 'dropdown-menu-checkbox-item-indicator' },
  template: `
    <ng-icon name="lucideCheck" />
  `,
})
export class HlmDropdownMenuCheckboxIndicator {
  constructor() {
    classes(
      () =>
        'absolute end-2 flex items-center justify-center [&_ng-icon]:text-[length:--spacing(4)] pointer-events-none opacity-0 group-data-checked/dropdown-menu-checkbox:opacity-100',
    );
  }
}

/** @internal. Use HlmDropdownMenuCheckbox instead. */
@Directive({
  selector: '[hlmDropdownMenuCheckboxCdk]',
  providers: [
    { provide: CdkMenuItemCheckbox, useExisting: HlmDropdownMenuCheckboxCdk },
    { provide: CdkMenuItemSelectable, useExisting: HlmDropdownMenuCheckboxCdk },
    { provide: CdkMenuItem, useExisting: CdkMenuItemSelectable },
  ],
})
export class HlmDropdownMenuCheckboxCdk extends CdkMenuItemCheckbox {
  public readonly keepOpen = input<boolean, BooleanInput>(true, { transform: booleanAttribute });

  public override trigger(options?: { keepOpen: boolean }) {
    super.trigger({ ...options, keepOpen: this.keepOpen() });
  }
}

@Directive({
  selector: '[hlmDropdownMenuCheckbox],[hlmDropdownMenuCheckboxItem]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuCheckboxCdk,
      inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuItemChecked: checked', 'keepOpen'],
      outputs: ['cdkMenuItemTriggered: triggered'],
    },
    HlmDropdownMenuFocusOnHover,
  ],
  host: {
    'data-slot': 'dropdown-menu-checkbox-item',
    '[attr.data-disabled]': '_cdkMenuItem.disabled ? "" : null',
    '[attr.data-checked]': '_cdkMenuItem.checked ? "" : null',
    '[attr.data-inset]': 'inset() ? "" : null',
  },
})
export class HlmDropdownMenuCheckbox {
  protected readonly _cdkMenuItem = inject(HlmDropdownMenuCheckboxCdk);

  public readonly inset = input<boolean, BooleanInput>(false, {
    transform: booleanAttribute,
  });

  constructor() {
    classes(
      () =>
        'hover:bg-accent focus:bg-accent hover:text-accent-foreground focus:text-accent-foreground hover:**:text-accent-foreground focus:**:text-accent-foreground gap-2.5 rounded-lg py-2 ps-3 pe-8 text-sm font-medium data-inset:ps-9.5 [&_ng-icon:not([class*=\'text-\'])]:text-[length:--spacing(4)] group/dropdown-menu-checkbox relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
    );
  }
}


@Directive({
  selector: '[hlmDropdownMenuGroup],hlm-dropdown-menu-group',
  hostDirectives: [CdkMenuGroup],
  host: { 'data-slot': 'dropdown-menu-group' },
})
export class HlmDropdownMenuGroup {
  constructor() {
    classes(() => 'block');
  }
}

@Component({
  selector: 'hlm-dropdown-menu-item-sub-indicator',
  imports: [NgIcon],
  providers: [provideIcons({ lucideChevronRight })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-icon name="lucideChevronRight" class="text-[length:--spacing(4)] rtl:rotate-180" />
  `,
})
export class HlmDropdownMenuItemSubIndicator {
  constructor() {
    classes(() => 'ms-auto flex items-center justify-center');
  }
}

@Directive({
  selector: '[hlmDropdownMenuItem],hlm-dropdown-menu-item',
  hostDirectives: [
    {
      directive: CdkMenuItem,
      inputs: ['cdkMenuItemDisabled: disabled'],
      outputs: ['cdkMenuItemTriggered: triggered'],
    },
    HlmDropdownMenuFocusOnHover,
  ],
  host: {
    'data-slot': 'dropdown-menu-item',
    '[attr.disabled]': '_isButton && disabled() ? "" : null',
    '[attr.data-disabled]': 'disabled() ? "" : null',
    '[attr.data-variant]': 'variant()',
    '[attr.data-inset]': 'inset() ? "" : null',
  },
})
export class HlmDropdownMenuItem {
  protected readonly _isButton = inject(HOST_TAG_NAME) === 'button';

  public readonly disabled = input<boolean, BooleanInput>(false, { transform: booleanAttribute });

  /**
   * `destructive` colours the row for an irreversible action. Note the class string below
   * says `text-danger`, NOT upstream's `text-destructive` — see override 5 in the banner.
   */
  public readonly variant = input<'default' | 'destructive'>('default');

  public readonly inset = input<boolean, BooleanInput>(false, {
    transform: booleanAttribute,
  });

  constructor() {
    classes(
      () =>
        'hover:bg-accent focus:bg-accent hover:text-accent-foreground focus:text-accent-foreground data-[variant=destructive]:text-danger data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:hover:bg-destructive/20 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:hover:text-danger data-[variant=destructive]:focus:text-danger data-[variant=destructive]:*:[ng-icon]:text-danger not-data-[variant=destructive]:hover:**:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground gap-2.5 rounded-lg px-3 py-2 text-sm font-medium data-inset:ps-9.5 [&_ng-icon:not([class*=\'text-\'])]:text-[length:--spacing(4)] group/dropdown-menu-item relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
    );
  }
}

@Directive({
  selector: '[hlmDropdownMenuLabel],hlm-dropdown-menu-label',
  host: {
    'data-slot': 'dropdown-menu-label',
    '[attr.data-inset]': 'inset() ? "" : null',
  },
})
export class HlmDropdownMenuLabel {
  public readonly inset = input<boolean, BooleanInput>(false, {
    transform: booleanAttribute,
  });

  constructor() {
    classes(() => 'text-muted-foreground px-3 py-2.5 text-xs data-inset:ps-9.5 block');
  }
}

@Component({
  selector: 'hlm-dropdown-menu-radio-indicator',
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-slot': 'dropdown-menu-radio-item-indicator' },
  template: `
    <ng-icon name="lucideCheck" />
  `,
})
export class HlmDropdownMenuRadioIndicator {
  constructor() {
    classes(
      () =>
        'absolute end-2 flex items-center justify-center [&_ng-icon]:text-[length:--spacing(4)] pointer-events-none opacity-0 group-data-checked/dropdown-menu-radio:opacity-100',
    );
  }
}

/** @internal. Use HlmDropdownMenuRadio instead. */
@Directive({
  selector: '[hlmDropdownMenuRadioCdk]',
  providers: [
    { provide: CdkMenuItemRadio, useExisting: HlmDropdownMenuRadioCdk },
    { provide: CdkMenuItemSelectable, useExisting: HlmDropdownMenuRadioCdk },
    { provide: CdkMenuItem, useExisting: CdkMenuItemSelectable },
  ],
})
export class HlmDropdownMenuRadioCdk extends CdkMenuItemRadio {
  public readonly keepOpen = input<boolean, BooleanInput>(true, { transform: booleanAttribute });

  public override trigger(options?: { keepOpen: boolean }) {
    super.trigger({ ...options, keepOpen: this.keepOpen() });
  }
}

@Directive({
  selector: '[hlmDropdownMenuRadio]',
  hostDirectives: [
    {
      directive: HlmDropdownMenuRadioCdk,
      inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuItemChecked: checked', 'keepOpen'],
      outputs: ['cdkMenuItemTriggered: triggered'],
    },
    HlmDropdownMenuFocusOnHover,
  ],
  host: {
    'data-slot': 'dropdown-menu-radio-item',
    '[attr.data-disabled]': '_cdkMenuItem.disabled ? "" : null',
    '[attr.data-checked]': '_cdkMenuItem.checked ? "" : null',
  },
})
export class HlmDropdownMenuRadio {
  protected readonly _cdkMenuItem = inject(HlmDropdownMenuRadioCdk);

  constructor() {
    classes(
      () =>
        'hover:bg-accent focus:bg-accent hover:text-accent-foreground focus:text-accent-foreground hover:**:text-accent-foreground focus:**:text-accent-foreground gap-2.5 rounded-lg py-2 ps-3 pe-8 text-sm font-medium data-inset:ps-9.5 [&_ng-icon:not([class*=\'text-\'])]:text-[length:--spacing(4)] group/dropdown-menu-radio relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
    );
  }
}

@Directive({
  selector: '[hlmDropdownMenuSeparator],hlm-dropdown-menu-separator',
  host: { 'data-slot': 'dropdown-menu-separator' },
})
export class HlmDropdownMenuSeparator {
  constructor() {
    classes(() => 'bg-border/50 -mx-1.5 my-1.5 h-px block');
  }
}

@Directive({
  selector: '[hlmDropdownMenuShortcut],hlm-dropdown-menu-shortcut',
  host: { 'data-slot': 'dropdown-menu-shortcut' },
})
export class HlmDropdownMenuShortcut {
  constructor() {
    classes(() => 'text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground ms-auto text-xs tracking-widest');
  }
}

@Directive({
  selector: '[hlmDropdownMenuSubTrigger]',
  providers: [{ provide: MENU_SIDE, useExisting: forwardRef(() => HlmDropdownMenuSubTrigger) }],
  hostDirectives: [
    {
      directive: CdkMenuTrigger,
      inputs: ['cdkMenuTriggerFor: hlmDropdownMenuSubTrigger', 'cdkMenuTriggerData: hlmDropdownMenuTriggerData'],
      outputs: ['cdkMenuOpened: hlmDropdownMenuSubOpened', 'cdkMenuClosed: hlmDropdownMenuSubClosed'],
    },
  ],
  host: { 'data-slot': 'dropdown-menu-sub-trigger' },
})
export class HlmDropdownMenuSubTrigger {
  private readonly _cdkTrigger = inject(CdkMenuTrigger, { host: true });
  private readonly _config = injectHlmDropdownMenuConfig();

  public readonly align = input<MenuAlign>(this._config.align);
  /**
   * LOCAL OVERRIDE (3 of 3 — see the banner at the top of this file).
   *
   * Upstream defaults this to `this._config.side`, i.e. the ROOT-menu default of 'bottom', so a
   * submenu is positioned like a dropdown: `createMenuPosition('start','bottom')` yields only
   * "below the trigger" and its mirror "above the trigger". Both sit inside the parent menu's
   * rectangle whenever the sub-trigger has rows beneath it, so the submenu covers the menu that
   * spawned it — the flip isn't even needed to reproduce it.
   *
   * 'right' yields "beside the trigger" and its mirror "beside it on the other side", neither of
   * which can land on the parent. This restores CDK's own intent: `CdkMenuTrigger` defaults a
   * trigger inside a vertical menu to STANDARD_DROPDOWN_ADJACENT_POSITIONS, and the effect below
   * overwrites that unconditionally. `HlmDropdownMenuSub` already believes the same thing — its
   * `_side` falls back to 'right' — so today the trigger and its content disagree.
   *
   * `align` is deliberately left on the config's 'start': it top-aligns the submenu's first row
   * with the trigger row, which also minimises the pointer travel between them.
   */
  public readonly side = input<MenuSide>('right');

  private readonly _menuPosition = computed(() => createMenuPosition(this.align(), this.side()));

  constructor() {
    // CDK sets transform-origin on the submenu content from the resolved position; the content reads it
    // to animate from the anchored corner and to derive its data-side. Cast tolerates @angular/cdk < 21.2
    // (we still support >=21.0), where the property is absent and the assignment is a harmless no-op.
    (this._cdkTrigger as { transformOriginSelector?: string }).transformOriginSelector =
      '[data-slot="dropdown-menu-sub"]';

    effect(() => {
      this._cdkTrigger.menuPosition = this._menuPosition();
    });

    // A submenu trigger opens its submenu on hover. CDK's own click handler calls toggle(),
    // which *closes* an already-open submenu — so a mouse user who hovers (opening it) and
    // then clicks the trigger closes it again. Under zone.js the overlay attach was deferred
    // enough that the click usually landed while the submenu still read as closed and so
    // opened it; under provideZonelessChangeDetection() the attach is synchronous, isOpen()
    // is already true at click time, and the click deterministically closes it. Match
    // radix/shadcn submenu semantics instead: a sub-trigger click opens (or keeps open) the
    // submenu, never toggles it closed. open() is guarded on !isOpen(), so this is idempotent.
    // The compiled host listener resolves _handleClick on the instance at event time, so
    // shadowing it here reliably supersedes CDK's toggle() without touching event ordering.
    (this._cdkTrigger as { _handleClick?: () => void })._handleClick = () => {
      this._cdkTrigger.open();
      // Preserve the focus move CDK's own _handleClick did after toggling: on a
      // <button> sub-trigger, keyboard Enter/Space dispatches a native click that is
      // the sole activation path through this override, so without this the submenu
      // opens but focus stays on the trigger. focusFirstItem no-ops if already open.
      (
        this._cdkTrigger as {
          getMenu?: () => { focusFirstItem?: (origin: 'mouse') => void } | null;
        }
      )
        .getMenu?.()
        ?.focusFirstItem?.('mouse');
    };

    classes(() => 'aria-expanded:bg-accent aria-expanded:text-accent-foreground');
  }
}

@Directive({
  selector: '[hlmDropdownMenuSub],hlm-dropdown-menu-sub',
  hostDirectives: [CdkMenu, CdkTargetMenuAim],
  host: {
    'data-slot': 'dropdown-menu-sub',
    '[attr.data-state]': '_state()',
    '[attr.data-side]': '_side()',
  },
})
export class HlmDropdownMenuSub {
  private readonly _host = inject(CdkMenu);
  private readonly _elementRef = inject(ElementRef<HTMLElement>);
  // The sub-trigger provides its configured side; CDK parents this content's injector under it.
  private readonly _menuSide = inject(MENU_SIDE, { optional: true });

  protected readonly _state = signal('open');
  protected readonly _side = signal<MenuSide>(this._menuSide?.side() ?? 'right');

  constructor() {
    this.setSideFromTransformOrigin();
    // this is a best effort, but does not seem to work currently
    // TODO: figure out a way for us to know the host is about to be closed. might not be possible with CDK
    this._host.closed.pipe(takeUntilDestroyed()).subscribe(() => this._state.set('closed'));

    classes(() => 'motion-safe:data-open:animate-in motion-safe:data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/5 dark:ring-foreground/10 bg-popover text-popover-foreground min-w-36 rounded-xl p-1.5 shadow-lg ring-1 duration-100 w-auto');
  }

  private setSideFromTransformOrigin() {
    const side = this._menuSide?.side() ?? 'right';
    // CDK sets transform-origin on this element synchronously on attach; read it next tick and derive side
    setTimeout(() => {
      this._side.set(deriveMenuSideFromTransformOrigin(this._elementRef.nativeElement.style.transformOrigin, side));
    });
  }
}

export interface HlmDropdownMenuConfig {
  align: MenuAlign;
  side: MenuSide;
}

const defaultConfig: HlmDropdownMenuConfig = {
  align: 'start',
  side: 'bottom',
};

const HlmDropdownMenuConfigToken = new InjectionToken<HlmDropdownMenuConfig>('HlmDropdownMenuConfig');

export function provideHlmDropdownMenuConfig(config: Partial<HlmDropdownMenuConfig>): ValueProvider {
  return { provide: HlmDropdownMenuConfigToken, useValue: { ...defaultConfig, ...config } };
}

export function injectHlmDropdownMenuConfig(): HlmDropdownMenuConfig {
  return inject(HlmDropdownMenuConfigToken, { optional: true }) ?? defaultConfig;
}

@Directive({
  selector: '[hlmDropdownMenuTrigger]',
  providers: [{ provide: MENU_SIDE, useExisting: forwardRef(() => HlmDropdownMenuTrigger) }],
  hostDirectives: [
    {
      directive: CdkMenuTrigger,
      inputs: ['cdkMenuTriggerFor: hlmDropdownMenuTrigger', 'cdkMenuTriggerData: hlmDropdownMenuTriggerData'],
      outputs: ['cdkMenuOpened: hlmDropdownMenuOpened', 'cdkMenuClosed: hlmDropdownMenuClosed'],
    },
  ],
  host: { 'data-slot': 'dropdown-menu-trigger' },
})
export class HlmDropdownMenuTrigger {
  private readonly _cdkTrigger = inject(CdkMenuTrigger, { host: true });
  private readonly _config = injectHlmDropdownMenuConfig();

  public readonly align = input<MenuAlign>(this._config.align);
  public readonly side = input<MenuSide>(this._config.side);

  private readonly _menuPosition = computed(() => createMenuPosition(this.align(), this.side()));

  constructor() {
    // CDK sets transform-origin on the menu content from the resolved position; the content reads it to
    // animate from the anchored corner and to derive its data-side. Cast tolerates @angular/cdk < 21.2
    // (we still support >=21.0), where the property is absent and the assignment is a harmless no-op.
    (this._cdkTrigger as { transformOriginSelector?: string }).transformOriginSelector = '[data-slot="dropdown-menu"]';

    effect(() => {
      this._cdkTrigger.menuPosition = this._menuPosition();
    });
  }
}

@Directive({
  selector: '[hlmDropdownMenu],hlm-dropdown-menu',
  hostDirectives: [CdkMenu, CdkTargetMenuAim],
  host: {
    'data-slot': 'dropdown-menu',
    '[attr.data-state]': '_state()',
    '[attr.data-side]': '_side()',
    '[style.--side-offset]': 'sideOffset()',
  },
})
export class HlmDropdownMenu {
  private readonly _host = inject(CdkMenu);
  private readonly _elementRef = inject(ElementRef<HTMLElement>);
  // The trigger provides its configured side; CDK parents this content's injector under the trigger's.
  private readonly _menuSide = inject(MENU_SIDE, { optional: true });

  protected readonly _state = signal('open');
  protected readonly _side = signal<MenuSide>(this._menuSide?.side() ?? 'bottom');

  public readonly sideOffset = input<number, NumberInput>(1, { transform: numberAttribute });

  constructor() {
    classes(
      () =>
        'motion-safe:data-open:animate-in motion-safe:data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/5 dark:ring-foreground/10 bg-popover text-popover-foreground min-w-48 rounded-xl p-1.5 shadow-lg ring-1 duration-100 my-[--spacing(var(--side-offset))] overflow-x-hidden overflow-y-auto outline-none',
    );

    this.setSideFromTransformOrigin();
    // this is a best effort, but does not seem to work currently
    // TODO: figure out a way for us to know the host is about to be closed. might not be possible with CDK
    this._host.closed.pipe(takeUntilDestroyed()).subscribe(() => this._state.set('closed'));
  }

  private setSideFromTransformOrigin() {
    const side = this._menuSide?.side() ?? 'bottom';
    // CDK sets transform-origin on this element synchronously on attach; read it next tick and derive side
    setTimeout(() => {
      this._side.set(deriveMenuSideFromTransformOrigin(this._elementRef.nativeElement.style.transformOrigin, side));
    });
  }
}

export const HlmDropdownMenuImports = [
  HlmDropdownMenu,
  HlmDropdownMenuCheckbox,
  HlmDropdownMenuCheckboxIndicator,
  HlmDropdownMenuGroup,
  HlmDropdownMenuItem,
  HlmDropdownMenuItemSubIndicator,
  HlmDropdownMenuLabel,
  HlmDropdownMenuRadio,
  HlmDropdownMenuRadioIndicator,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuShortcut,
  HlmDropdownMenuSub,
  HlmDropdownMenuSubTrigger,
  HlmDropdownMenuTrigger,
] as const;