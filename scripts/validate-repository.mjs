#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const allowedPaths = new Set([
  ".github/workflows/npm-publish.yml",
  ".github/workflows/release-container.yml",
  ".github/workflows/vscode-marketplace-publish.yml",
  "README.md",
  "npm/planq/README.md.template",
  "npm/planq/bin/planq.js",
  "package-metadata.json",
  "scripts/download-release.mjs",
  "scripts/npm-release.mjs",
  "scripts/prepare-npm.mjs",
  "scripts/marketplace-release.mjs",
  "scripts/inspect-vsix.py",
  "scripts/test/marketplace-release.test.mjs",
  "scripts/validate-repository.mjs",
]);

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function trackedFiles(commandRunner = spawnSync) {
  const result = commandRunner("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    windowsHide: true,
  });
  if (result.status !== 0) fail("could not list tracked repository files");
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function jobBlock(workflow, name, nextName = null) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) fail(`npm workflow is missing the ${name} job`);
  const end = nextName
    ? workflow.indexOf(`\n  ${nextName}:\n`, start + 1)
    : workflow.length;
  if (end === -1) fail(`npm workflow job order is invalid: ${name}`);
  return workflow.slice(start, end);
}

export function validateNpmWorkflow(workflow) {
  if (
    !/\n  release:\n\s+types:\n\s+- published\n/.test(workflow) ||
    !/\n  workflow_dispatch:\n/.test(workflow) ||
    /\n  pull_request:\n/.test(workflow)
  ) {
    fail("npm workflow triggers are invalid");
  }
  if (
    !/\npermissions:\n  contents: read\n/.test(workflow) ||
    !/\nconcurrency:\n/.test(workflow) ||
    !/retention-days: 7/.test(workflow) ||
    !/retention-days: 90/.test(workflow)
  ) {
    fail("npm workflow global controls are incomplete");
  }
  const prepare = jobBlock(workflow, "prepare", "smoke");
  const smoke = jobBlock(workflow, "smoke", "publish");
  const publish = jobBlock(workflow, "publish", "verify");
  const verify = jobBlock(workflow, "verify");
  if (
    /id-token:\s*write/.test(prepare) ||
    /id-token:\s*write/.test(smoke) ||
    /id-token:\s*write/.test(verify) ||
    !/id-token:\s*write/.test(publish) ||
    !/environment:\s*npm-production/.test(publish)
  ) {
    fail("npm workflow OIDC or Environment boundary is invalid");
  }
  if (/actions\/checkout@/.test(publish)) {
    fail("npm publish job must not check out repository content");
  }
  if (
    /(?:PLANQ_NPM_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.)/.test(workflow)
  ) {
    fail("npm workflow must not reference npm secrets");
  }
  for (const block of [smoke, verify]) {
    for (const required of [
      /target:\s*darwin-arm64\s+runner:\s*macos-14/,
      /target:\s*linux-x86_64\s+runner:\s*ubuntu-24\.04/,
      /target:\s*windows-x86_64\s+runner:\s*windows-2022/,
    ]) {
      if (!required.test(block)) {
        fail("npm workflow native matrix is incomplete", {
          required: String(required),
        });
      }
    }
  }
  for (const [block, required] of [
    [smoke, /name:\s*smoke \/ \$\{\{ matrix\.target \}\}/],
    [verify, /name:\s*anonymous verify \/ \$\{\{ matrix\.target \}\}/],
    [verify, /name:\s*Verify anonymous npm publication\s+shell:\s*bash/],
    [publish, /needs:\s*\n\s+- prepare\s*\n\s+- smoke/],
    [publish, /if:\s*needs\.prepare\.outputs\.dry-run != 'true'/],
  ]) {
    if (!required.test(block)) {
      fail("npm workflow native matrix is incomplete", {
        required: String(required),
      });
    }
  }
  const actions = [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)];
  if (
    actions.length === 0 ||
    actions.some(([, , reference]) => !/^[0-9a-f]{40}$/.test(reference))
  ) {
    fail("every npm workflow Action must use a full commit SHA");
  }
  for (const required of [
    /scripts\/download-release\.mjs/,
    /scripts\/prepare-npm\.mjs/,
    /\["new", "resume-native", "resume-wrapper", "existing", "legacy-no-provenance", "conflict"\]/,
    /npm-release\.mjs"? smoke/,
    /npm-release\.mjs"? publish/,
    /npm-release\.mjs"? verify/,
  ]) {
    if (!required.test(workflow)) {
      fail("npm workflow is missing a required command", {
        required: String(required),
      });
    }
  }
  return {
    schemaVersion: "1",
    jobs: ["prepare", "smoke", "publish", "verify"],
    actions: actions.map(([, name, reference]) => ({ name, reference })),
  };
}

