#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const registry = "https://registry.npmjs.org";
const manifestName = "npm-publication-v1.json";
const packageContracts = [
  { name: "@planq-cli/linux-x64", kind: "native" },
  { name: "@planq-cli/planq", kind: "wrapper" },
];
const npmCredentialNames = [
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "PLANQ_NPM_TOKEN",
  "npm_config__auth",
  "npm_config_auth",
  "npm_config_authToken",
];

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has an invalid field set`, { actual, expected });
  }
}

function parseVersion(value) {
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function cleanEnvironment(environment = process.env, overrides = {}) {
  const result = { ...environment, ...overrides };
  for (const name of npmCredentialNames) delete result[name];
  for (const name of Object.keys(result)) {
    if (/^(?:npm_config|NPM_CONFIG)_(?:_?auth|authToken)$/i.test(name)) {
      delete result[name];
    }
  }
  return result;
}

function sanitize(value, root, environment = {}) {
  let output = String(value ?? "");
  for (const name of npmCredentialNames) {
    const secret = environment[name];
    if (typeof secret === "string" && secret) {
      output = output.replaceAll(secret, "[redacted]");
    }
  }
  if (root) output = output.replaceAll(root, "[isolated]");
  return output
    .replace(/npm_[A-Za-z0-9]{20,}/g, "npm_[redacted]")
    .replace(/(_authToken=)[^\s]+/gi, "$1[redacted]")
    .trim()
    .slice(-4000);
}

function run(commandRunner, command, args, options, label) {
  const result = commandRunner(command, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${label} failed`, {
      command: [command, ...args].map((value) =>
        path.isAbsolute(value) ? path.basename(value) : value
      ),
      status: result.status,
      stdout: sanitize(result.stdout, options.root, options.sourceEnvironment),
      stderr: sanitize(result.stderr, options.root, options.sourceEnvironment),
    });
  }
  return String(result.stdout ?? "");
}

async function isolatedNpmEnvironment(root, environment = process.env) {
  const home = path.join(root, "home");
  const cache = path.join(root, "npm-cache");
  const prefix = path.join(root, "prefix");
  const userconfig = path.join(root, "npmrc");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(cache, { recursive: true, mode: 0o700 }),
    mkdir(prefix, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    userconfig,
    `registry=${registry}/\nalways-auth=false\n`,
    { mode: 0o600 },
  );
  return cleanEnvironment(environment, {
    HOME: home,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_USERCONFIG: userconfig,
    PLAN_SITE: "",
    PATH: `${path.join(prefix, "bin")}${path.delimiter}${environment.PATH ?? ""}`,
  });
}

export function assertToolchain({
  commandRunner = spawnSync,
  nodeVersion = process.versions.node,
  environment = process.env,
} = {}) {
  if (!versionAtLeast(nodeVersion, "22.14.0")) {
    fail("Node.js >=22.14.0 is required", { actual: nodeVersion });
  }
  const result = commandRunner("npm", ["--version"], {
    encoding: "utf8",
    env: cleanEnvironment(environment),
    windowsHide: true,
  });
  const npmVersion = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !versionAtLeast(npmVersion, "11.5.1")) {
    fail("npm >=11.5.1 is required", {
      actual: npmVersion,
      status: result.status,
    });
  }
  return { nodeVersion, npmVersion };
}

