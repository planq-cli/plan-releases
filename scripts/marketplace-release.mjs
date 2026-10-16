#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const repository = "planq-cli/plan-releases";
export const extensionId = "planq-cli.planq";
export const listingUrl = `https://marketplace.visualstudio.com/items?itemName=${extensionId}`;
const gallery = "https://marketplace.visualstudio.com/_apis/public/gallery";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message, retryable = false) => {
  const error = new Error(message);
  error.publicationError = true;
  error.retryable = retryable;
  throw error;
};
export function eligibleTag(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? "")) fail("invalid formal tag");
  const [major, minor, patch] = tag.slice(1).split(".").map(Number);
  if (major === 0 && minor === 0) fail("Marketplace automation starts at 0.1.6");
  if (major === 0 && minor === 1 && patch < 6) fail("Marketplace automation starts at 0.1.6");
  return tag.slice(1);
}
async function request(url, options, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "planq-marketplace-publication", ...options?.headers },
    });
    if (!response.ok) fail(`anonymous request failed: HTTP ${response.status}`, true);
    return response;
  } catch (error) {
    if (error.retryable) throw error;
    fail("anonymous request failed", true);
  }
}
async function json(response) {
  try { return await response.json(); } catch { fail("anonymous response is not JSON", true); }
}
export async function inspectVsix(file, version, commandRunner = spawnSync) {
  const result = commandRunner("python3", [
    path.join(import.meta.dirname, "inspect-vsix.py"), file, version,
  ], { encoding: "utf8" });
  if (result.status !== 0) fail("VSIX structured inspection failed");
  return JSON.parse(result.stdout);
}
export async function resolveCandidate({ tag, expected = {}, fetchImpl = fetch }) {
  const version = eligibleTag(tag);
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  const assetName = `planq-${version}.vsix`;
  const release = await json(await request(
    `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
    { headers: { Accept: "application/vnd.github+json" } }, fetchImpl,
  ));
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false ||
      release.html_url !== releaseUrl || !Array.isArray(release.assets)) fail("ineligible public Release");
  const names = release.assets.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail("duplicate public Release assets");
  const download = async (name) => {
    const asset = release.assets.find((entry) => entry.name === name);
    if (!asset) fail("required public Release asset missing");
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    if (asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) {
      fail("public Release asset URL or digest invalid");
    }
    const bytes = Buffer.from(await (await request(url, {}, fetchImpl)).arrayBuffer());
    if (`sha256:${digest(bytes)}` !== asset.digest) fail("public Release asset digest mismatch");
    return bytes;
  };
  const manifestBytes = await download("planq-release-v1.json");
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail("invalid public Release manifest"); }
  if (manifest.schemaVersion !== "1" || manifest.productVersion !== version ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "")) fail("public Release source identity mismatch");
  const bytes = await download(assetName);
  const candidate = {
    schemaVersion: "1", tag, version, sourceCommit: manifest.sourceCommit,
    releaseUrl, assetName, sha256: digest(bytes), extensionId, listingUrl,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!["sourceCommit", "releaseUrl", "assetName", "sha256"].includes(key) || value !== candidate[key]) {
      fail("dispatch disagrees with public Release");
    }
  }
  return { candidate, bytes };
}
export async function preflight(candidate, { fetchImpl = fetch } = {}) {
  const data = await json(await request(`${gallery}/extensionquery`, {
    method: "POST",
    headers: { Accept: "application/json;api-version=7.2-preview.1", "Content-Type": "application/json" },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: extensionId }] }],
      flags: 1,
    }),
  }, fetchImpl));
  if (!Array.isArray(data.results) || data.results.length !== 1 ||
      !Array.isArray(data.results[0].extensions)) fail("invalid Marketplace query response", true);
  const extensions = data.results[0].extensions;
  if (extensions.length === 0) return { ...candidate, state: "new", publicSha256: null };
  if (extensions.length !== 1 || extensions[0].extensionName !== "planq" ||
      extensions[0].publisher?.publisherName !== "planq-cli" ||
      !Array.isArray(extensions[0].versions)) fail("invalid Marketplace extension response", true);
  const versions = extensions[0].versions.filter(({ version }) => version === candidate.version);
  if (versions.length === 0) return { ...candidate, state: "new", publicSha256: null };
  if (versions.length !== 1) fail("ambiguous Marketplace version", true);
  const url = `${gallery}/publishers/planq-cli/vsextensions/planq/${candidate.version}/vspackage`;
  const bytes = Buffer.from(await (await request(url, {}, fetchImpl)).arrayBuffer());
  const publicSha256 = digest(bytes);
  return { ...candidate, state: publicSha256 === candidate.sha256 ? "existing" : "conflict", publicSha256 };
}
export async function prepare({ tag, expected, directory, fetchImpl = fetch }) {
  const { candidate, bytes } = await resolveCandidate({ tag, expected, fetchImpl });
  await mkdir(directory, { recursive: false });
  const file = path.join(directory, candidate.assetName);
  await writeFile(file, bytes);
  const manifest = await inspectVsix(file, candidate.version);
  const state = await preflight(candidate, { fetchImpl });
  await writeFile(path.join(directory, "candidate-v1.json"), `${JSON.stringify({ ...candidate, manifest })}\n`);
  await writeFile(path.join(directory, "prepare-v1.json"), `${JSON.stringify(state)}\n`);
  if (state.state === "conflict") fail("Marketplace digest conflict");
  return state;
}
export async function readBundle(directory) {
  const candidate = JSON.parse(await readFile(path.join(directory, "candidate-v1.json"), "utf8"));
  const version = eligibleTag(candidate.tag);
  if (candidate.schemaVersion !== "1" || version !== candidate.version ||
      candidate.assetName !== `planq-${version}.vsix` || candidate.extensionId !== extensionId ||
      candidate.releaseUrl !== `https://github.com/${repository}/releases/tag/${candidate.tag}` ||
      candidate.listingUrl !== listingUrl || !/^[a-f0-9]{40}$/.test(candidate.sourceCommit ?? "") ||
      !/^[a-f0-9]{64}$/.test(candidate.sha256 ?? "")) fail("invalid publication bundle");
  if (digest(await readFile(path.join(directory, candidate.assetName))) !== candidate.sha256) fail("bundle digest mismatch");
  const manifest = await inspectVsix(path.join(directory, candidate.assetName), version);
  if (JSON.stringify(manifest) !== JSON.stringify(candidate.manifest)) fail("bundle manifest mismatch");
  return candidate;
}
export async function publish(directory, { fetchImpl = fetch, commandRunner = spawnSync } = {}) {
  const candidate = await readBundle(directory);
  const state = await preflight(candidate, { fetchImpl });
  if (state.state === "conflict") fail("Marketplace digest conflict");
  if (state.state === "existing") return { ...state, action: "existing" };
  const result = commandRunner("vsce", [
    "publish", "--packagePath", path.join(directory, candidate.assetName), "--azure-credential",
  ], { encoding: "utf8", timeout: 180_000 });
  // Never forward tool output: it can contain credential or runner information.
  if (result.status !== 0) fail("Marketplace publication failed; retry with registry preflight", true);
  return { ...state, action: "published" };
}
export async function verify(directory, {
  fetchImpl = fetch, attempts = 12, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const candidate = await readBundle(directory);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await preflight(candidate, { fetchImpl });
      if (result.state === "conflict") fail("Marketplace digest conflict");
      if (result.state === "existing") return { ...result, verified: true };
    } catch (error) { if (!error.retryable) throw error; }
    if (attempt + 1 < attempts) await pause(Math.min(5000 * (attempt + 1), 30_000));
  }
  fail("Marketplace verification timed out", true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, directory, tag] = process.argv.slice(2);
    const result = command === "prepare"
      ? await prepare({ directory, tag, expected: process.env.EXPECTED_CANDIDATE ? JSON.parse(process.env.EXPECTED_CANDIDATE) : {} })
      : command === "publish" ? await publish(directory)
      : command === "verify" ? await verify(directory)
      : fail("usage: marketplace-release.mjs prepare|publish|verify <bundle> [tag]");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = { schemaVersion: "1", error: error.publicationError ? error.message : "Marketplace operation failed", retryable: error.retryable === true };
    if (process.argv[3]) await writeFile(path.join(process.argv[3], "operation-failure-v1.json"), `${JSON.stringify(failure)}\n`).catch(() => {});
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}
