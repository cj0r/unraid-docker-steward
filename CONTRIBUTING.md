# Contributing

Bug reports, ideas and pull requests are welcome.

## Reporting a bug

Open an issue with the bug form. Include the Docker Steward and Unraid versions and the output of
`docker-steward-selftest`. Security problems go through [SECURITY.md](SECURITY.md), not an issue.

## Working on the code

Plain PHP, JavaScript and CSS with no build step and no dependencies; keep it that way.

```bash
./scripts/check.sh              # PHP and JS syntax, plg checks, package checksums
./dev-deploy.sh                 # on an Unraid server: RAM-only test copy (undo with --remove)
./tests/smoke.sh <host>         # runs the on-server self-test over ssh
```

## Pull requests

- One change per pull request.
- Test it on a real Unraid server and say which version.
- Add a line to `CHANGELOG.md`.

By contributing you agree your work is released under the project's MIT license.
