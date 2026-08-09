import { type Type } from '@angular/core';
// The public option type comes from the NON-zoneless entry: its `inputs` / `on` are
// typed against the component, so call sites keep input/output type-checking. The
// `/zoneless` `RenderComponentOptions` is parameterised by the DOM query set (not the
// component) and declares no `inputs`/`on`, so it cannot type the public signature.
import { type RenderComponentOptions } from '@testing-library/angular';
import {
  render as zonelessRender,
  type RenderComponentOptions as ZonelessRenderComponentOptions,
  type RenderResult,
} from '@testing-library/angular/zoneless';

export * from '@testing-library/angular/zoneless';
// From the non-zoneless entry for the same reason as `RenderComponentOptions` above:
// specs typing an `inputs` bag need the component-parameterised version.
export type { ComponentInput } from '@testing-library/angular';

/**
 * Zoneless-aware `render` for our specs.
 *
 * ATL's `/zoneless` render() honors only Angular's native `bindings` API and
 * silently ignores the `inputs` / `on` options our specs pass — so a required
 * signal input is never set and the component throws NG0950 during its initial
 * change detection. We can't fix that with `bindings`/`inputBinding` because many
 * specs then update an input via `componentRef.setInput`, which Angular forbids
 * on a component that uses input bindings (NG0317).
 *
 * So: render with `skipDetectChanges`, apply `inputs` via `setInput` and wire
 * `on` handlers to the output emitters BEFORE the first change detection, then
 * detect. Required inputs are set before any CD (no NG0950), and setInput stays
 * available for later per-spec updates (no NG0317).
 */
export async function render<ComponentType>(
  component: Type<ComponentType>,
  options: RenderComponentOptions<ComponentType> = {},
): Promise<RenderResult<ComponentType>> {
  const { inputs, on, ...rest } = options;
  // `rest` is the render configuration shared by both entries (providers, imports,
  // declarations, …); the two libraries model it as distinct option types, so bridge
  // it explicitly before handing it to the zoneless render().
  const result = await zonelessRender(component, {
    ...(rest as ZonelessRenderComponentOptions),
    skipDetectChanges: true,
  });
  for (const [name, value] of Object.entries(inputs ?? {})) {
    result.fixture.componentRef.setInput(name, value);
  }
  const instance = result.fixture.componentInstance as Record<string, unknown>;
  for (const [name, handler] of Object.entries(on ?? {})) {
    (instance[name] as { subscribe?: (fn: unknown) => void })?.subscribe?.(
      handler,
    );
  }
  result.fixture.detectChanges();
  return result;
}