export async function loadPublication(directory) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, manifestName);
  const stats = await lstat(manifestPath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    fail("publication manifest must be a regular file");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  exactKeys(
    manifest,
    ["schemaVersion", "productVersion", "release", "packages"],
    "publication manifest",
  );
  exactKeys(
    manifest.release,
    [
      "tag",
      "sourceCommit",
      "sourceSnapshotSha256",
      "manifestSha256",
      "skillDigest",
      "target",
    ],
    "publication release identity",
  );
  if (
    manifest.schemaVersion !== "1" ||
    !parseVersion(manifest.productVersion) ||
    manifest.release.tag !== `v${manifest.productVersion}` ||
    !/^[0-9a-f]{40}$/.test(manifest.release.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(manifest.release.sourceSnapshotSha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.release.manifestSha256) ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.release.skillDigest) ||
    manifest.release.target !== "linux-x86_64" ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== packageContracts.length
  ) {
    fail("publication manifest identity is invalid");
  }

  const packages = [];
  for (let index = 0; index < packageContracts.length; index += 1) {
    const contract = packageContracts[index];
    const item = manifest.packages[index];
    exactKeys(item, ["name", "version", "file", "sha256"], "publication package");
    if (
      item.name !== contract.name ||
      item.version !== manifest.productVersion ||
      !/^[A-Za-z0-9._-]+\.tgz$/.test(item.file) ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      fail("publication package identity is invalid", {
        package: contract.name,
      });
    }
    const file = path.join(root, "artifacts", item.file);
    const fileStats = await lstat(file).catch(() => null);
    if (
      !fileStats?.isFile() ||
      fileStats.isSymbolicLink() ||
      sha256(await readFile(file)) !== item.sha256
    ) {
      fail("publication tarball digest mismatch", {
        package: contract.name,
      });
    }
    packages.push({ ...contract, ...item, path: file });
  }
  return {
    root,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    manifest,
    packages,
  };
}

function hasProvenance(definition) {
  const provenance = definition?.dist?.attestations?.provenance;
  return (
    typeof definition?.dist?.attestations?.url === "string" &&
    typeof provenance?.predicateType === "string" &&
    provenance.predicateType.length > 0
  );
}

