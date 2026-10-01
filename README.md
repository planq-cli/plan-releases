# PlanQ Releases

PlanQ is a Git-native planning DSL, validator, formatter, and read-only Gantt
tool. This repository contains immutable release artifacts and metadata, not
the product source code.

## Install

The shared npm command supports macOS arm64, Linux glibc x86_64, and Windows
x86_64 starting with the first cross-platform npm release:

```bash
npm install --global @planq-cli/planq
planq version
```

The current npm `latest`, `0.1.3`, remains Linux-only. Cross-platform npm is
pending public release and three-platform registry acceptance; check the
installation page before using npm on macOS or Windows.

The installed PlanQ binary is native and does not require GraalVM, a JDK, or
Clojure. Homebrew on macOS and winget on Windows remain optional native
channels that do not require Node.js:

| Platform | Optional native command |
| --- | --- |
| macOS Apple Silicon | `brew install planq-cli/tap/planq` |
| Windows x86_64 | `winget install --id PlanQ.PlanQ --exact` |

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

PlanQ is licensed under `PolyForm-Noncommercial-1.0.0`. Current release: `0.1.4`.
