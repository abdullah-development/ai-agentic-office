# Shared memory lives here

Two kinds of markdown file, both written by the agents themselves at runtime and
both ignored by git (they are notes about *your* projects, not part of the app):

- `floor.md` — shared across every office
- `<officeId>.md` — one per office, shared by that office's agents; it doubles as
  the office's task board (`[TASK]` / `[DONE]` / `[SUMMARY]`)

The server creates whichever files it needs on first spawn, so there is nothing
to set up. Edit them from the UI with the ✎ on the memory card.
