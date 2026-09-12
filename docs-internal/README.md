# Internal documentation

This directory contains repository records and maintainer procedures that are intentionally excluded from the public Starlight sites.

## Contents

- `decisions/` preserves accepted architecture decision records.
- `architecture/dependency-map.md` is generated from the current Nx graph.
- `maintenance/ci-and-releases.md` covers private CI and release operations.
- `maintenance/push-notifications.md` covers push infrastructure and operator setup.
- `maintenance/validation-warnings.md` records investigated tool warnings.

Public release documentation lives under `apps/docs-users/src/content/docs/`. Public develop-branch documentation lives under `apps/docs-developers/src/content/docs/`.

Do not add this directory to either public site's content loader, navigation, search index, or build inputs.
