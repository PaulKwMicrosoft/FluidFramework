# r8: separate all-three-M4 successor

Adopt this explicit successor lane, not the historical retry-only r7 or the interim `r7-m4` source-path arrangement.

## Pins and ownership

Base directory: `C:\office\FluidFramework-sharedtree-bridge\.artifacts`.

| Item | Value |
| --- | --- |
| Independent source/build worktree | `r8-source` |
| Local branch | `user/paulkw/sharedtree-reentrant-capture-disposal` |
| Source commit | `d59df925b5f1617e6189924250e02b10510c9a2d` |
| Parent, retry-only r7 | `69604b14fb00180252bfa04e6f28c9d2d980103b` |
| Cumulative patch base, r6 | `ae2ecd6572c1bc46b7a3cd6207106d5ecc5ff1e0` |
| Package | `r8\fluidframework-tree-2.111.0.tgz` |
| Package SHA256 | `EA7CFC5BB102887160482896309F9BD89A0A435040BBDCD26D937AE4C99FFE55` |
| Cumulative `sharedtree-source.patch` SHA256 | `470DDCE2A6BBF2F4EDAFE6DA0499D55E3017C3709D4D5E14CAF2D6485759CC5E` |
| Disposal-only `capture-disposal.patch` SHA256 | `40D84CE2F9C8A63235F6364C3B33482838DF27A95AEE0CDA5B61FA3FCED5EF2E` |
| `verification.json` SHA256 | `AE06917FF064998DD949992A27BD250B321B818A5695B3B776E4430A61C7DB7B` |
| Independent consumer | `r8-consumer` |
| Fresh execution/provenance evidence | `r8-evidence` and `r8\verification.json` |

This is the already implemented all-M4 source commit and archive, isolated under a new source branch/worktree and delivery lane. No semantic change, new commit, rebuild or repack was needed merely to change the lane name. The archive is byte-identical to the interim all-M4 archive, not to the original retry-only r7 archive. Its npm version remains `2.111.0`; use the hash, not the version string or tarball basename.

Dependencies and compiled outputs were copied independently. Relative dependency links resolve inside `r8-source`, not into r7/r6. An initial copy materialized dependency aliases and caused a Mocha dependency-resolution error. Only those new r8 aliases were repaired; the failed run and repair inventory are retained. Final source and packed executions ran after that repair. No package-manager install/restore was performed.

## Preservation correction

The retry-only r7 had already been delivered when the disposal request arrived. Before the later immutable-artifact clarification, its `r7-source` worktree and derived build outputs were advanced to the disposal commit. That was not uninterrupted preservation of the delivered source/build directory, even though the original package, patches, handoff, verification, consumer and evidence were left unchanged.

The correction is explicit rather than rewriting historical proof:

- `r7-source` and its original `user/paulkw/sharedtree-publication-retries` branch are restored to `69604b14fb00180252bfa04e6f28c9d2d980103b`; tracked content is clean.
- All 3,287 archived non-manifest files in that Tree source/build directory again match the original r7 verification manifest byte-for-byte.
- The reference test source is unchanged between original r7 and r6. Its unarchived compiled test outputs were recovered from the retained r6 build. Those are not claimed as independently hash-proven original r7 test-output bytes.
- Original unarchived incremental-build metadata cannot be certified byte-for-byte. Do not use that metadata to establish historical provenance. See `r8-evidence\r7-restoration.json`.
- Original r7 and interim r7-m4 package/evidence/consumer directories remain unchanged. Their historical manifests are not relabeled or regenerated.
- The advanced old branch tip is retained as `user/paulkw/sharedtree-publication-retries-m4-historical`; no commit was amended or lost. r8 has its own branch at the same all-M4 commit.

The final checker rehashes the prior-delivery ledger, all protected r5/r6 files, original r7 archived bytes, and the independent r8 installed package against a fresh extraction of the pinned archive. This establishes the successor's current integrity, not a false claim that r7's source directory was never changed.

Final comparisons matched 21,588 files across the six prior delivery/evidence/consumer directories, 12,330 protected r5/r6 files, all 3,288 installed r8 package files, and all 46 wrapper files. Of the installed package files, 3,287 non-manifest files also match the independent r8 source/build, including 3,197 production files.

