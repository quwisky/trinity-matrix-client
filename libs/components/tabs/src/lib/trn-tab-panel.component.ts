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
    ':host { display: contents; }',
    // The panel is the caller's to lay out, and `panelClass` is usually a display utility.
    // That collides with how the kit hides an inactive panel: `hidden` is an ATTRIBUTE, and
    // the UA rule behind it — `[hidden] { display: none }` — has the same specificity as a
    // single class, so `flex` or `grid` wins on source order and the inactive panel stays on
    // screen with the active one. `!important` is the honest fix; the alternative is a
    // call-site convention nobody can enforce.
    //
    // Pinned in `e2e/playwright/room-settings.spec.mts`, not in the unit suite: jsdom does
    // not cascade a class rule against the UA `[hidden]` rule, so the assertion held there
    // with the guard REMOVED. It takes a real browser to tell the two apart.
    '[hidden] { display: none !important; }',
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
   * Not `class` on the host: the host is `display: contents` and boxes nothing, so a layout
   * class there would do nothing at all. Same shape as `trn-select`'s `triggerClass`.
   */
  readonly panelClass = input<string>('');
}
