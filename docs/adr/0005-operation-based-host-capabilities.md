---
status: accepted
---

# Select operation-based host capabilities at composition

Product code asks for narrow operations such as secure storage, deep links, host back, file export, notification presentation, badges, lifecycle, and updates instead of detecting Web, Capacitor, or Electron. Composition roots select supported adapters, and Electron negotiates a versioned capability set, reducing platform branching while making unavailable operations and IPC security explicit.
