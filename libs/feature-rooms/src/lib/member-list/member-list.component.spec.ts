import { TestBed } from '@angular/core/testing';
import { MemberListComponent } from './member-list.component';
import { beforeEach, describe, expect, it } from 'vitest';

describe('MemberListComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MemberListComponent] }),
  );

  it('renders a row per member with the count in the header', () => {
    const fixture = TestBed.createComponent(MemberListComponent);
    fixture.componentRef.setInput('members', [
      { userId: '@a:hs', name: 'Alice', initial: 'A', avatarUrl: null },
      { userId: '@b:hs', name: 'Bob', initial: 'B', avatarUrl: null },
    ]);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.member');
    expect(rows.length).toBe(2);
    expect(
      fixture.nativeElement.querySelector('.category').textContent,
    ).toContain('2');
    expect(rows[0].textContent).toContain('Alice');
  });

  it('emits closed when the header close button is clicked', () => {
    const fixture = TestBed.createComponent(MemberListComponent);
    fixture.detectChanges();

    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    fixture.nativeElement
      .querySelector('[data-testid="close-members"]')
      .click();

    expect(closed).toBe(true);
  });
});
