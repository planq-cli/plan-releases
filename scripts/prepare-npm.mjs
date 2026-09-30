#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repository = path.resolve(import.meta.dirname, "..");
const defaultMetadata = path.join(repository, "package-metadata.json");
const wrapperSource = path.join(repository, "npm", "planq", "bin", "planq.js");
const wrapperReadmeSource = path.join(
  repository,
  "npm",
  "planq",
  "README.md.template",
);
const targets = {
  "darwin-arm64": "darwin-arm64.tar.gz",
  "linux-x86_64": "linux-x86_64.tar.gz",
  "windows-x86_64": "windows-x86_64.zip",
};
const maxArchiveEntry = 128 * 1024 * 1024;
const publicationManifestName = "npm-publication-v1.json";
const packageContracts = [
  {
    directory: "linux-x64",
    name: "@planq-cli/linux-x64",
    files: [
      "LICENSE",
      "bin/planq",
      "package.json",
      "planq-release-v1.json",
    ],
  },
  {
    directory: "planq",
    name: "@planq-cli/planq",
    files: ["LICENSE", "README.md", "bin/planq.js", "package.json"],
  },
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

function validateMetadata(metadata) {
  const fields = ["description", "homepage", "license", "repository"];
  exactKeys(metadata, fields, "package metadata");
  for (const field of fields) {
    if (
      typeof metadata[field] !== "string" ||
      metadata[field].trim() !== metadata[field] ||
      metadata[field].length === 0 ||
      /[\r\n\0]/.test(metadata[field])
    ) {
      fail(`package metadata ${field} is not ready`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(metadata.license)) {
    fail("package metadata license must be one approved SPDX identifier");
  }
  for (const field of ["homepage", "repository"]) {
    let url;
    try {
      url = new URL(metadata[field]);
    } catch {
      fail(`package metadata ${field} must be an HTTPS URL`);
    }
    if (url.protocol !== "https:") {
      fail(`package metadata ${field} must be an HTTPS URL`);
    }
  }
  return metadata;
}

async function regularFile(file, label) {
  const stats = await lstat(file).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
}

async function loadRelease(releaseDirectory) {
  const root = path.resolve(releaseDirectory);
  const manifestPath = path.join(root, "planq-release-v1.json");
  const checksumsPath = path.join(root, "SHA256SUMS");
  await regularFile(manifestPath, "release manifest");
  await regularFile(checksumsPath, "release checksums");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "productVersion",
      "sourceCommit",
      "sourceSnapshotSha256",
      "cli",
      "skill",
      "artifacts",
    ],
    "release manifest",
  );
  if (
    manifest.schemaVersion !== "1" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.productVersion) ||
    !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceSnapshotSha256) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 3
  ) {
    fail("release manifest identity is invalid");
  }

  const artifacts = new Map();
  for (const artifact of manifest.artifacts) {
    exactKeys(
      artifact,
      ["target", "archive", "sha256", "binary", "binarySha256"],
      "release artifact",
    );
    const suffix = targets[artifact.target];
    const binary = artifact.target === "windows-x86_64" ? "planq.exe" : "planq";
    if (
      !suffix ||
      artifacts.has(artifact.target) ||
      artifact.archive !== `planq-${manifest.productVersion}-${suffix}` ||
      artifact.binary !== binary ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !/^[0-9a-f]{64}$/.test(artifact.binarySha256)
    ) {
      fail("release artifact identity is invalid", { target: artifact.target });
    }
    artifacts.set(artifact.target, artifact);
  }
  if (
    JSON.stringify([...artifacts.keys()].sort()) !==
    JSON.stringify(Object.keys(targets).sort())
  ) {
    fail("release target set is incomplete");
  }

  const ordered = [...artifacts.values()].sort((left, right) =>
    left.archive.localeCompare(right.archive),
  );
  const expectedSums =
    `${ordered.map((artifact) => `${artifact.sha256}  ${artifact.archive}`).join("\n")}\n`;
  if ((await readFile(checksumsPath, "utf8")) !== expectedSums) {
    fail("SHA256SUMS is incomplete, duplicated, or unsorted");
  }
  for (const artifact of ordered) {
    const archive = path.join(root, artifact.archive);
    await regularFile(archive, `${artifact.target} archive`);
    if (sha256(await readFile(archive)) !== artifact.sha256) {
      fail("release archive checksum mismatch", { archive: artifact.archive });
    }
  }
  return { root, manifest, artifacts };
}

