import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { EmptyStateComponent } from './empty-state.component';

/**
 * Host for the cases a bare component cannot express: projection, and the attributes a call
 * site writes on the element. One render per test — TestBed cannot be reconfigured once it is
 * up, so variations go through `setInput` rather than a second `render`.
 */
@Component({
  imports: [EmptyStateComponent],
  template: `
    <trn-empty-state
      title="Nothing here"
      body="a string that must lose"
      class="mt-4"
      data-testid="threads-empty"
      aria-live="polite"
    >
      <span data-testid="projected">projected instead</span>
      <button trnEmptyStateActions data-testid="action">Do the thing</button>
    </trn-empty-state>
  `,
})
class ProjectingHostComponent {}

describe('EmptyStateComponent', () => {
  it('renders a title and a body', async () => {
    const { container } = await render(EmptyStateComponent, {
      inputs: {
        title: 'No threads yet',
        body: 'Reply in a thread to start one.',
      },
    });

    expect(container.textContent).toContain('No threads yet');
    expect(container.textContent).toContain('Reply in a thread to start one.');
  });

  it('leaves out the heading when there is no title', async () => {
    // Several sites are one quiet sentence with nothing over it, and an empty heading element
    // is a visible gap rather than a harmless one.
    const { container } = await render(EmptyStateComponent, {
      inputs: { body: 'No threads in this channel yet.' },
    });

    expect(container.querySelector('.font-semibold')).toBeNull();
    expect(container.textContent).toContain('No threads in this channel yet.');
  });

  it('renders a title with no body', async () => {
    const { container } = await render(EmptyStateComponent, {
      inputs: { title: 'Searching…' },
    });

    expect(container.textContent).toContain('Searching…');
  });

  it('lets projected content replace the body input', async () => {
    // The quick switcher puts a spinner where the sentence goes while a directory lookup is
    // in flight, so a string input alone cannot express every site.
    const { container } = await render(ProjectingHostComponent);

    expect(container.querySelector('[data-testid=projected]')).not.toBeNull();
    expect(container.textContent).not.toContain('a string that must lose');
  });

  it('projects actions into their own slot', async () => {
    const { container } = await render(ProjectingHostComponent);

    const action = container.querySelector('[data-testid=action]');
    expect(action).not.toBeNull();
    expect(action?.closest('.empty-state__actions')).not.toBeNull();
  });

  it("adds its own host class rather than replacing the call site's", async () => {
    // `host: { class: 'block' }` and a `class` written at the call site have to coexist: the
    // adopting sites need their own spacing utilities, and `block` is what stops this dropping
    // its padding in a non-flex parent. An earlier version of this test asserted that
    // `data-testid` survives, which is true of every Angular component and could not fail.
    const { container } = await render(ProjectingHostComponent);

    const host = container.querySelector('[data-testid=threads-empty]');
    expect(host?.classList.contains('block')).toBe(true);
    expect(host?.classList.contains('mt-4')).toBe(true);
  });

  it('renders an icon only when one is named', async () => {
    const { fixture, container } = await render(EmptyStateComponent, {
      inputs: { body: 'nothing' },
    });
    expect(container.querySelector('trn-icon')).toBeNull();

    fixture.componentRef.setInput('icon', 'search');
    fixture.detectChanges();

    expect(container.querySelector('trn-icon')).not.toBeNull();
  });

  it('takes the danger tone without reaching for text-destructive', async () => {
    // `--destructive` is a fill/tint token whose dark value is a near-black maroon; used as a
    // foreground it makes the error unreadable in the theme where it matters most.
    const { fixture, container } = await render(EmptyStateComponent, {
      inputs: { body: "Couldn't load rooms" },
    });
    expect(container.querySelector('.text-muted-foreground')).not.toBeNull();

    fixture.componentRef.setInput('tone', 'danger');
    fixture.detectChanges();

    expect(container.querySelector('.text-danger')?.textContent).toContain(
      "Couldn't load rooms",
    );
    expect(container.querySelector('.text-destructive')).toBeNull();
  });

  it('leaves nothing inside the body paragraph when there is neither a string nor projected content', async () => {
    // The title is guarded by an `@if` and the body is not — it is a slot whose fallback is
    // the interpolation, so the element always exists and `empty:hidden` is what keeps a
    // heading-only panel from carrying a line box under it.
    //
    // Asserted as "no meaningful child nodes" rather than through `:empty`, because jsdom and
    // the browsers disagree about that selector: jsdom implements Selectors 3, where a comment
    // counts as content, while Chromium and WebKit implement Selectors 4, where it does not.
    // Measured in both engines — the rule really does hide this in a browser, and asserting
    // `:empty` here would fail against a component that works.
    //
    // What is left to guard is the precondition: nothing but anchors inside that element.
    // Reformatting the template is NOT the risk — Angular's default `preserveWhitespaces:
    // false` collapses indentation before it reaches the DOM, checked by reflowing this
    // element across lines and watching the tests stay green. The risk is content: a stray
    // `&nbsp;`, a wrapper element, an `@if` that renders a space. That mutation does fail.
    const { container } = await render(EmptyStateComponent, {
      inputs: { title: 'Search this room' },
    });

    const body = container.querySelector('p.text-13');
    expect(body?.className).toContain('empty:hidden');
    const meaningful = [...(body?.childNodes ?? [])].filter(
      (node) => node.nodeType !== Node.COMMENT_NODE && node.textContent !== '',
    );
    expect(meaningful, body?.outerHTML).toEqual([]);
  });

  it('keeps the body paragraph filled when there is a string to put in it', async () => {
    const { container } = await render(EmptyStateComponent, {
      inputs: { body: 'No pinned messages in this room.' },
    });

    const body = container.querySelector('p.text-13');
    expect(body?.textContent?.trim()).toBe('No pinned messages in this room.');
  });

  it("takes a panel's padding by default and a line's when asked", async () => {
    // The fifteen rules this replaces were three sizes: 24px panels, and 8-12px lines inside
    // a list. A single size would have grown the compact ones roughly fourfold in a 280px
    // sidebar column, which is the thing adoption revealed and the component had missed.
    const { fixture } = await render(EmptyStateComponent, {
      inputs: { body: 'nothing' },
    });
    // `render` makes the component the fixture root, so the host is `nativeElement` itself
    // rather than something inside `container`.
    const column = () =>
      (fixture.nativeElement as HTMLElement).querySelector('div');

    expect(column()?.className).toContain('py-6');

    fixture.componentRef.setInput('size', 'line');
    fixture.detectChanges();

    expect(column()?.className).toContain('py-2');
    expect(column()?.className).not.toContain('py-6');
  });

  it('renders the title as an h2 when the call site asks for one', async () => {
    // The hero is the only content on its pane and its heading is deliberate: `trn-page-header`
    // owns the page's single `<h1>`, so this is an `<h2>` and must not silently become a `<p>`
    // on the way into this component.
    const { fixture, container } = await render(EmptyStateComponent, {
      inputs: { title: 'Trinity', size: 'hero' as const },
    });
    expect(container.querySelector('h2')).toBeNull();

    fixture.componentRef.setInput('titleAs', 'h2');
    fixture.detectChanges();

    expect(container.querySelector('h2')?.textContent).toContain('Trinity');
    expect(container.querySelector('p.text-\\[22px\\]')).toBeNull();
  });

  it('draws a badge glyph, hidden from the screen reader', async () => {
    // Decoration for a title that says the same thing in words — the `#` disc over "Trinity"
    // is not information a screen reader needs read out.
    const { container } = await render(EmptyStateComponent, {
      inputs: { badge: '#', title: 'Trinity' },
    });

    const badge = container.querySelector('[aria-hidden=true]');
    expect(badge?.textContent?.trim()).toBe('#');
  });

  it('is a block, so its padding survives a non-flex parent', async () => {
    // Asserted as a class rather than through getComputedStyle: Tailwind does not compute in
    // jsdom, and a wrapper with no host display drops its padding only where the parent is
    // not itself flex or grid — which is what makes that bug look random.
    const { fixture } = await render(EmptyStateComponent, {
      inputs: { body: 'nothing' },
    });

    expect(
      (fixture.nativeElement as HTMLElement).classList.contains('block'),
    ).toBe(true);
  });
});