async function fetchPackageMetadata(name, fetchImpl) {
  const response = await fetchImpl(
    `${registry}/${name.replace("/", "%2f")}`,
    { headers: { Accept: "application/json" } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    fail("npm registry metadata request failed", {
      package: name,
      status: response.status,
    });
  }
  return response.json();
}

async function inspectRegistryPackage(item, version, fetchImpl) {
  const metadata = await fetchPackageMetadata(item.name, fetchImpl);
  const definition = metadata?.versions?.[version];
  if (!definition) {
    return {
      name: item.name,
      status: "absent",
      latest: metadata?.["dist-tags"]?.latest ?? null,
    };
  }
  const tarballUrl = definition.dist?.tarball;
  if (typeof tarballUrl !== "string") {
    return { name: item.name, status: "conflict", reason: "missing-tarball" };
  }
  const response = await fetchImpl(tarballUrl, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    fail("npm registry tarball request failed", {
      package: item.name,
      status: response.status,
    });
  }
  const digest = sha256(Buffer.from(await response.arrayBuffer()));
  return {
    name: item.name,
    status: digest === item.sha256 ? "matching" : "conflict",
    reason: digest === item.sha256 ? null : "tarball-digest",
    latest: metadata["dist-tags"]?.latest ?? null,
    definition,
    provenance: hasProvenance(definition),
    sha256: digest,
  };
}

export async function classifyRegistryState({
  directory,
  fetchImpl = fetch,
}) {
  const publication = await loadPublication(directory);
  const inspected = [];
  for (const item of publication.packages) {
    inspected.push(
      await inspectRegistryPackage(
        item,
        publication.manifest.productVersion,
        fetchImpl,
      ),
    );
  }
  const [native, wrapper] = inspected;
  let state;
  if (native.status === "absent" && wrapper.status === "absent") {
    state = "new";
  } else if (
    native.status === "matching" &&
    native.provenance &&
    wrapper.status === "absent"
  ) {
    state = "resume-wrapper";
  } else if (
    native.status === "matching" &&
    wrapper.status === "matching" &&
    native.provenance &&
    wrapper.provenance
  ) {
    state = "existing";
  } else if (
    native.status === "matching" &&
    wrapper.status === "matching" &&
    (!native.provenance || !wrapper.provenance)
  ) {
    state = "legacy-no-provenance";
  } else {
    state = "conflict";
  }
  return {
    schemaVersion: "1",
    productVersion: publication.manifest.productVersion,
    state,
    packages: inspected.map(
      ({ name, status, reason, latest, provenance, sha256: digest }) => ({
        name,
        status,
        reason: reason ?? null,
        latest: latest ?? null,
        provenance: provenance ?? false,
        sha256: digest ?? null,
      }),
    ),
  };
}

function publicationCommand(item) {
  return [
    "publish",
    item.path,
    "--access",
    "public",
    "--tag",
    "latest",
    "--provenance",
    "--registry",
    registry,
  ];
}

export async function publishFromManifest({
  directory,
  environment = process.env,
  commandRunner = spawnSync,
  fetchImpl = fetch,
  dryRun = false,
}) {
  const toolchain = assertToolchain({
    commandRunner,
    environment,
  });
  const publication = await loadPublication(directory);
  const preflight = await classifyRegistryState({ directory, fetchImpl });
  if (dryRun) {
    return { ...preflight, action: "dry-run", toolchain };
  }
  if (preflight.state === "conflict") {
    fail("npm publication conflicts with existing registry content", preflight);
  }
  if (preflight.state === "legacy-no-provenance") {
    fail("existing npm version has no trusted publishing provenance", preflight);
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "planq-npm-publish-"));
  try {
    const env = await isolatedNpmEnvironment(root, environment);
    const startIndex = preflight.state === "resume-wrapper" ? 1 : 0;
    if (preflight.state === "new" || preflight.state === "resume-wrapper") {
      for (const item of publication.packages.slice(startIndex)) {
        run(
          commandRunner,
          "npm",
          publicationCommand(item),
          {
            cwd: root,
            env,
            root,
            sourceEnvironment: environment,
          },
          `publish ${item.name}`,
        );
      }
    }
    return {
      schemaVersion: "1",
      action: preflight.state === "existing" ? "verify-only" : "publish",
      productVersion: publication.manifest.productVersion,
      state: preflight.state,
      published: publication.packages
        .slice(
          preflight.state === "existing"
            ? publication.packages.length
            : startIndex,
        )
        .map(({ name }) => name),
      toolchain,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function jsonOutput(label, output) {
  try {
    return JSON.parse(output);
  } catch {
    fail(`${label} did not return JSON`, {
      stdout: String(output).slice(-2000),
    });
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForDev(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail("planq dev exited before readiness", { status: child.exitCode });
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__plan/session`);
      if (response.ok) {
        const session = await response.json();
        if (session.protocolVersion !== "1.2") {
          fail("planq dev session protocol mismatch");
        }
        return;
      }
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("planq dev readiness timed out");
}

async function stopDev(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("planq dev did not stop")), 10_000)
    ),
  ]);
}

async function treeDigest(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const hash = createHash("sha256");
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    hash.update(child);
    hash.update("\0");
    if (entry.isDirectory()) hash.update(await treeDigest(root, child));
    else if (entry.isSymbolicLink()) hash.update(await readlink(path.join(root, child)));
    else hash.update(await readFile(path.join(root, child)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exercisePlanq({
  binary,
  publication,
  root,
  env,
  commandRunner,
  devRunner,
  includeFullSmoke,
}) {
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  run(commandRunner, "git", ["init", "-q", project], {
    cwd: root,
    env,
    root,
  }, "git init");
  const version = jsonOutput(
    "planq version",
    run(commandRunner, binary, ["version"], {
      cwd: project,
      env,
      root,
    }, "planq version"),
  );
  if (
    version.ok !== true ||
    version.command !== "version" ||
    version.result?.productVersion !== publication.manifest.productVersion ||
    version.result?.sourceCommit !== publication.manifest.release.sourceCommit ||
    version.result?.buildTarget !== publication.manifest.release.target ||
    version.result?.skill?.digest !== publication.manifest.release.skillDigest
  ) {
    fail("planq version does not match publication manifest");
  }
  if (!includeFullSmoke) return;

  const missing = jsonOutput(
    "planq skill status",
    run(commandRunner, binary, ["skill", "status"], {
      cwd: project,
      env,
      root,
    }, "planq skill status"),
  );
  if (missing.result?.status !== "missing") fail("expected missing project Skill");
  run(commandRunner, binary, ["skill", "install"], {
    cwd: project,
    env,
    root,
  }, "planq skill install");
  const current = jsonOutput(
    "planq skill status",
    run(commandRunner, binary, ["skill", "status"], {
      cwd: project,
      env,
      root,
    }, "planq skill status"),
  );
  if (current.result?.status !== "current") fail("project Skill is not current");
  run(
    commandRunner,
    binary,
    [
      "init",
      "project.plan",
      "--id",
      "npm-smoke",
      "--name",
      "Npm Smoke",
    ],
    { cwd: project, env, root },
    "planq init",
  );
  await writeFile(
    path.join(project, "plan.manifest.json"),
    '{"manifestVersion":"1","entries":["project.plan"]}\n',
  );
  for (const args of [
    ["validate", "project.plan"],
    ["normalize", "project.plan"],
    ["format", "project.plan"],
    ["format", "--check", "project.plan"],
    ["project", "validate"],
  ]) {
    run(commandRunner, binary, args, {
      cwd: project,
      env,
      root,
    }, `planq ${args.join(" ")}`);
  }

  const port = await unusedPort();
  const child = devRunner(
    binary,
    ["dev", "project.plan", "--port", String(port), "--no-open"],
    {
      cwd: project,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    try {
      await waitForDev(port, child);
    } catch (error) {
      error.details = {
        ...(error.details ?? {}),
        stdout: sanitize(stdout, root, env),
        stderr: sanitize(stderr, root, env),
      };
      throw error;
    }
  } finally {
    await stopDev(child);
  }
  const stale = await lstat(
    path.join(project, ".plan-dev-session.json"),
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stale) fail("planq dev left a stale discovery file");
}

function assertLinuxHost() {
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
  if (process.platform !== "linux" || process.arch !== "x64" || !glibc) {
    fail("npm package smoke requires Linux glibc x86_64");
  }
}

export async function smokeLocalTarballs({
  directory,
  environment = process.env,
  commandRunner = spawnSync,
  devRunner = spawn,
}) {
  assertLinuxHost();
  const toolchain = assertToolchain({ commandRunner, environment });
  const publication = await loadPublication(directory);
  const root = await mkdtemp(path.join(os.tmpdir(), "planq-npm-smoke-"));
  try {
    const env = await isolatedNpmEnvironment(root, environment);
    const [native, wrapper] = publication.packages;
    run(
      commandRunner,
      "npm",
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        native.path,
        wrapper.path,
      ],
      { cwd: root, env, root, sourceEnvironment: environment },
      "local tarball global install",
    );
    const binary = path.join(env.NPM_CONFIG_PREFIX, "bin", "planq");
    const stats = await lstat(binary).catch(() => null);
    if (!stats?.isSymbolicLink()) {
      fail("npm global install did not create the planq symlink");
    }
    await exercisePlanq({
      binary,
      publication,
      root,
      env,
      commandRunner,
      devRunner,
      includeFullSmoke: true,
    });
    const before = await treeDigest(path.join(root, "project"));
    const npx = jsonOutput(
      "local tarball npx",
      run(
        commandRunner,
        "npm",
        [
          "exec",
          "--yes",
          `--package=${native.path}`,
          `--package=${wrapper.path}`,
          "--",
          "planq",
          "version",
        ],
        { cwd: root, env, root, sourceEnvironment: environment },
        "local tarball npx",
      ),
    );
    if (npx.result?.productVersion !== publication.manifest.productVersion) {
      fail("local tarball npx version mismatch");
    }
    run(
      commandRunner,
      "npm",
      [
        "uninstall",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@planq-cli/planq",
        "@planq-cli/linux-x64",
      ],
      { cwd: root, env, root, sourceEnvironment: environment },
      "local tarball uninstall",
    );
    if (await lstat(binary).catch(() => null)) {
      fail("npm uninstall retained the planq executable");
    }
    const after = await treeDigest(path.join(root, "project"));
    if (before !== after) fail("npm uninstall modified the smoke project");
    return {
      schemaVersion: "1",
      action: "local-tarball-smoke",
      productVersion: publication.manifest.productVersion,
      toolchain,
      checks: [
        "tarball-digest",
        "global-symlink",
        "version",
        "skill",
        "init",
        "validate",
        "normalize",
        "format",
        "project-validate",
        "dev-cleanup",
        "npx",
        "uninstall",
        "project-retained",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyOnce(publication, fetchImpl) {
  const inspected = [];
  for (const item of publication.packages) {
    inspected.push(
      await inspectRegistryPackage(
        item,
        publication.manifest.productVersion,
        fetchImpl,
      ),
    );
  }
  const [native, wrapper] = inspected;
  for (const item of inspected) {
    if (
      item.status !== "matching" ||
      !item.provenance ||
      item.latest !== publication.manifest.productVersion ||
      item.definition?.name !== item.name ||
      item.definition?.version !== publication.manifest.productVersion ||
      Object.hasOwn(item.definition ?? {}, "scripts")
    ) {
      fail("published npm package verification failed", {
        package: item.name,
        status: item.status,
        latest: item.latest,
        provenance: item.provenance,
      });
    }
  }
  if (
    JSON.stringify(native.definition.os) !== '["linux"]' ||
    JSON.stringify(native.definition.cpu) !== '["x64"]' ||
    JSON.stringify(native.definition.libc) !== '["glibc"]' ||
    wrapper.definition.bin?.planq !== "bin/planq.js" ||
    wrapper.definition.optionalDependencies?.["@planq-cli/linux-x64"] !==
      publication.manifest.productVersion
  ) {
    fail("published npm package metadata contract mismatch");
  }
  return inspected;
}

export async function verifyRegistryPublication({
  directory,
  environment = process.env,
  commandRunner = spawnSync,
  fetchImpl = fetch,
  attempts = 24,
  retryDelayMs = 5000,
}) {
  assertLinuxHost();
  const toolchain = assertToolchain({ commandRunner, environment });
  const publication = await loadPublication(directory);
  let inspected;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      inspected = await verifyOnce(publication, fetchImpl);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  if (lastError) throw lastError;

  const root = await mkdtemp(path.join(os.tmpdir(), "planq-npm-verify-"));
  try {
    const env = await isolatedNpmEnvironment(root, environment);
    const version = publication.manifest.productVersion;
    run(
      commandRunner,
      "npm",
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@planq-cli/planq@${version}`,
      ],
      { cwd: root, env, root, sourceEnvironment: environment },
      "registry global install",
    );
    const binary = path.join(env.NPM_CONFIG_PREFIX, "bin", "planq");
    const stats = await lstat(binary).catch(() => null);
    if (!stats?.isSymbolicLink()) {
      fail("registry install did not create the planq symlink");
    }
    await exercisePlanq({
      binary,
      publication,
      root,
      env,
      commandRunner,
      devRunner: spawn,
      includeFullSmoke: false,
    });
    const npx = jsonOutput(
      "registry npx",
      run(
        commandRunner,
        "npm",
        [
          "exec",
          "--yes",
          `--package=@planq-cli/planq@${version}`,
          "--",
          "planq",
          "version",
        ],
        { cwd: root, env, root, sourceEnvironment: environment },
        "registry npx",
      ),
    );
    if (npx.result?.productVersion !== version) {
      fail("registry npx version mismatch");
    }
    run(
      commandRunner,
      "npm",
      [
        "uninstall",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@planq-cli/planq",
      ],
      { cwd: root, env, root, sourceEnvironment: environment },
      "registry uninstall",
    );
    return {
      schemaVersion: "1",
      action: "anonymous-verify",
      productVersion: version,
      publicationManifestSha256: publication.manifestSha256,
      toolchain,
      packages: inspected.map((item) => ({
        name: item.name,
        sha256: item.sha256,
        latest: item.latest,
        provenance: item.provenance,
      })),
      checks: [
        "metadata",
        "latest",
        "provenance",
        "tarball-digest",
        "exact-native-dependency",
        "global-symlink",
        "version",
        "npx",
        "uninstall",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--directory" && value) options.directory = value;
    else if (flag === "--dry-run" && value === "true") options.dryRun = true;
    else fail("npm release command options are invalid");
  }
  if (
    !["smoke", "preflight", "publish", "verify"].includes(command) ||
    !options.directory
  ) {
    fail(
      "usage: npm-release.mjs <smoke|preflight|publish|verify> --directory <publication-directory> [--dry-run true]",
    );
  }
  return { command, options };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const request = parseArguments(process.argv.slice(2));
    const result =
      request.command === "smoke"
        ? await smokeLocalTarballs(request.options)
        : request.command === "preflight"
          ? await classifyRegistryState(request.options)
          : request.command === "publish"
            ? await publishFromManifest(request.options)
            : await verifyRegistryPublication(request.options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    if (error.details && Object.keys(error.details).length > 0) {
      console.error(JSON.stringify(error.details));
    }
    process.exit(1);
  }
}
