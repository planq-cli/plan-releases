#!/usr/bin/env node

import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const apiRoot = "https://api.github.com";
const repository = "planq-cli/plan-releases";

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function expectedAssets(version) {
  return [
    "LICENSE",
    "SHA256SUMS",
    `planq-${version}-darwin-arm64.tar.gz`,
    `planq-${version}-linux-x86_64.tar.gz`,
    `planq-${version}-windows-x86_64.zip`,
    "planq-release-v1.json",
  ].sort();
}

export async function downloadRelease({
  tag,
  outputDirectory,
  fetchImpl = fetch,
}) {
  const match = /^v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(tag ?? "");
  if (!match) fail("release tag must be vX.Y.Z");
  const output = path.resolve(outputDirectory);
  const root = path.parse(output).root;
  if (output === root) fail("refusing unsafe release output directory");
  const existing = await lstat(output).catch(() => null);
  if (existing) fail("release output directory already exists");

  const response = await fetchImpl(
    `${apiRoot}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "planq-npm-publication",
      },
    },
  );
  if (!response.ok) {
    fail("public GitHub Release lookup failed", { status: response.status });
  }
  const release = await response.json();
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Array.isArray(release.assets)
  ) {
    fail("GitHub Release is not an eligible formal release");
  }
  const names = release.assets.map(({ name }) => name).sort();
  const expected = expectedAssets(match[1]);
  if (
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify(expected)
  ) {
    fail("GitHub Release asset set is invalid", { actual: names, expected });
  }

  const staging = `${output}.staging-${process.pid}`;
  await mkdir(staging, { recursive: true });
  try {
    for (const asset of release.assets) {
      const assetResponse = await fetchImpl(asset.browser_download_url, {
        headers: { "User-Agent": "planq-npm-publication" },
      });
      if (!assetResponse.ok) {
        fail("anonymous GitHub Release asset download failed", {
          asset: asset.name,
          status: assetResponse.status,
        });
      }
      await writeFile(
        path.join(staging, asset.name),
        Buffer.from(await assetResponse.arrayBuffer()),
        { mode: 0o600 },
      );
    }
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    schemaVersion: "1",
    tag,
    productVersion: match[1],
    releaseUrl: release.html_url,
    assets: names,
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) {
      fail("release download options must be --name value pairs");
    }
    values[flag.slice(2)] = value;
  }
  if (!values.tag || !values.output) {
    fail("usage: download-release.mjs --tag <vX.Y.Z> --output <directory>");
  }
  return { tag: values.tag, outputDirectory: values.output };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await downloadRelease(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    if (error.details && Object.keys(error.details).length > 0) {
      console.error(JSON.stringify(error.details));
    }
    process.exit(1);
  }
}
