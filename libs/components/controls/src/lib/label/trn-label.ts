import { Directive } from '@angular/core';
import { HlmLabel } from '@trinity/helm/label';

/**
 * Trinity's form label.
 *
 * An attribute directive, not an element, because the host carries the semantics: 15 of the
 * 16 call sites are a native `<label for="…">` paired with an input's `id`, and one is a
 * `<span>` used as a group caption. A `<trn-label>` element would break the `for`/`id`
 * association on the first and have no meaning on the second.
 *
 * **Composed, not reimplemented.** The kit directive is applied through `hostDirectives`, so
 * there is no second copy of its class list to drift from a `@spartan-ng/cli` re-sync. What
 * this library owns is the API: the `trnLabel` selector and the two inputs below. Swapping
 * the library underneath is a change to this file's `hostDirectives` entry, and to nothing
 * else in the workspace.
 *
 * **`id` and `for` are deliberately not forwarded**, and the attempt to forward them is worth
 * recording. The kit publishes them by composing brain's own label directive, but
 * `hostDirectives` input forwarding does not chain: listing `inputs: ['id', 'for']` on an
 * entry whose target only *inherits* those inputs fails at runtime with
 * `NG0311: Directive HlmLabel does not have an input with a public name of id`.
 *
 * Which turned out not to matter. All 16 call sites write `for="…"` as the plain HTML
 * attribute the browser already understands — none binds `[for]` or `[id]` — so the input
 * was surface nobody used, and the label/control association works because it is native, not
 * because a directive re-published it.
 */
@Directive({
  selector: '[trnLabel]',
  hostDirectives: [{ directive: HlmLabel, inputs: [], outputs: [] }],
})
export class TrnLabel {}
