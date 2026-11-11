# r9: packaged capture-retention fix

Packaging is complete. This is a new Tree archive from the parent's already-built, clean r9 source. No source edit, rebuild, Git commit/push, history/policy change, or client/native/browser/server integration was performed by packaging.

Base: `C:\office\FluidFramework-sharedtree-bridge\.artifacts`.

## Adoption pins

| Item | SHA / value |
| --- | --- |
| Source commit | `7fdff0fde45d0f748b6864e9f094e4b058e9c0b5` |
| Source parent / r8 | `d59df925b5f1617e6189924250e02b10510c9a2d` |
| Source/build directory | `r9-source` |
| New Tree archive | `r9\fluidframework-tree-2.111.0.tgz` |
| Archive SHA256 | `6346550104ecc0ec037d37919b521cdefc8518ccd735a38694c01917de3968c5` |
| Archive bytes | `4166295` |
| Verification manifest | `r9\verification.json` |
| Verification manifest SHA256 | `1d3743f26f05d0379de793e74b7c364455a2b215c0450f4886c099607f2869f6` |
| Published Tree `package.json` SHA256 | `79087852875df50b15c08d9db9e65533b03d1cb384a5098ad028fe17791b6ce2` |
| Fresh consumer | `r9-consumer` |
| Evidence | `r9-consumer\evidence` |
| Public cumulative patch baseline | `7c3fc51d5d204a16299014921e93d522590a4af2` |
| Cumulative patch | `r9\sharedtree-source.patch` |
| Cumulative patch SHA256 | `5f083e1beb0cbe20c17bea21e3c504394476a43bef5e78086928e8e3f7e38a3a` |
| Cumulative patch size | 187 files; 1,341,019 bytes |
| r8-to-r9 patch | `r9\capture-retention.patch` |
| r8-to-r9 patch SHA256 | `749ab684a1e64806e674a261c492c0d4e0911b159041cb783cb0dce55ad2f0f5` |
| r8-to-r9 patch size | 3 files; 4,290 bytes |

The npm version remains `2.111.0`; pin the archive and verification hashes, not the version or filename alone.

### Historical wrapper: reusedr2wrapper

Use **the exact existing archive**, not an r9 wrapper build:

`C:\office\ppt-sharedtree-bridge\harness-r5\vendor\fluid-framework-authority-r2.tgz`

SHA256: `2a0942ee89b05fb58f9e03ee40b7852c73a11dce4c6a7f459556d8cd2218d16f`.

Its published Tree dependency is `~2.111.0`. All 46 installed wrapper files match this archive byte-for-byte. The verification explicitly records `provenance: "reusedr2wrapper"`, `newlyBuilt: false`, and no attributed new wrapper source commit.

## Verification performed here

- Maintained **pnpm 11.9.0 `pack`**, not a hand-built tarball; Node **v24.16.0**.
- All 20 `workspace:~` dependency/devDependency entries became `~2.111.0`. No `workspace:` or `catalog:` ranges remain in the published manifest.
- Fresh ordinary npm installation into `r9-consumer`, with lifecycle scripts disabled. 111 packages installed; `package-lock.json` retained.
- Exact archive/installed file-set equality and SHA256 comparison: **3,291 Tree files**.
- Every non-manifest archive file matches r9 source/build: **3,290 files**, including **3,196** under `src`, `dist`, and `lib`.
- Exact wrapper/installed file-set equality and SHA256 comparison: **46 files**.
- Public/alpha exports have shared identities between direct Tree and historical wrapper. The wrapper resolves the same physical patched Tree; npm reports it deduplicated.
- Fresh **CJS and ESM** smoke runs, each covering **Reference/Optimized forests with authority enabled and disabled**:
  - Transitive fork isolation, rebase, merge, peer convergence.
  - Authority bootstrap/checkpoint, captured-prefix correction, reference/draft/live identity.
  - Identical in-flight retries and post-echo duplicate.
  - Detached edit/reattach and capture disposal expiry.
  - 100 public capture/export/dispose cycles per authority forest, with **0/100 WeakRefs alive** after GC in each case: **0/200 per format**.
- Historical public `.mts` / `.cts` API contracts copied unchanged and freshly compiled against the isolated r9 package.
- All 15 public API-report/entrypoint declaration files match r8 after **CRLF-to-LF normalization only**. Two API reports differ solely in newline bytes. Ten internal generated `.d.ts` files have historical byte differences; a representative difference reorders inferred object properties. These are recorded, not falsely declared byte-identical to r8. Every such r9 file still matches its actual r9 build exactly. See `evidence\declaration-comparison.json`.
- Source HEAD/parent/clean status, exact three-file fix scope, public-baseline ancestry, and reverse applicability of both patches checked.
- The cumulative patch matches the reviewer's exact raw-Git hash, file count, and byte count.
- Sixteen pinned historical/reference/parent-evidence files were rehashed unchanged. No historical checker was run unchanged.
- The readonly common loader accepted all adoption pins; its `packageFiles` path/hash contract was checked for every installed file. No transport/document runtime was loaded.

The initially overstrict historical declaration-byte check failed on newline differences. Its log is preserved, and the final verification explicitly separates historical API text equivalence from mandatory exact r9 archive/source/build/consumer byte equivalence.

## Source/build pins

