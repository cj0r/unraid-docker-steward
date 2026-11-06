# Security

Docker Steward runs inside the Unraid web interface as root, so it is built to touch as little as possible.

- No Unraid file is modified. All requests go through the webGUI login and its CSRF check.
- Container names are validated (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`), matched against Docker's own list, and passed to
  shell commands only through `escapeshellarg`.
- Only one update run can be started at a time (checked and started under a lock).
- State is kept in `/tmp/docker.steward` (mode 0700), never on the flash drive.
- The package is verified by SHA-256 and MD5 when installed.

## Reporting a problem

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) on this repository
rather than in a public issue. Include the Unraid version and the steps to reproduce.