function tarOutput(archive, entry) {
  const result = spawnSync("tar", ["-xOf", archive, entry], {
    maxBuffer: maxArchiveEntry,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail("could not read required Linux archive entry", {
      entry,
      stderr: String(result.stderr),
    });
  }
  return result.stdout;
}

function validateTarPaths(archive) {
  const result = spawnSync("tar", ["-tf", archive], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail("could not list Linux release archive", { stderr: result.stderr });
  }
  for (const entry of result.stdout.trim().split(/\r?\n/)) {
    if (
      !entry ||
      entry.startsWith("/") ||
      /^[A-Za-z]:/.test(entry) ||
      entry.split("/").includes("..")
    ) {
      fail("Linux release archive contains an unsafe path", { entry });
    }
  }
}

function packageJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function runNpmPack(packageDirectory, destination, npmRunner) {
  const result = npmRunner(
    "npm",
    [
      "pack",
      packageDirectory,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ],
    {
      cwd: destination,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    fail("npm pack failed", {
      package: path.basename(packageDirectory),
      status: result.status,
      stderr: String(result.stderr ?? "").trim().slice(-4000),
    });
  }
  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    fail("npm pack returned invalid JSON");
  }
  if (!Array.isArray(reports) || reports.length !== 1) {
    fail("npm pack returned an invalid report");
  }
  return reports[0];
}

async function packNpmPackages({
  staging,
  release,
  npmRunner,
}) {
  const first = path.join(staging, ".pack-first");
  const second = path.join(staging, ".pack-second");
  const artifacts = path.join(staging, "artifacts");
  await Promise.all([
    mkdir(first, { recursive: true }),
    mkdir(second, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
  ]);

  const packages = [];
  for (const contract of packageContracts) {
    const packageDirectory = path.join(staging, contract.directory);
    const firstReport = runNpmPack(packageDirectory, first, npmRunner);
    const secondReport = runNpmPack(packageDirectory, second, npmRunner);
    const actualFiles = firstReport.files
      ?.map((entry) => entry.path)
      .sort();
    if (
      firstReport.filename !== secondReport.filename ||
      JSON.stringify(actualFiles) !== JSON.stringify(contract.files)
    ) {
      fail("npm tarball contract is invalid", {
        package: contract.name,
        actualFiles,
        expectedFiles: contract.files,
      });
    }
    const firstTarball = await readFile(
      path.join(first, firstReport.filename),
    );
    const secondTarball = await readFile(
      path.join(second, secondReport.filename),
    );
    const digest = sha256(firstTarball);
    if (digest !== sha256(secondTarball)) {
      fail("npm pack output is not deterministic", {
        package: contract.name,
      });
    }
    await write(artifacts, firstReport.filename, firstTarball);
    packages.push({
      name: contract.name,
      version: release.manifest.productVersion,
      file: firstReport.filename,
      sha256: digest,
    });
  }

  const releaseManifest = await readFile(
    path.join(release.root, "planq-release-v1.json"),
  );
  const publicationManifest = {
    schemaVersion: "1",
    productVersion: release.manifest.productVersion,
    release: {
      tag: `v${release.manifest.productVersion}`,
      sourceCommit: release.manifest.sourceCommit,
      sourceSnapshotSha256: release.manifest.sourceSnapshotSha256,
      manifestSha256: sha256(releaseManifest),
      skillDigest: release.manifest.skill.digest,
      target: "linux-x86_64",
    },
    packages,
  };
  await write(
    staging,
    publicationManifestName,
    `${JSON.stringify(publicationManifest, null, 2)}\n`,
  );
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
  return publicationManifest;
}

async function wrapperReadme(version, license) {
  const rendered = (await readFile(wrapperReadmeSource, "utf8"))
    .replaceAll("@@VERSION@@", version)
    .replaceAll("@@LICENSE@@", license);
  if (rendered.includes("@@") || /[\u3400-\u9fff]/u.test(rendered)) {
    fail("npm wrapper README template is invalid");
  }
  return rendered;
}

async function write(root, relative, content, mode = 0o644) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode });
  await chmod(target, mode);
}

