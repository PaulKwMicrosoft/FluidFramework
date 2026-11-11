import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const consumer = import.meta.dirname;
const base = path.dirname(consumer);
const source = path.join(base, "r9-source");
const sourceTree = path.join(source, "packages", "dds", "tree");
const output = path.join(base, "r9");
const evidence = path.join(consumer, "evidence");
const installedTree = path.join(consumer, "node_modules", "@fluidframework", "tree");
const installedWrapper = path.join(consumer, "node_modules", "fluid-framework");
const archive = path.join(output, "fluidframework-tree-2.111.0.tgz");
const wrapperArchive = "C:\\office\\ppt-sharedtree-bridge\\harness-r5\\vendor\\fluid-framework-authority-r2.tgz";
const commit = "7fdff0fde45d0f748b6864e9f094e4b058e9c0b5";
const previous = "d59df925b5f1617e6189924250e02b10510c9a2d";
const publicBase = "7c3fc51d5d204a16299014921e93d522590a4af2";
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const write = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
const filePin = file => ({ path: file, sha256: hash(file), bytes: statSync(file).size });
function files(root, relative = "") {
  return readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const entry = path.join(relative, name);
    const stat = lstatSync(path.join(root, entry));
    assert(!stat.isSymbolicLink(), `Unexpected symlink: ${entry}`);
    return stat.isDirectory() ? files(root, entry) : [entry];
  });
}
assert.equal(git("rev-parse", "HEAD"), commit);
assert.equal(git("rev-parse", "HEAD^"), previous);
assert.equal(git("status", "--porcelain"), "");
assert.equal(git("cat-file", "-t", publicBase), "commit");
git("merge-base", "--is-ancestor", publicBase, commit);
assert.equal(hash(archive), "6346550104ecc0ec037d37919b521cdefc8518ccd735a38694c01917de3968c5");
assert.equal(hash(wrapperArchive), "2a0942ee89b05fb58f9e03ee40b7852c73a11dce4c6a7f459556d8cd2218d16f");
const cumulative = path.join(output, "sharedtree-source.patch");
const incremental = path.join(output, "capture-retention.patch");
assert.equal(hash(cumulative), "5f083e1beb0cbe20c17bea21e3c504394476a43bef5e78086928e8e3f7e38a3a");
assert.equal(statSync(cumulative).size, 1341019);
assert.equal((readFileSync(cumulative, "utf8").match(/^diff --git /gm) ?? []).length, 187);
git("apply", "--check", "--reverse", cumulative);
git("apply", "--check", "--reverse", incremental);
const expectedChanges = [
  "packages/dds/tree/src/shared-tree-core/editManager.ts",
  "packages/dds/tree/src/test/shared-tree-core/edit-manager/editManagerCorrectness.test.ts",
  "packages/dds/tree/src/test/shared-tree-core/edit-manager/editManagerTestUtils.ts",
].sort();
assert.deepEqual(git("diff", "--name-only", previous, commit).split(/\r?\n/).sort(), expectedChanges);
const expectedEditManager = {
  "src\\shared-tree-core\\editManager.ts": "c2e9f034639c75eda3d436aa63c979c7607d45db8ff23f37b8377ed3ce210cbd",
  "dist\\shared-tree-core\\editManager.js": "d3a81baefd76c997d7f6fb24051f009c51288742ec305a089822bf35d700c3ee",
  "lib\\shared-tree-core\\editManager.js": "2e1a9aa65f8047ced3418855a666c566d70d5c5ea21478dd2f654a38efe23cae",
};
for (const [file, expected] of Object.entries(expectedEditManager)) {
  assert.equal(hash(path.join(sourceTree, file)), expected, file);
}
const extraction = path.join(evidence, "verification-extraction");
assert(!existsSync(extraction), "Unexpected stale verification extraction");
mkdirSync(path.join(extraction, "tree"), { recursive: true });
mkdirSync(path.join(extraction, "wrapper"));
execFileSync("tar", ["-xf", archive, "-C", path.join(extraction, "tree")]);
execFileSync("tar", ["-xf", wrapperArchive, "-C", path.join(extraction, "wrapper")]);
const archiveTree = path.join(extraction, "tree", "package");
const archiveWrapper = path.join(extraction, "wrapper", "package");
const archiveFiles = files(archiveTree);
assert.deepEqual(files(installedTree), archiveFiles, "Tree archive/installed file sets differ");
assert.deepEqual(files(installedWrapper), files(archiveWrapper), "Wrapper archive/installed file sets differ");
const packageFiles = archiveFiles.map(relative => {
  const sha256 = hash(path.join(archiveTree, relative));
  assert.equal(hash(path.join(installedTree, relative)), sha256, `Consumer differs: ${relative}`);
  if (relative !== "package.json") {
    assert.equal(hash(path.join(sourceTree, relative)), sha256, `Source/build differs: ${relative}`);
  }
  return { path: relative, sha256 };
});
assert(packageFiles.length > 3000);
const wrapperFiles = files(archiveWrapper).map(relative => {
  const sha256 = hash(path.join(archiveWrapper, relative));
  assert.equal(hash(path.join(installedWrapper, relative)), sha256, `Wrapper differs: ${relative}`);
  return { path: relative, sha256 };
});
assert(wrapperFiles.length >= 40);
const published = json(path.join(archiveTree, "package.json"));
const original = json(path.join(sourceTree, "package.json"));
assert.equal(published.name, "@fluidframework/tree");
assert.equal(published.version, "2.111.0");
assert(!JSON.stringify(published).includes("workspace:"));
assert(!JSON.stringify(published).includes("catalog:"));
const rewrittenRanges = [];
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  for (const [name, value] of Object.entries(original[field] ?? {})) {
    if (value === "workspace:~") {
      assert.equal(published[field][name], "~2.111.0", `${field}.${name}`);
      rewrittenRanges.push({ field, name, before: value, after: published[field][name] });
    }
  }
}
assert.equal(json(path.join(archiveWrapper, "package.json")).dependencies["@fluidframework/tree"], "~2.111.0");
const oldVerification = json(path.join(base, "r8", "verification.json"));
const unchangedDeclarations = oldVerification.packageFiles.filter(entry =>
  entry.path.startsWith("api-report\\") ||
  /^(lib|dist)\\entrypoints\\.*\.d\.ts$/.test(entry.path) ||
  /^(alpha|beta|internal|legacy)\.d\.ts$/.test(entry.path));
