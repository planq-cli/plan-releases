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
  "README.md",
  "npm/planq/README.md.template",
  "npm/planq/bin/planq.js",
  "package-metadata.json",
  "scripts/download-release.mjs",
  "scripts/npm-release.mjs",
  "scripts/prepare-npm.mjs",
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
      file !== ".github/workflows/npm-publish.yml",
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
    trackedFiles: files,
  };
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
