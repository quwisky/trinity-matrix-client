import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmTabsContent } from '@trinity/helm/tabs';

/**
 * One panel in a {@link TrnTabsComponent}; `value` matches the tab that reveals it.
 *
 * The kit directive sits on an inner element rather than on this host, which is what lets the
 * public input be called `value` instead of the kit's own `hlmTabsContent` — see the note on
 * {@link TrnTabsComponent} for why a re-published name cannot be renamed. The host is
 * `display: contents` so the inner element lays out as if it were the panel itself.
 *
 * Panels are **eager**: every one is in the DOM from the start and the inactive ones carry
 * `hidden`. The kit also ships a lazy variant (`hlmTabsContentLazy`, an `ng-template` that
 * instantiates on first activation) and it is deliberately not wrapped — a settings dialog is
 * one `<form [formRoot]>` spanning every panel, and fields that do not exist until their tab
 * is visited cannot be validated or submitted with the rest. Wrap it the day a tab holds
 * something genuinely expensive and stands alone.
 */
@Component({
  selector: 'trn-tab-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTabsContent],
  styles: [
    `
      @layer components {
        :host {
          display: contents;
        }
      }
    `,
  ],
  template: `
    <div [hlmTabsContent]="value()" [class]="panelClass()">
      <ng-content />
    </div>
  `,
})
export class TrnTabPanelComponent {
  readonly value = input.required<string>();

  /**
   * Classes for the panel element itself.
   *
   * Usually a display utility, which raises the obvious worry: the kit hides an inactive
   * panel with the `hidden` ATTRIBUTE, and a bare UA `[hidden] { display: none }` carries the
   * same specificity as one class, so `flex` would win on source order and both panels would
   * paint at once. It does not happen here, and the reason is worth recording so nobody
   * "fixes" it twice: Tailwind v4's preflight ships
   * `[hidden]:where(:not([hidden='until-found'])) { display: none !important }`, which
   * settles it globally. A duplicate `!important` rule was written here first and then
   * removed — with it deleted, the Chromium assertion in `room-settings.spec.mts` still
   * passes, which is what proves the preflight rule is the one doing the work.
   *
   * Not `class` on the host: the host is `display: contents` and boxes nothing, so a layout
   * class there would do nothing at all. Same shape as `trn-select`'s `triggerClass`.
   */
  readonly panelClass = input<string>('');
}
