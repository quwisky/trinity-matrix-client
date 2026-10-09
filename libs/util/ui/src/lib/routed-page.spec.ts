import { describe, expect, it } from 'vitest';
import { ROUTED_PAGE_CLASS, markRoutedPage } from './routed-page';

describe('markRoutedPage', () => {
  it('classes the element a router outlet rendered after itself', () => {
    document.body.innerHTML =
      '<router-outlet></router-outlet><page-x></page-x>';
    const outlet = document.querySelector('router-outlet') as HTMLElement;

    markRoutedPage(outlet);

    expect(document.querySelector('page-x')?.classList).toContain(
      ROUTED_PAGE_CLASS,
    );
  });

  it('ignores an outlet that rendered nothing', () => {
    document.body.innerHTML = '<router-outlet></router-outlet>';

    expect(() =>
      markRoutedPage(document.querySelector('router-outlet') as HTMLElement),
    ).not.toThrow();
  });
});
