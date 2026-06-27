# AGENTS.md

## Development Story Implementation

When implementing a development story, always use TDD red-green:

1. Write or update the tests first so they describe the intended behavior.
2. Run the focused tests and confirm they fail for the expected reason.
3. Implement the smallest code change needed to make those tests pass.
4. Re-run the focused tests and relevant broader checks until they pass.

Do not implement story behavior before creating the tests that prove it.
