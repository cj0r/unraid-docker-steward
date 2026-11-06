# Changelog

Every release of Docker Steward, newest first. Versions follow Unraid's plugin convention: the release date (`YYYY.MM.DD`), with a letter (`2026.11.07a`, `b`, ...) for a further release on the same day.

## 2026.11.07a

- First release.
- Per-container Check, Update and Re-check, a row menu (Check, Check and update now, Force update) and bulk Check selected, Update selected, Check all and Check & update.
- Containers grouped by Needs update, Not checked yet, Up to date and Cannot be updated here; search and sort.
- Update runs continue in the background, with a live progress popup.
- Compatibility check that reports a clear notice when an Unraid version is not supported, and the tested versions listed on the page.
- `docker-steward-check` and `docker-steward-selftest` commands.
