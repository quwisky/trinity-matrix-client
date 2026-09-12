---
title: Signals and RxJS
description: Choose Angular signals for current state and RxJS Observables for actions and owned streams.
audience: developer
contentChannel: develop
canonicalTopic: development-signals-rxjs
pageType: how-to
platforms: [web, desktop, android, ios]
---

Signals and Observables have different jobs in Trinity. Choose from the lifetime of the value, not personal preference.

## Use signals for current state {#signals}

Keep writable signals private to their owner and expose `.asReadonly()` or a computed view. Derive values with `computed()`; do not synchronize signals through an effect. Read signals before an asynchronous boundary when their value belongs to the operation being started.

Use `linkedSignal()` only for writable state that intentionally resets or adapts when a source changes. A capability projection normally owns its own explicit reconciliation instead.

## Use Observables for work {#observables}

A one-shot command returns a cold, finite Observable. Construction does not start the action; subscription does. Preserve cancellation, errors, and typed outcomes through the chain.

```ts
save(): void {
  this.settings
    .save(this.formValue())
    .pipe(take(1), takeUntilDestroyed(this.destroyRef))
    .subscribe({ error: () => this.failed.set(true) });
}
```

Do not hide a long-lived subscription inside a one-shot action. Application, account, and conversation streams stay with their runtime owners.

## Bridge deliberately {#bridges}

Use `toSignal()` when a component needs to render an Observable and the initial value and lifetime are explicit. Do not convert every SDK stream at the feature boundary; the data-access capability should first adapt it into a stable public model.

Use an effect only to synchronize with an imperative external system, and register cleanup for resources it creates. For DOM measurement or third-party rendering, prefer the appropriate after-render API.

Read [state and reactivity](../../architecture/state-and-reactivity/) for projection lifetimes and [data-access services](../data-access-services/) for public capability APIs.