export async function validateRepository({
  commandRunner = spawnSync,
} = {}) {
  const files = trackedFiles(commandRunner);
  const unexpected = files.filter((file) => !allowedPaths.has(file));
  const missing = [...allowedPaths].filter((file) => !files.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    fail("public release repository tracked file boundary is invalid", {
      unexpected,
      missing,
    });
  }
  const publicationWorkflows = files.filter(
    (file) =>
      file.startsWith(".github/workflows/") &&
      /(?:npm|publish)/i.test(path.basename(file)) &&
      ![".github/workflows/npm-publish.yml", ".github/workflows/vscode-marketplace-publish.yml"].includes(file),
  );
  if (publicationWorkflows.length > 0) {
    fail("unexpected publication workflow exists", {
      paths: publicationWorkflows,
    });
  }
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "npm-publish.yml"),
    "utf8",
  );
  return {
    ...validateNpmWorkflow(workflow),
    marketplace: validateMarketplaceWorkflow(await readFile(
      path.join(root, ".github/workflows/vscode-marketplace-publish.yml"), "utf8",
    )),
    marketplaceTooling: validateMarketplaceTooling(await readFile(
      path.join(root, "scripts/marketplace-release.mjs"), "utf8",
    )),
    trackedFiles: files,
  };
}

export function validateMarketplaceTooling(script) {
  if (!/commandRunner\("vsce", \[\s*"publish", "--packagePath", [^\n]+, "--azure-credential",\s*\]/.test(script) ||
      /--pat|--oidc|client-secret|VSCE_PAT|AZURE_CREDENTIALS|process\.env\.(?:AZURE|MARKETPLACE)/.test(script) ||
      !/const state = await preflight\(candidate/.test(script) ||
      !/if \(state.state === "existing"\) return/.test(script)) fail("Marketplace publication command boundary invalid");
  return { identity: "entra-federation", extensionId: "planq-cli.planq" };
}

export function validateMarketplaceWorkflow(workflow) {
  const prepare = jobBlock(workflow, "prepare", "publish");
  const publish = jobBlock(workflow, "publish", "verify");
  const verify = jobBlock(workflow, "verify");
  const jobs = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]);
  if (JSON.stringify(jobs) !== JSON.stringify(["prepare", "publish", "verify"])) fail("Marketplace job topology invalid");
  if (!/\n  repository_dispatch:\n    types: \[vscode-marketplace-publish\]/.test(workflow) ||
      !/\n  workflow_dispatch:\n/.test(workflow) ||
      /\n  (?:release|pull_request|push):/.test(workflow)) fail("Marketplace triggers invalid");
  if (!/default: true\s+type: boolean/.test(workflow) ||
      !/\npermissions:\n  contents: read\n/.test(workflow) ||
      !/group: marketplace-\$\{\{ github.event.client_payload.tag \|\| inputs.tag \}\}/.test(workflow) ||
      !/cancel-in-progress: false/.test(workflow) ||
      !/WORKFLOW_REF" == "refs\/heads\/\$DEFAULT_BRANCH/.test(prepare)) fail("Marketplace global controls invalid");
  if (/id-token:\s*write|^    environment:|azure\/login@/m.test(prepare + verify) ||
      !/environment: vscode-marketplace-production/.test(publish) ||
      !/permissions:\n      contents: read\n      id-token: write/.test(publish) ||
      (workflow.match(/id-token:/g) ?? []).length !== 1 ||
      !/if: needs.prepare.outputs.state == 'new' && needs.prepare.outputs.dry-run == 'false'/.test(publish)) fail("Marketplace OIDC boundary invalid");
  if (/actions\/checkout@/.test(publish + verify)) fail("Marketplace publish/verify must not check out repository content");
  const permissions = [...workflow.matchAll(/^([ ]*)permissions:\n((?:\1  [\w-]+: [^\n]+\n)+)/gm)];
  for (const [, , block] of permissions) {
    const lines = block.trim().split("\n").map((line) => line.trim());
    if (lines.some((line) => !["contents: read", "id-token: write"].includes(line))) fail("Marketplace excessive permissions");
  }
  if (/secrets\.|client[-_]secret|(?:VSCE|AZURE|MARKETPLACE)_PAT|AZURE_CREDENTIALS|CLIENT_CERTIFICATE|PRIVATE_KEY|--pat|--oidc/i.test(workflow)) fail("Marketplace must use Entra federation only");
  const pins = {
    "actions/checkout": "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "azure/login": "a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
  };
  const actions = [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)];
  if (actions.some(([, name, ref]) => pins[name] !== ref)) fail("Marketplace Action pin invalid");
  for (const [field, variable] of [
    ["client-id", "CLIENT"], ["tenant-id", "TENANT"], ["subscription-id", "SUBSCRIPTION"],
  ]) {
    if (!publish.includes(`${field}: \${{ vars.MARKETPLACE_AZURE_${variable}_ID }}`)) fail("Marketplace federated configuration source invalid");
  }
  for (const required of [
    'NODE_VERSION: "22.14.0"', 'VSCE_VERSION: "3.6.0"',
    "retention-days: 7", "retention-days: 90",
    "scripts/inspect-vsix.py", "marketplace-release.mjs prepare",
    'marketplace-release.mjs" publish', 'marketplace-release.mjs" verify',
    "vsce publish --help | grep -- --azure-credential",
    "vsce publish --help | grep -- --packagePath",
    "always() && needs.prepare.result == 'success'",
    "needs.prepare.outputs.state == 'existing'",
  ]) if (!workflow.includes(required)) fail("Marketplace required control missing");
  return { schemaVersion: "1", jobs: ["prepare", "publish", "verify"] };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await validateRepository();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    if (error.details && Object.keys(error.details).length > 0) {
      console.error(JSON.stringify(error.details));
    }
    process.exit(1);
  }
}
