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
    <div [hlmTabsContent]="value()" class="flex flex-col gap-3 pt-3">
      <ng-content />
    </div>
  `,
})
export class TrnTabPanelComponent {
  readonly value = input.required<string>();
}
