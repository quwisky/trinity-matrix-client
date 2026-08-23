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

  it('passes an attribute written on the element straight through', async () => {
    // `data-testid` and `aria-live` are how the call sites are found and announced. Neither
    // needs an input of its own, and both would be lost if the host rewrote its attributes.
    const { container } = await render(ProjectingHostComponent);

    const host = container.querySelector('[data-testid=threads-empty]');
    expect(host?.tagName.toLowerCase()).toBe('trn-empty-state');
    expect(host?.getAttribute('aria-live')).toBe('polite');
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
