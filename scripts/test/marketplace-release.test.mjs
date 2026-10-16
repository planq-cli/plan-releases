import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  digest, eligibleTag, inspectVsix, preflight, prepare, publish, readBundle, resolveCandidate, verify,
} from "../marketplace-release.mjs";

const tag = "v0.1.6";
const base = "https://github.com/planq-cli/plan-releases";
async function fixture(extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "marketplace-test-"));
  const vsix = path.join(directory, "fixture.vsix");
  const manifest = {
    name: "planq", publisher: "planq-cli", version: "0.1.6", displayName: "PlanQ",
    main: "./dist/extension.js", license: "PolyForm-Noncommercial-1.0.0", icon: "media/icon.png",
    engines: { vscode: "^1.90.0" }, homepage: "https://planq.dev/docs/guides/editor-integration",
    repository: { type: "git", url: `${base}.git` }, bugs: { url: "https://planq.dev/docs/troubleshooting" },
    galleryBanner: { color: "#24292f", theme: "dark" },
  };
  const entries = {
    "[Content_Types].xml": "<Types/>",
    "extension.vsixmanifest": '<PackageManifest xmlns="urn:vsix"><Metadata><Identity Version="0.1.6" Publisher="planq-cli" Id="planq"/></Metadata></PackageManifest>',
    "extension/package.json": JSON.stringify(manifest),
    "extension/LICENSE.txt": "# PolyForm Noncommercial License 1.0.0",
    "extension/readme.md": "planq-cli.planq",
    "extension/changelog.md": "## 0.1.6 - 2026-10-16",
    "extension/dist/extension.js": "exports.activate = () => {};",
    "extension/language-configuration.json": "{}",
    "extension/syntaxes/plan.tmLanguage.json": "{}",
    "extension/media/icon.png": "icon",
    ...extra,
  };
  const result = spawnSync("python3", ["-c",
    "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n for k,v in json.load(sys.stdin).items(): z.writestr(k,bytes.fromhex('89504e470d0a1a0a0000000d494844520000010000000100') if k.endswith('icon.png') and v == 'icon' else v)",
    vsix,
  ], { input: JSON.stringify(entries), encoding: "utf8" });
  assert.equal(result.status, 0);
  const bytes = await readFile(vsix);
  const releaseManifest = Buffer.from(JSON.stringify({ schemaVersion: "1", productVersion: "0.1.6", sourceCommit: "a".repeat(40) }));
  let state = "new";
  let failure = null;
  const files = { "planq-0.1.6.vsix": bytes, "planq-release-v1.json": releaseManifest };
  const release = {
    tag_name: tag, draft: false, prerelease: false, html_url: `${base}/releases/tag/${tag}`,
    assets: Object.entries(files).map(([name, value]) => ({
      name, digest: `sha256:${digest(value)}`, browser_download_url: `${base}/releases/download/${tag}/${name}`,
    })),
  };
  const response = (data, status = 200) => new Response(Buffer.isBuffer(data) ? data : JSON.stringify(data), { status });
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers?.Authorization, undefined);
    if (url.includes("api.github.com")) return response(release);
    if (url.startsWith(`${base}/releases/download/`)) return response(files[path.basename(url)]);
    if (failure) return response(failure.body ?? {}, failure.status);
    if (url.endsWith("/extensionquery")) return response({ results: [{ extensions: [{
      extensionName: "planq", publisher: { publisherName: "planq-cli" },
      versions: state === "new" ? [] : [{ version: "0.1.6" }],
    }] }] });
    return response(state === "conflict" ? Buffer.from("different VSIX") : bytes);
  };
  return { directory, vsix, bytes, release, fetchImpl, setState: (s) => { state = s; }, fail: (f) => { failure = f; } };
}
test("formal Release controls source identity, digest, and missing VSIX", async () => {
  for (const invalid of ["v0.1.5", "v0.0.9", "v0.1.6-beta", "v00.1.6"]) assert.throws(() => eligibleTag(invalid));
  const f = await fixture();
  try {
    const { candidate } = await resolveCandidate({ tag, fetchImpl: f.fetchImpl });
    assert.equal(candidate.sourceCommit, "a".repeat(40));
    await assert.rejects(resolveCandidate({ tag, expected: { sourceCommit: "b".repeat(40) }, fetchImpl: f.fetchImpl }), /dispatch disagrees/);
    f.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(resolveCandidate({ tag, fetchImpl: f.fetchImpl }), /digest mismatch/);
    f.release.assets.shift();
    await assert.rejects(resolveCandidate({ tag, fetchImpl: f.fetchImpl }), /asset missing/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("structured archive inspection rejects private files and mismatched XML identity", async () => {
  for (const extra of [{ "extension/planq": "binary" }, {
    "extension.vsixmanifest": '<PackageManifest><Identity Id="other" Publisher="planq-cli" Version="0.1.6"/></PackageManifest>',
  }, { "extension/readme.md": "/Users/private" }]) {
    const f = await fixture(extra);
    try { await assert.rejects(inspectVsix(f.vsix, "0.1.6"), /inspection failed/); }
    finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});
test("registry errors remain retryable and never become conflict", async () => {
  const f = await fixture();
  try {
    const { candidate } = await resolveCandidate({ tag, fetchImpl: f.fetchImpl });
    assert.equal((await preflight(candidate, { fetchImpl: f.fetchImpl })).state, "new");
    f.setState("existing");
    assert.equal((await preflight(candidate, { fetchImpl: f.fetchImpl })).state, "existing");
    f.setState("conflict");
    assert.equal((await preflight(candidate, { fetchImpl: f.fetchImpl })).state, "conflict");
    for (const failure of [{ status: 429 }, { status: 503 }, { status: 200, body: {} }]) {
      f.fail(failure);
      await assert.rejects(preflight(candidate, { fetchImpl: f.fetchImpl }), (error) => error.retryable === true);
    }
    await assert.rejects(preflight(candidate, { fetchImpl: async () => { throw Error("timeout"); } }), (error) => error.retryable === true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("repeat runs and publication interruption resume without another upload", async () => {
  const f = await fixture();
  const bundle = path.join(f.directory, "bundle");
  try {
    await prepare({ tag, directory: bundle, fetchImpl: f.fetchImpl });
    let uploads = 0;
    const commandRunner = (_command, args) => {
      assert.deepEqual(args.slice(-1), ["--azure-credential"]);
      uploads += 1;
      f.setState("existing");
      return { status: 0 };
    };
    assert.equal((await publish(bundle, { fetchImpl: f.fetchImpl, commandRunner })).action, "published");
    assert.equal((await publish(bundle, { fetchImpl: f.fetchImpl, commandRunner })).action, "existing");
    assert.equal(uploads, 1);
    assert.equal((await verify(bundle, { fetchImpl: f.fetchImpl, attempts: 1 })).verified, true);
    f.setState("new");
    let pauses = 0;
    assert.equal((await verify(bundle, {
      fetchImpl: f.fetchImpl, attempts: 3, pause: async () => { pauses += 1; f.setState("existing"); },
    })).verified, true);
    assert.equal(pauses, 1);
    f.setState("new");
    await assert.rejects(verify(bundle, { fetchImpl: f.fetchImpl, attempts: 2, pause: async () => {} }), /timed out/);
    f.setState("conflict");
    await assert.rejects(publish(bundle, { fetchImpl: f.fetchImpl, commandRunner }), /conflict/);
    assert.equal(uploads, 1);
    await writeFile(path.join(bundle, "planq-0.1.6.vsix"), "tampered");
    await assert.rejects(readBundle(bundle), /bundle digest mismatch/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