Relative to `r9-source\packages\dds\tree`:

| File | SHA256 |
| --- | --- |
| `src\shared-tree-core\editManager.ts` | `c2e9f034639c75eda3d436aa63c979c7607d45db8ff23f37b8377ed3ce210cbd` |
| `dist\shared-tree-core\editManager.js` | `d3a81baefd76c997d7f6fb24051f009c51288742ec305a089822bf35d700c3ee` |
| `lib\shared-tree-core\editManager.js` | `2e1a9aa65f8047ced3418855a666c566d70d5c5ea21478dd2f654a38efe23cae` |

The production change from r8 is only the `!this.externalAuthority` guard around `onForkTransitive` in `EditManager.addSharedBranch`. The remaining changes add the two deterministic authority/non-authority listener tests and their helper option.

## Parent-executed evidence, preserved rather than relabeled

Exact copies and hashes of the parent's original evidence are under `r9-consumer\evidence\parent-evidence`. Original `r9-fixed-*`, `r9-baseline-*`, and compile logs were not rewritten.

| Parent result | Outcome |
| --- | --- |
| Selected SDK tests | 146 passing **each** CJS/ESM, including both new listener tests |
| Actual chiudean-schema capture gate | 1,000 measured + 100 warmup; retained growth **291,912 B** |
| Actual-schema capture + export gate | **467,664 B** |
| Actual-schema WeakRef gate | **335,896 B**, **0/1,100 alive** |
| Heap bound | **8,388,608 B** for each gate |

These are parent executions, not new packaging runs. The supplied memory JSON contains results and source/build pins but not its original invocation command; no command was invented. The packaging smoke's smaller WeakRef check is separate.

## Commands and evidence

Packaging command, working directory `r9-source\packages\dds\tree`:

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$env:COREPACK_ENABLE_NETWORK = '0'
& 'C:\Program Files\nodejs\pnpm.cmd' pack --pack-destination 'C:\office\FluidFramework-sharedtree-bridge\.artifacts\r9' --json
```

Its exact output is retained in `r9-consumer\evidence\pack.log`.

From `r9-consumer`:

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$env:npm_config_logs_dir = Join-Path $PWD 'evidence\npm-logs'
& 'C:\Program Files\nodejs\npm.cmd' install --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000
& 'C:\Program Files\nodejs\npm.cmd' ls @fluidframework/tree fluid-framework --all --json
& 'C:\Program Files\nodejs\node.exe' --expose-gc .\smoke.mjs CJS
& 'C:\Program Files\nodejs\node.exe' --expose-gc .\smoke.mjs ESM
& 'C:\Program Files\nodejs\node.exe' ..\r9-source\packages\dds\tree\node_modules\typescript\bin\tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 .\api-proof.mts .\api-proof.cts
& 'C:\Program Files\nodejs\node.exe' .\verify.mjs
```

Initial offline installs failed `ENOTCACHED`. A public-registry attempt failed TLS handshakes and was stopped. The configured ordinary registry then succeeded with cache preference. No TLS/auth/security policy was bypassed or changed. Failed and successful logs remain in the new evidence directory; no new tools or source dependencies were installed.

Raw patch creation used Git's own output-file option, avoiding shell reencoding:

```powershell
$b = 'C:\office\FluidFramework-sharedtree-bridge\.artifacts'
git -C "$b\r9-source" diff --binary --full-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ "--output=$b\r9\sharedtree-source.patch" 7c3fc51d5d204a16299014921e93d522590a4af2 7fdff0fde45d0f748b6864e9f094e4b058e9c0b5
git -C "$b\r9-source" diff --binary --full-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ "--output=$b\r9\capture-retention.patch" d59df925b5f1617e6189924250e02b10510c9a2d 7fdff0fde45d0f748b6864e9f094e4b058e9c0b5
```

Parent source test commands recorded by their logs:

```powershell
npm run test:mocha:cjs -- --grep "external authority|atomic authority settlement|authority publication retries|capture node references|EditManager Correctness"
npm run test:mocha:esm -- --grep "external authority|atomic authority settlement|authority publication retries|capture node references|EditManager Correctness"
```

`verification.json` is the complete machine-readable provenance and file hash manifest. `r9-consumer\evidence\final-hashes.json` contains adoption pins and source/artifact hashes.

## Limits and ownership

- No services/providers/auth/credentials/native/browser/OCS/AFR invocation. Ordinary dependency registry downloads were the only network activity needed by packaging.
- No source/history/old-r8/client/standalone/server/parent-doc writes; only the new `r9` and `r9-consumer` outputs, plus ordinary package-manager cache use.
- Offline mock sequencing and GC probes are not production COGS, real-service retention, restart, or mixed-version proof.
- Authority history/original contexts and the wire ledger remain unbounded. This fix removes capture-fork retention from an unnecessary trunk-GC listener; it does not implement durable receipts or restart recovery.
- The prior full-Fluid-history private push was rejected for the historical `test`/`Test` case collision. It was **not retried**, and no remote, history, or policy was changed.
- Parent reports exact fix/evidence already privately preserved in standalone commit `1278a4ebf3682a6c9365fc9aa1ad5928b412b607`; packaging did not revalidate or alter that commit.
- Parent owns incoming-diff bugfix and appearance-helper integration. This handoff does not claim either integration.
