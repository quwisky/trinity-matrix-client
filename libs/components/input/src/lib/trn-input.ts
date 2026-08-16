import { Directive } from '@angular/core';
import { HlmInput } from '@trinity/helm/input';

/**
 * Trinity's form input.
 *
 * An attribute directive, because the host is the control. It is applied to `<input>` at 27
 * call sites, but also to two `<textarea>`s and three native `<select>`s — an element
 * wrapper could not express any of that, and would take the native value, focus and form
 * behaviour with it.
 *
 * **`aria-describedby` survives without being re-published here, and that is worth knowing.**
 * #153 was the bug where `BrnFieldControlDescribedBy` owns `[attr.aria-describedby]` and
 * computes it as `null` unless the composing entry lists the input — silently deleting a
 * consumer's value on three shipped screens. The kit's entry lists it, and that publication
 * reaches THIS element too: `hostDirectives` publication chains down to whatever element the
 * directive ends up on, even though *re-declaring* the same input in this wrapper's own
 * entry does not (that throws NG0311, as the label wrapper found).
 *
 * So there is deliberately no `aria-describedby` input here. One was written, and removing it
 * changed nothing — verified against the kit, this wrapper and a bare `<input>`, all three of
 * which keep the attribute. The spec keeps asserting it, because the day that stops being
 * true is the day three screens lose their descriptions again without a word.
 */
@Directive({
  selector: '[trnInput]',
  hostDirectives: [{ directive: HlmInput, inputs: [], outputs: [] }],
})
export class TrnInput {}
