# PlanQ Releases

PlanQ is a Git-native planning DSL, validator, formatter, and read-only Gantt
tool. This repository contains immutable release artifacts and metadata, not
the product source code.

## Install

| Platform | Command |
| --- | --- |
| macOS Apple Silicon | `brew install planq-cli/tap/planq` |
| Windows x86_64 | `winget install --id PlanQ.PlanQ --exact` |
| Linux glibc x86_64 | `npm install --global @planq-cli/planq` |

- [Documentation](https://planq.dev/docs/)
- [Installation and supported platforms](https://planq.dev/docs/install)
- [Five-minute Quickstart](https://planq.dev/docs/quickstart)

## Verify a release

Each release includes `SHA256SUMS` and `planq-release-v1.json`. After
downloading an archive and `SHA256SUMS`, verify it on macOS or Linux:

```bash
shasum -a 256 -c SHA256SUMS
```

On Windows, use `Get-FileHash <archive> -Algorithm SHA256` and compare the
result with both metadata files.

PlanQ is licensed under `PolyForm-Noncommercial-1.0.0`. Current release: `0.1.2`.
