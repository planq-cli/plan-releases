#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const nativePackage = "@planq-cli/linux-x64";
const supportUrl = "https://planq.dev/docs/install";
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

export const diagnostics = {
  missing:
    `PLANQ_NPM_NATIVE_PACKAGE_MISSING: ${nativePackage} is not installed. ` +
    "Reinstall @planq-cli/planq without --no-optional.",
  musl:
    `PLANQ_NPM_UNSUPPORTED_LIBC: PlanQ npm packages support Linux glibc x86_64 only. ${supportUrl}`,
  unsupported:
    `PLANQ_NPM_UNSUPPORTED_PLATFORM: This npm package supports Linux glibc x86_64 only. ${supportUrl}`,
};

export function glibcVersion(report = process.report) {
  try {
    return report?.getReport?.().header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

export function platformDiagnostic({ platform, arch, glibc }) {
  if (platform !== "linux" || arch !== "x64") {
    if (platform === "darwin") {
      return `${diagnostics.unsupported} Use: brew install planq-cli/tap/planq`;
    }
    if (platform === "win32") {
      return `${diagnostics.unsupported} Use: winget install --id PlanQ.PlanQ --exact`;
    }
    return diagnostics.unsupported;
  }
  if (!glibc) return diagnostics.musl;
  return null;
}

export function run(runtime) {
  const unsupported = platformDiagnostic(runtime);
  if (unsupported) {
    runtime.stderr.write(`${unsupported}\n`);
    runtime.exit(1);
    return null;
  }

  let packageJson;
  try {
    packageJson = runtime.resolve(`${nativePackage}/package.json`);
  } catch {
    runtime.stderr.write(`${diagnostics.missing}\n`);
    runtime.exit(1);
    return null;
  }

  const binary = path.join(path.dirname(packageJson), "bin", "planq");
  if (!runtime.fileExists(binary)) {
    runtime.stderr.write(
      `PLANQ_NPM_NATIVE_BINARY_MISSING: ${nativePackage} is incomplete. Reinstall the package.\n`,
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