export async function prepareNpmPackages({
  releaseDirectory,
  outputDirectory,
  metadataPath = defaultMetadata,
  npmRunner = spawnSync,
}) {
  const release = await loadRelease(releaseDirectory);
  const metadata = validateMetadata(
    JSON.parse(await readFile(path.resolve(metadataPath), "utf8")),
  );
  const output = path.resolve(outputDirectory);
  const root = path.parse(output).root;
  if (
    output === root ||
    output === repository ||
    output === release.root ||
    repository.startsWith(`${output}${path.sep}`) ||
    release.root.startsWith(`${output}${path.sep}`)
  ) {
    fail("refusing unsafe npm output directory", { output });
  }

  const version = release.manifest.productVersion;
  const linux = release.artifacts.get("linux-x86_64");
  const archive = path.join(release.root, linux.archive);
  const archiveRoot = `planq-${version}-linux-x86_64`;
  validateTarPaths(archive);
  const binary = tarOutput(archive, `${archiveRoot}/bin/planq`);
  const license = tarOutput(archive, `${archiveRoot}/LICENSE`);
  const buildInfo = JSON.parse(
    tarOutput(archive, `${archiveRoot}/build-info.json`).toString("utf8"),
  );
  if (
    sha256(binary) !== linux.binarySha256 ||
    license.length === 0 ||
    buildInfo.productVersion !== version ||
    buildInfo.sourceCommit !== release.manifest.sourceCommit ||
    buildInfo.buildTarget !== "linux-x86_64" ||
    buildInfo.skill?.digest !== release.manifest.skill?.digest
  ) {
    fail("Linux archive metadata does not match the release manifest");
  }

  const common = {
    version,
    description: metadata.description,
    license: metadata.license,
    homepage: metadata.homepage,
    repository: { type: "git", url: metadata.repository },
  };
  const wrapper = {
    name: "@planq-cli/planq",
    ...common,
    type: "module",
    bin: { planq: "bin/planq.js" },
    files: ["bin/planq.js", "README.md", "LICENSE"],
    engines: { node: ">=20" },
    optionalDependencies: { "@planq-cli/linux-x64": version },
  };
  const native = {
    name: "@planq-cli/linux-x64",
    version,
    description: "PlanQ native CLI for Linux glibc x86_64",
    license: metadata.license,
    homepage: metadata.homepage,
    repository: { type: "git", url: metadata.repository },
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
    files: ["bin/planq", "LICENSE", "planq-release-v1.json"],
  };

  const staging = `${output}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await write(staging, "planq/package.json", packageJson(wrapper));
    await write(
      staging,
      "planq/README.md",
      await wrapperReadme(version, metadata.license),
    );
    await write(staging, "planq/bin/planq.js", await readFile(wrapperSource), 0o755);
    await write(staging, "planq/LICENSE", license);
    await write(staging, "linux-x64/package.json", packageJson(native));
    await write(staging, "linux-x64/bin/planq", binary, 0o755);
    await write(staging, "linux-x64/LICENSE", license);
    await write(
      staging,
      "linux-x64/planq-release-v1.json",
      `${JSON.stringify(release.manifest)}\n`,
    );
    const publicationManifest = await packNpmPackages({
      staging,
      release,
      npmRunner,
    });
    await rm(output, { recursive: true, force: true });
    await mkdir(path.dirname(output), { recursive: true });
    await rename(staging, output);
    return {
      version,
      outputDirectory: output,
      tarballsDirectory: path.join(output, "artifacts"),
      publicationManifestPath: path.join(output, publicationManifestName),
      publicationManifest,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  if (argv.length !== 2) {
    fail("usage: prepare-npm.mjs <release-directory> <output-directory>");
  }
  return { releaseDirectory: argv[0], outputDirectory: argv[1] };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(
        await prepareNpmPackages(parseArguments(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    if (error.details && Object.keys(error.details).length > 0) {
      console.error(JSON.stringify(error.details));
    }
    process.exit(1);
  }
}
