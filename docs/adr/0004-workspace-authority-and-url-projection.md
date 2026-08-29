---
status: accepted
---

# Make Workspace authoritative and project it into the URL

Workspace owns semantic presentation state; the URL is its canonical projection and an inbound restoration source, not a second state store. Deep links override persisted selection, user navigation pushes history, repair replaces history, and responsive placement creates no history, which keeps browser, native-back, dialog, and compact-layout behaviour coherent.
