---
paths:
  - "**/*"
---

# Code Quality (all source code)

## Single Responsibility

- Split a file when it has more than one clear responsibility — not just because it crossed a line count.
- Line counts are a smell, not a verdict. Cohesive long files are fine; tangled short ones aren't.

## Lines of Code (soft targets / refactor thresholds)

| File type                                 | Aim     | Refactor at |
|-------------------------------------------|---------|-------------|
| Angular `.ts` component                   | 150–250 | 300–400     |
| Angular `.html` template                  | 100–200 | 250–300     |
| Services / signal stores / NgRx / Zustand | 200–400 | 500+        |

## How to Split

- **Large Angular templates** are usually the bigger smell. Extract child components, repeated row/detail blocks, dialogs, or status panels.
- **Large `.ts` files**: move workflow logic into services, computed view models, helper functions, or signal stores.
- **Large services**: split along workflow seams (e.g. `expense-actions` vs `expense-api`), not arbitrary line counts.
