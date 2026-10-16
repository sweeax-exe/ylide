## What changes

<!-- One topic per pull request. Link the issue if there is one. -->

## How you verified it

<!-- Tests you added or ran; screenshots for UI changes. -->

## Checklist

- [ ] `cargo test --workspace` and `npm test -w apps/desktop` pass
- [ ] `cargo clippy --workspace --all-targets` shows no warnings
- [ ] New UI strings exist in every language under `apps/desktop/src/i18n/locales/` (English text is fine where you cannot translate; say so above)
- [ ] No new network access, or it has a switch and a network log entry (see CONTRIBUTING.md)
- [ ] New dependencies have a license from the list in CONTRIBUTING.md
