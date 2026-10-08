import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, required } from '@angular/forms/signals';
import { describe, expect, it } from 'vitest';
import { shownError } from './shown-error';

function nameForm() {
  return TestBed.runInInjectionContext(() =>
    form(signal({ name: '' }), (path) =>
      required(path.name, { message: 'Enter a name.' }),
    ),
  );
}

describe('shownError', () => {
  it('stays quiet until the field has been touched', () => {
    const f = nameForm();

    expect(f.name().errors()).toHaveLength(1);
    expect(shownError(f.name)).toBeUndefined();
  });

  it('shows the first error of a touched invalid field', () => {
    const f = nameForm();

    f.name().markAsTouched();

    expect(shownError(f.name)?.message).toBe('Enter a name.');
  });

  it('shows nothing once a touched field is valid', () => {
    const f = nameForm();
    f.name().markAsTouched();

    f.name().value.set('Ada');

    expect(shownError(f.name)).toBeUndefined();
  });
});
