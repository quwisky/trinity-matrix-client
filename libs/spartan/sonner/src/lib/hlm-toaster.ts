import type { BooleanInput, NumberInput } from '@angular/cdk/coercion';
import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  inject,
  booleanAttribute,
  computed,
  input,
  numberAttribute,
  type OnDestroy,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideInfo,
  lucideLoader2,
  lucideOctagonX,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { BrnSonnerImports, type ToasterProps } from '@spartan-ng/brain/sonner';
import { hlm } from '@trinity/helm/utils';
import type { ClassValue } from 'clsx';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ───────────────┐
 *
 * Trinity repairs Brain Sonner's emitted list and live-region roles. Brain
 * inserts a component host between `<ol>` and `<li>`, then overrides the
 * `<li>` with `role="status"`; both shapes fail Axe. The private directive
 * keeps the list structure and moves the live region to its containing
 * section after each toast render.
 *
 * The override is registered in the developer UI and theming guide and pinned
 * by the real public toaster render test.
 * └──────────────────────────────────────────────────────────────────────────┘
 */

@Directive({ selector: 'brn-sonner-toaster' })
class HlmSonnerSemantics implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
  private observer?: MutationObserver;

  ngAfterViewInit(): void {
    this.normalizeRoles();
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    this.observer = new MutationObserver(() => this.normalizeRoles());
    this.observer.observe(this.host, { childList: true, subtree: true });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private normalizeRoles(): void {
    const region = this.host.querySelector('section');
    region?.setAttribute('role', 'region');

    for (const list of this.host.querySelectorAll('[data-sonner-toaster]')) {
      list.setAttribute('role', 'group');
    }

    for (const toastHost of this.host.querySelectorAll('brn-sonner-toast')) {
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      toastHost.setAttribute('aria-atomic', 'true');
      toastHost.setAttribute('tabindex', '0');
      const toast = toastHost.querySelector('[data-sonner-toast]');
      toast?.setAttribute('role', 'none');
      toast?.removeAttribute('aria-live');
      toast?.removeAttribute('aria-atomic');
      toast?.removeAttribute('tabindex');
    }
  }
}

@Component({
  selector: 'hlm-toaster',
  imports: [BrnSonnerImports, NgIcon, HlmSonnerSemantics],
  providers: [
    provideIcons({
      lucideCircleCheck,
      lucideInfo,
      lucideTriangleAlert,
      lucideOctagonX,
      lucideLoader2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <brn-sonner-toaster
      [class]="_computedClass()"
      [invert]="invert()"
      [theme]="theme()"
      [position]="position()"
      [hotKey]="hotKey()"
      [richColors]="richColors()"
      [expand]="expand()"
      [duration]="duration()"
      [visibleToasts]="visibleToasts()"
      [closeButton]="closeButton()"
      [toastOptions]="_computedToastOptions()"
      [offset]="offset()"
      [style]="userStyle()"
    >
      <ng-template #loadingIcon>
        <ng-icon
          name="lucideLoader2"
          class="overflow-visible! text-base [&>svg]:motion-safe:animate-spin"
        />
      </ng-template>
      <ng-template #successIcon>
        <ng-icon name="lucideCircleCheck" class="overflow-visible! text-base" />
      </ng-template>
      <ng-template #errorIcon>
        <ng-icon name="lucideOctagonX" class="overflow-visible! text-base" />
      </ng-template>
      <ng-template #infoIcon>
        <ng-icon name="lucideInfo" class="overflow-visible! text-base" />
      </ng-template>
      <ng-template #warningIcon>
        <ng-icon
          name="lucideTriangleAlert"
          class="overflow-visible! text-base"
        />
      </ng-template>
    </brn-sonner-toaster>
  `,
})
export class HlmToaster {
  public readonly invert = input<ToasterProps['invert'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly theme = input<ToasterProps['theme']>('light');
  public readonly position = input<ToasterProps['position']>('bottom-right');
  public readonly hotKey = input<ToasterProps['hotkey']>(['altKey', 'KeyT']);
  public readonly richColors = input<ToasterProps['richColors'], BooleanInput>(
    false,
    {
      transform: booleanAttribute,
    },
  );
  public readonly expand = input<ToasterProps['expand'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly duration = input<ToasterProps['duration'], NumberInput>(
    4000,
    {
      transform: numberAttribute,
    },
  );
  public readonly visibleToasts = input<
    ToasterProps['visibleToasts'],
    NumberInput
  >(3, {
    transform: numberAttribute,
  });
  public readonly closeButton = input<
    ToasterProps['closeButton'],
    BooleanInput
  >(false, {
    transform: booleanAttribute,
  });
  public readonly toastOptions = input<ToasterProps['toastOptions']>({});

  protected readonly _computedToastOptions = computed(() => {
    const options = this.toastOptions();
    return {
      ...options,
      classes: {
        ...options?.classes,
        toast: hlm('rounded-xl!', options?.classes?.toast),
      },
    };
  });
  public readonly offset = input<ToasterProps['offset']>(null);
  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  public readonly userStyle = input<Record<string, string>>(
    {
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
    },
    { alias: 'style' },
  );

  protected readonly _computedClass = computed(() =>
    hlm('toaster group', this.userClass()),
  );
}
