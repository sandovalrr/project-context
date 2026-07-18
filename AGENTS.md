# Repository Guidelines

## TypeScript style

- Do not use `let`. Keep bindings immutable with `const`. When a value would
  otherwise need reassignment, split the branches or mutable state transition
  into small functions that return the value needed by the caller. Do not hide
  reassignment by mutating an object or array instead.
- Optimize declaration layout for readability. Group related declarations by
  purpose, keep tightly coupled declarations close to their use, and separate
  distinct declaration groups with a blank line.
- Apply these rules to all new and modified code. When touching existing code,
  bring the affected section into compliance where doing so remains within the
  scope of the change.