const lineEndingDifferences = [];
for (const entry of unchangedDeclarations) {
  const historicalFile = path.join(base, "r8-consumer", "node_modules", "@fluidframework", "tree", entry.path);
  assert.equal(hash(historicalFile), entry.sha256.toLowerCase(), `Unpinned historical declaration: ${entry.path}`);
  const current = path.join(archiveTree, entry.path);
  assert.equal(readFileSync(current, "utf8").replace(/\r\n/g, "\n"),
    readFileSync(historicalFile, "utf8").replace(/\r\n/g, "\n"),
    `Published entrypoint/API report differs from r8: ${entry.path}`);
  if (hash(current) !== entry.sha256.toLowerCase()) lineEndingDifferences.push(entry.path);
}
const internalDeclarationByteDifferences = oldVerification.packageFiles.filter(entry =>
  entry.path.endsWith(".d.ts") && hash(path.join(archiveTree, entry.path)) !== entry.sha256.toLowerCase())
  .map(entry => ({ path: entry.path, historicalSha256: entry.sha256.toLowerCase(),
    currentSha256: hash(path.join(archiveTree, entry.path)) }));
write(path.join(evidence, "declaration-comparison.json"), {
  apiReportAndEntrypointFilesCompared: unchangedDeclarations.length,
  comparison: "Exact UTF-8 text after CRLF-to-LF normalization; no source/API changes from r8.",
  lineEndingDifferences, internalDeclarationByteDifferences,
  internalDeclarationNote: "Internal generated declaration bytes are not asserted equal to historical r8; all are byte-verified against r9 source/build. A representative diff reorders inferred object properties.",
});
const parentEvidence = path.join(evidence, "parent-evidence");
mkdirSync(parentEvidence, { recursive: true });
const parentNames = [
  "r9-fixed-authority-cjs.log", "r9-fixed-authority-esm.log",
  "r9-capture-fix-compile.log", "r9-initial-compile.log",
  "r9-fixed-capture-1000.json", "r9-fixed-export-1000.json", "r9-fixed-weak-1000.json",
];
for (const name of parentNames) {
  copyFileSync(path.join(base, name), path.join(parentEvidence, name));
  assert.equal(hash(path.join(base, name)), hash(path.join(parentEvidence, name)));
}
const tests = ["CJS", "ESM"].map(lane => {
  const log = path.join(parentEvidence, `r9-fixed-authority-${lane.toLowerCase()}.log`);
  const text = readFileSync(log, "utf8");
  assert.match(text, /146 passing/);
  for (const authority of ["false", "true"]) {
    assert(text.includes(`only tracks transitive forks when trunk GC is enabled (authority=${authority})`));
  }
  return { lane, passed: 146, executionOwner: "parent; not rerun by packaging",
    command: lane === "CJS"
      ? 'npm run test:mocha:cjs -- --grep "external authority|atomic authority settlement|authority publication retries|capture node references|EditManager Correctness"'
      : 'npm run test:mocha:esm -- --grep "external authority|atomic authority settlement|authority publication retries|capture node references|EditManager Correctness"',
    log: filePin(log) };
});
const memory = [
  ["r9-fixed-capture-1000.json", 291912],
  ["r9-fixed-export-1000.json", 467664],
  ["r9-fixed-weak-1000.json", 335896],
].map(([name, growth]) => {
  const record = json(path.join(parentEvidence, name));
  assert.equal(record.success, true);
  assert.equal(record.count, 1000);
  assert.equal(record.warmup, 100);
  assert.equal(record.retainedGrowthBytes, growth);
  assert.equal(record.maxGrowthBytes, 8388608);
  assert(growth < record.maxGrowthBytes);
  assert.equal(record.provenance.editManagerSourceSha256, expectedEditManager["src\\shared-tree-core\\editManager.ts"]);
  assert.equal(record.provenance.editManagerBuildSha256, expectedEditManager["dist\\shared-tree-core\\editManager.js"]);
  assert.equal(record.networkRequests, 0);
  assert.equal(record.nativeWorkers, 0);
  if (record.mode === "capture-weak") assert.equal(record.disposedCapturesAlive, 0);
  return { executionOwner: "parent; actual chiudean schema, not rerun by packaging",
    commandProvenance: "Original invocation not present in supplied JSON; retained verbatim, not reconstructed.",
    evidence: filePin(path.join(parentEvidence, name)), result: record };
});
const smoke = ["CJS", "ESM"].map(lane => {
  const result = json(path.join(evidence, `smoke-${lane}.json`));
  assert.equal(result.success, true);
  assert.equal(result.archiveSha256, hash(archive));
  assert.equal(result.wrapperSha256, hash(wrapperArchive));
  assert.equal(result.editManagerSha256, expectedEditManager[`${lane === "CJS" ? "dist" : "lib"}\\shared-tree-core\\editManager.js`]);
  assert.equal(result.wrapperAndDirectIdentity, true);
  assert.equal(result.proofs.length, 4);
  for (const proof of result.proofs) {
    assert.equal(proof.transitiveForkIsolationRebaseMerge, true);
    if (proof.externalAuthority) {
      assert.equal(proof.captureExportDisposeCycles, 100);
      assert.equal(proof.disposedCapturesAlive, 0);
    }
  }
  return { command: `& 'C:\\Program Files\\nodejs\\node.exe' --expose-gc .\\smoke.mjs ${lane}`, result };
});
const protectedBefore = json(path.join(evidence, "protected-before.json"));
for (const entry of protectedBefore) assert.equal(hash(entry.path), entry.sha256.toLowerCase(), entry.path);
const declarations = json(path.join(evidence, "declarations.json"));
assert.equal(declarations.success, true);
assert.equal(declarations.exitCode, 0);
for (const extension of ["mts", "cts"]) {
  assert.equal(hash(path.join(consumer, `api-proof.${extension}`)),
    hash(path.join(base, "r8-consumer", `api-proof.${extension}`)));
}
const sourceArtifactHashes = [
  ...Object.keys(expectedEditManager),
  "src\\shared-tree\\externalAuthorityController.ts",
  "dist\\shared-tree\\externalAuthorityController.js",
  "lib\\shared-tree\\externalAuthorityController.js",
  "package.json",
].map(relative => filePin(path.join(sourceTree, relative)));
assert.equal(git("status", "--porcelain"), "");
const manifest = {
  successor: "r9", sourceCommit: commit, sourceParent: previous, patchBase: publicBase,
  branch: git("branch", "--show-current"), sourceRoot: source, sourceClean: true,
  packageVersion: published.version, archiveSha256: hash(archive), archiveBytes: statSync(archive).size,
  sourcePatchSha256: hash(cumulative), sourcePatchBytes: statSync(cumulative).size, sourcePatchFiles: 187,
  retentionOnlyPatchSha256: hash(incremental), sourceChangesFromR8: expectedChanges,
  protocolVersion: 2, ddsType: "https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2",
  apiSignatureChanges: false, declarationsAndApiReportsUnchangedFromR8: unchangedDeclarations.length,
  apiComparison: { normalization: "CRLF to LF only", lineEndingDifferences, internalDeclarationByteDifferences },
  sourceArtifactHashes, publishedManifestSha256: hash(path.join(installedTree, "package.json")),
  rewrittenRanges, packageFiles,
  archiveConsumerFilesByteMatched: packageFiles.length,
  sourceBuildFilesByteMatched: packageFiles.length - 1,
  productionFilesByteMatched: packageFiles.filter(entry => /^(src|lib|dist)\\/.test(entry.path)).length,
  wrapper: {
    provenance: "reusedr2wrapper", newlyBuilt: false, sourceCommit: null,
    archive: wrapperArchive, archiveSha256: hash(wrapperArchive), treeDependency: "~2.111.0",
    packageFiles: wrapperFiles, archiveConsumerFilesByteMatched: wrapperFiles.length,
  },
  wrapperSha256: hash(wrapperArchive), consumerDirectory: consumer,
  sourceTests: tests, parentActualSchemaMemoryGates: memory, isolatedConsumerSmoke: smoke,
  packedPublicDeclarationTests: declarations,
  consumerPackageManifest: filePin(path.join(consumer, "package.json")),
  consumerLockfile: filePin(path.join(consumer, "package-lock.json")),
  packCommand: "& 'C:\\Program Files\\nodejs\\pnpm.cmd' pack --pack-destination 'C:\\office\\FluidFramework-sharedtree-bridge\\.artifacts\\r9' --json",
  packWorkingDirectory: sourceTree, packTool: "pnpm 11.9.0", nodeVersion: process.version,
  installCommand: "& 'C:\\Program Files\\nodejs\\npm.cmd' install --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000",
  installation: {
    result: "111 packages installed into fresh consumer using configured registry, cache preferred; scripts disabled",
    earlierFailures: [
      "Offline configured/public registry attempts: ENOTCACHED; retained logs.",
      "Public registry attempt: TLS handshake failure; process stopped, not bypassed. Configured registry succeeded.",
    ],
  },
  preservedFilesRehashed: protectedBefore.length,
  preservationScope: "Pinned historical artifacts, parent evidence and readonly loader rehashed; no writes outside owned r9 and r9-consumer, except ordinary package-manager cache.",
  sourceHistory: {
    publicBaseline: publicBase, exactReviewedRawGitPatch: true,
    privateStandalonePreservationCommit: "1278a4ebf3682a6c9365fc9aa1ad5928b412b607",
    privateStandaloneProvenance: "Parent-supplied, not independently revalidated by packaging.",
    fullHistoryPush: "Previously rejected by ADO historical test/Test case collision; not retried. No Git commit/push/history or policy edits.",
  },
  omitted: [
    "No client/standalone/native/browser/server/parent-doc integration changes.",
    "No providers/auth/credentials/services/OCS/AFR; package registry downloads only.",
    "Parent source tests and actual-schema heap gates retained, not rerun.",
    "Mock sequencing is not production retention, COGS, restart or mixed-version proof.",
    "Authority history/original contexts and wire ledger remain unbounded; no durable receipt reopening.",
    "Parent common loader install/loadDocument/loadTransport not executed.",
  ],
};
rmSync(extraction, { recursive: true });
manifest.evidence = files(evidence).filter(relative =>
  !relative.startsWith("npm-logs\\") && !["verification.log", "final-hashes.json"].includes(relative))
  .map(relative => filePin(path.join(evidence, relative)));
