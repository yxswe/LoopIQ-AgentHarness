# Architecture Documentation

- The canonical architecture reference lives at `docs/architect.md`.
- ALWAYS read `docs/architect.md` before making non-trivial code changes to
  understand the system structure.
- After ANY code change, ALWAYS check whether `docs/architect.md` needs updating
  (e.g. new/removed subsystems, changed public APIs, altered data flow or
  inter-package dependencies). If so, update it in the same change. Keep it in
  sync with the code.
- Subsystem design documents linked from `docs/architect.md` are code-coupled
  documentation, not optional background reading. Before changing a documented
  subsystem, read its linked design document. If the change affects behavior,
  data formats, invariants, compatibility, ownership, APIs, or known
  limitations, update that document in the same change with more detail than the
  architecture overview.
- `docs/architect.md` should remain the high-level map and link to the relevant
  detailed subsystem document instead of duplicating its full specification.

# Language Rules

- All conversational responses to the user MUST be written in Chinese.
- All code (including identifiers, variables, and function names) MUST be written in English.
- All code comments MUST be written in English.
- All documentation MUST be written in English.
- All pull request titles and descriptions MUST be written in English.
- All commit messages MUST be written in English.
