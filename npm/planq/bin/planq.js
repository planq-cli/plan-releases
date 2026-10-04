#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const supportUrl = "https://planq.dev/docs/install";
const packageTargets = {
  "darwin-arm64": {
    packageName: "@planq-cli/darwin-arm64",
    binary: "planq",
    solver: "planq-solver",
  },
  "linux-x64-glibc": {
    packageName: "@planq-cli/linux-x64",
    binary: "planq",
    solver: "planq-solver",
  },
  "win32-x64": {
    packageName: "@planq-cli/win32-x64",
    binary: "planq.exe",
    solver: "planq-solver.exe",
  },
};

export const diagnostics = {
  musl:
    `PLANQ_NPM_UNSUPPORTED_LIBC: PlanQ npm packages support Linux glibc x86_64, not musl. ${supportUrl}`,
  unsupported:
    `PLANQ_NPM_UNSUPPORTED_PLATFORM: PlanQ npm supports macOS arm64, Linux glibc x86_64, and Windows x86_64. ${supportUrl}`,
};

export function glibcVersion(report = process.report) {
  try {
    return report?.getReport?.().header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

export function platformTarget({ platform, arch, glibc }) {
  if (platform === "darwin" && arch === "arm64") {
    return packageTargets["darwin-arm64"];
  }
  if (platform === "linux" && arch === "x64") {
    return glibc ? packageTargets["linux-x64-glibc"] : null;
  }
  if (platform === "win32" && arch === "x64") {
    return packageTargets["win32-x64"];
  }
  return null;
}

export function platformDiagnostic(runtime) {
  if (
    runtime.platform === "linux" &&
    runtime.arch === "x64" &&
    !runtime.glibc
  ) {
    return diagnostics.musl;
  }
  return platformTarget(runtime) ? null : diagnostics.unsupported;
}

export function missingDiagnostic(packageName) {
  return (
    `PLANQ_NPM_NATIVE_PACKAGE_MISSING: ${packageName} is not installed. ` +
    "Reinstall @planq-cli/planq without --no-optional."
  );
}

export function run(runtime) {
  const unsupported = platformDiagnostic(runtime);
  if (unsupported) {
    runtime.stderr.write(`${unsupported}\n`);
    runtime.exit(1);
    return null;
  }
  const target = platformTarget(runtime);

  let packageJson;
  try {
    packageJson = runtime.resolve(`${target.packageName}/package.json`);
  } catch {
    runtime.stderr.write(`${missingDiagnostic(target.packageName)}\n`);
    runtime.exit(1);
    return null;
  }

  const binary = path.join(path.dirname(packageJson), "bin", target.binary);
  const solver = path.join(path.dirname(packageJson), "bin", target.solver);
  const solverChecksum = path.join(
    path.dirname(packageJson),
    "bin",
    "planq-solver.sha256",
  );
  if (
    !runtime.fileExists(binary) ||
    !runtime.fileExists(solver) ||
    !runtime.fileExists(solverChecksum)
  ) {
    runtime.stderr.write(
      `PLANQ_NPM_NATIVE_BINARY_MISSING: ${target.packageName} is incomplete. Reinstall the package.\n`,
    );
    runtime.exit(1);
    return null;
  }

  const child = runtime.spawn(binary, runtime.argv, {
    stdio: "inherit",
    windowsHide: true,
  });
  let settled = false;
  const handlers = new Map();
  const cleanup = () => {
    for (const [signal, handler] of handlers) runtime.off(signal, handler);
  };
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };

  const forwardedSignals =
    runtime.platform === "win32"
      ? ["SIGINT", "SIGTERM"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    handlers.set(signal, handler);
    runtime.on(signal, handler);
  }

  child.once("error", (error) => {
    finish(() => {
      runtime.stderr.write(`PLANQ_NPM_SPAWN_FAILED: ${error.message}\n`);
      runtime.exit(1);
    });
  });
  child.once("exit", (code, signal) => {
    finish(() => {
      if (signal) {
        try {
          runtime.kill(runtime.pid, signal);
        } catch {
          runtime.exit(1);
        }
      } else {
        runtime.exit(code ?? 1);
      }
    });
  });
  return child;
}

export function runCli() {
  const require = createRequire(import.meta.url);
  return run({
    platform: process.platform,
    arch: process.arch,
    glibc: glibcVersion(),
    argv: process.argv.slice(2),
    stderr: process.stderr,
    pid: process.pid,
    resolve: require.resolve,
    fileExists: existsSync,
    spawn,
    on: process.on.bind(process),
    off: process.off.bind(process),
    kill: process.kill.bind(process),
    exit: process.exit.bind(process),
  });
}

export function isMain(moduleUrl, executable) {
  if (!executable) return false;
  try {
    return (
      realpathSync(executable) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
}

if (isMain(import.meta.url, process.argv[1])) {
  runCli();
}