for (const file of ["smoke.mjs", "verify.mjs", "api-proof.mts", "api-proof.cts"]) {
  manifest.evidence.push(filePin(path.join(consumer, file)));
}
const manifestPath = path.join(output, "verification.json");
write(manifestPath, manifest);
const pins = {
  tree: manifest.archiveSha256, wrapper: manifest.wrapperSha256, manifest: hash(manifestPath),
  source: commit, dds: manifest.ddsType,
};
const require = createRequire(import.meta.url);
const loader = require("C:\\office\\ppt-sharedtree-bridge\\harness-interactive\\runtime-sdk.cjs");
assert.deepEqual(loader.createRuntime(pins).pins, pins);
// Match the readonly common loader's packageFiles path and hash contract without loading any transport.
for (const entry of json(manifestPath).packageFiles) {
  const file = path.resolve(realpathSync(installedTree), entry.path);
  assert(file.startsWith(`${realpathSync(installedTree)}${path.sep}`));
  assert.equal(hash(file), entry.sha256.toLowerCase());
}
write(path.join(evidence, "final-hashes.json"), {
  sourceCommit: commit, pins, cumulativePatch: filePin(cumulative), retentionPatch: filePin(incremental),
  publishedPackageManifest: filePin(path.join(installedTree, "package.json")),
  sourceArtifactHashes, treeFiles: packageFiles.length, wrapperFiles: wrapperFiles.length,
  commonLoaderPinAndPackageFilesContract: "passed; transport/document not loaded",
});
console.log(JSON.stringify({
  success: true, sourceCommit: commit, pins, treeFiles: packageFiles.length,
  wrapperFiles: wrapperFiles.length, sourceBuildFiles: packageFiles.length - 1,
  unchangedDeclarations: unchangedDeclarations.length, workspaceRangesRewritten: rewrittenRanges.length,
  consumer, cumulativePatchSha256: hash(cumulative),
}, null, 2));