## Supported contract

All three M4 defects are fixed together:

1. Identical in-flight public pure-prefix/correction retries share one underlying submission and wait for its local self-echo. Changed immutable inputs reject without poisoning the tree or corrupting the first operation. Kernel ownership and the lower-level send route are covered.
2. Identical retry after applied echo returns `duplicate`, including a sealed original correction draft; stale stays stale. Identity is the original capture, prefix, checkpoint and owned draft/head, never snapshot equality or a freshly reauthored equivalent edit.
3. Reference-capture disposal performs transaction/change-event preflight before expiry, then expires the controller before draft revertible disposal invokes caller callbacks. Recursive `capture.dispose()` is a no-op. Rejected invalid-time disposal leaves the capture usable. Real observer errors propagate while internal A/S snapshot cleanup runs in `finally`.

Public API signatures, wire protocol v2 and DDS name are unchanged. There is no v1 migration or mixed-version deployment assertion. Genuine detach/edit/reattach, atomic accepted-prefix correction and capture references retain their existing contracts.

Public receipt records and core in-flight sends each retain their existing 128-entry bounds. Disposing a capture expires public retry scope, not an already submitted operation. Authority history/original contexts and the wire ledger remain unbounded. There is no durable receipt reopening, restart/service-expiry recovery or successful teardown guarantee for arbitrary throwing observers. Such observers can interrupt remaining public-draft cleanup even though capture expiry is committed and internal snapshots are closed.

Capture references remain opt-in, schema-field-free, process-local and capture-lifetime-bound. Correction-draft-born to eventual-live correspondence, durable global identity, required-field temporary vacancy and full old detach parity remain outside the supported boundary.

## Fresh r8 results

| Layer | Result |
| --- | --- |
| Targeted source regressions | 111 passed per ESM/CJS format |
| Actual packed public disposal contracts | 8 passed per format, both forests |
| Actual packed positive retry contracts | 12 passed per format |
| Adapted adversarial regressions | 18 passed per format; 2 obsolete historical defect assertions explicitly skipped |
| Packed reference/atomic traces | Eight completed across both formats and forests |
| Packed public `.mts` / `.cts` declarations | Passed |
| Targeted ESLint | Passed |

These are local mock sequencing tests, not AFR, OCS or native execution. The parent's earlier r5 AFR proof is not attributed to r8.

Commands use the existing real Node executable at `C:\Program Files\nodejs\node.exe`. Source commands:

```powershell
$b = 'C:\office\FluidFramework-sharedtree-bridge\.artifacts'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
Set-Location "$b\r8-source\packages\dds\tree"
$env:NODE_PATH = @(
    "$b\r8-source\node_modules\.pnpm\mocha@11.7.5\node_modules\mocha\node_modules",
    "$b\r8-source\node_modules\.pnpm\mocha@11.7.5\node_modules",
    "$b\r8-source\node_modules\.pnpm\node_modules"
) -join ';'
$env:FLUID_TEST_MODULE_SYSTEM = 'ESM' # Repeat with CJS.
node .\node_modules\mocha\bin\mocha.js --grep '^authority publication retries|^capture node references|^atomic authority settlement|^external authority|^detached reinsertion'
node .\node_modules\eslint\bin\eslint.js --quiet --format stylish .\src\shared-tree\authorityNodeReferences.ts .\src\shared-tree\externalAuthorityController.ts .\src\test\shared-tree\authorityNodeReferences.spec.ts
```

From `r8-consumer`:

```powershell
$env:ADVERSARIAL_FORMAT = 'ESM' # Repeat with CJS.
node --test .\capture-disposal.mjs
node --test .\retry-contracts.mjs
node --test .\adversarial\suite.mjs
node .\references.cjs ESM Reference
node .\proof.cjs ESM Reference
# Repeat both traces with CJS and Optimized.
node ..\r8-source\packages\dds\tree\node_modules\typescript\bin\tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 .\api-proof.mts .\api-proof.cts
```

`r8-evidence\verify.ps1` records source/patch/package provenance, installed archive byte matching, prior-delivery preservation, restoration limits and structured results. No service, auth, browser, Office build, native/OCS/AFR call, peer message, parent integration edit or push was performed. Parent retains private backup/adoption ownership.
