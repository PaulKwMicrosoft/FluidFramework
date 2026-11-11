# r7 all-M4 successor

This delivery includes all three confirmed M4 fixes: nonfatal identical in-flight publication retries, idempotent correction retries after self-echo, and reentrant reference-capture disposal. It supersedes the initial r7 package for new consumption without overwriting that historical delivery.

## Exact pins

Artifact root: `C:\office\FluidFramework-sharedtree-bridge\.artifacts\r7-m4`

| Item | Pin |
| --- | --- |
| Source commit | `d59df925b5f1617e6189924250e02b10510c9a2d` |
| Direct parent / initial r7 | `69604b14fb00180252bfa04e6f28c9d2d980103b` |
| Cumulative patch base / frozen r6 | `ae2ecd6572c1bc46b7a3cd6207106d5ecc5ff1e0` |
| `fluidframework-tree-2.111.0.tgz` SHA256 | `EA7CFC5BB102887160482896309F9BD89A0A435040BBDCD26D937AE4C99FFE55` |
| `sharedtree-source.patch` SHA256 | `470DDCE2A6BBF2F4EDAFE6DA0499D55E3017C3709D4D5E14CAF2D6485759CC5E` |
| `capture-disposal.patch` SHA256 | `40D84CE2F9C8A63235F6364C3B33482838DF27A95AEE0CDA5B61FA3FCED5EF2E` |
| `verification.json` SHA256 | `91A59BF5685309453FF549D30F9CC238DB13BD1165099802EFB4187324D7A43B` |

Source worktree: `C:\office\FluidFramework-sharedtree-bridge\.artifacts\r7-source`

Local branch: `user/paulkw/sharedtree-publication-retries`

The cumulative patch contains all three fixes from frozen r6. The disposal-only patch is incremental from the initial r7 commit. Both source commits have the required Copilot trailers; neither was amended or pushed.

The npm version remains `2.111.0`: identify this experimental build by its archive hash, not its version string or tarball basename. The initial r7 archive (`F8F4E58F...FA1DECE`) remains unchanged in `r7`.

## API and implementation contract

There is no new public API signature, wire-envelope or DDS-name change in this successor. The existing opt-in authority v2 and capture-reference contracts remain in force. This does not authorize a v1 container migration or establish mixed-version deployment compatibility.

The initial r7 retry implementation is retained:

- Identical public calls use the same immutable capture, prefix count, checkpoint and owned draft identity/head. Snapshot equality and reauthoring equivalent edits do not establish retry identity.
- Identical in-flight calls share one underlying submission and wait for its own local self-echo. They need not return the same JavaScript Promise object.
- After applied self-echo, identical retry returns `duplicate` without applying the correction again; a stale outcome remains `stale`. This works before Promise callbacks run and after later authority advances.
- Changed-input reuse, unfinished draft transactions and expired capture/draft usage reject without poisoning the tree or corrupting the first operation. Controllers are canonicalized by kernel; the lower-level publication route also handles benign retry validation.
- A real submission failure still propagates. No breaker is caught/reset to manufacture success. An identical peer message alone cannot complete a local pending submission.

Public publication records are bounded to 128 per controller/kernel; the core also bounds in-flight publication operations to 128. Capture disposal releases completed public records; unresolved records for disposed captures are released when they finish. Disposing a capture does not cancel an already submitted operation. Public retries are not sequencing barriers for unrelated local edits.

### Reentrant disposal fix

The additional production change is intentionally narrow:

1. `AuthorityNodeReferences.checkCanDispose()` performs the existing checkout transaction/change-event preflight without changing ownership or invoking observers.
2. The controller performs that preflight before expiring the capture. Rejected invalid-time disposal therefore leaves the capture usable.
3. The controller marks the capture expired before registry teardown can dispose public drafts and invoke caller-owned revertible callbacks. A callback that calls `capture.dispose()` now sees an expired capture and does nothing.
4. Nested `finally` cleanup closes both internal approved and sequenced snapshot checkouts even if reference teardown propagates a real observer error.

Source locations:

- `packages\dds\tree\src\shared-tree\externalAuthorityController.ts`: capture disposal ordering and existing publication receipts.
- `packages\dds\tree\src\shared-tree\authorityNodeReferences.ts`: extracted read-only preflight, also retained defensively in registry disposal.
- `packages\dds\tree\src\test\shared-tree\authorityNodeReferences.spec.ts`: eight additional cases across the two forest kinds.
- `packages\dds\tree\EXTERNAL_AUTHORITY_PROTOTYPE.md`: lifetime/error contract.

No callback or asynchronous yield occurs between controller preflight and the registry's defensive recheck. Anchor transfer, identity mapping and history projection algorithms were not changed.

A real throwing disposal observer can still interrupt the registry's remaining public-draft cleanup. This fix guarantees committed controller expiry, error propagation and internal snapshot cleanup; it does not guarantee recovery/completion of arbitrary failed observer teardown. Subsequent capture disposal remains a no-op, not a retry mechanism for that failure.

## Executed evidence

All runs below used real local mock sequencing, not AFR or OCS.

| Coverage | Result |
| --- | --- |
| Targeted ESM source cases | 111 passed |
| Targeted CJS source cases | 111 passed |
| Packed public disposal cases | 8 passed per format |
| Packed positive publication-retry cases | 12 passed per format |
| Adapted adversarial regressions | 18 passed per format; 2 obsolete historical defect assertions explicitly skipped |
| Packed reference/atomic traces | 8 completed: two fixtures x two forests x two formats |
| Packed public declarations | `.mts` and `.cts` consumers passed |
| Targeted ESLint | Passed |

The source total is 20 retry + 38 reference/disposal + 19 atomic + 16 detach + 18 authority cases per format. Counts above are separate suites, not an assertion that their coverage is disjoint.

The exact public reentrant disposal was independently reproduced before the fix against the preserved initial r7 package, which inherited the r6 defect. Both ObjectForest and ChunkedForest failed in both CJS and ESM with:

`The branch has already been disposed and cannot be disposed again.`

Those expected failures are preserved as `r7-m4-evidence\before-CJS.log/json` and `before-ESM.log/json`. They are not claimed as new executions against the frozen r6 package.

The fixed public test obtains a draft revertible through `asTreeViewAlpha(draft.viewWith(...)).events.on("changed", ...)` and supplies `() => capture.dispose()` as its disposal callback. Additional cases cover multiple drafts, repeat disposal, live and draft transaction/change-event preflight, expired-capture observation during callbacks, and propagation of a sentinel observer exception. Both forest kinds and both installed package formats are covered.

Fresh consumer: `C:\office\FluidFramework-sharedtree-bridge\.artifacts\r7-m4-consumer`

Fresh evidence: `C:\office\FluidFramework-sharedtree-bridge\.artifacts\r7-m4-evidence`

Source build commands, from `r7-source\packages\dds\tree`, with real Node 24.16.0 on PATH:

```powershell
node .\node_modules\typescript\bin\tsc --project .\tsconfig.json
node .\node_modules\typescript\bin\tsc --project .\src\test\tsconfig.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\tsconfig.cjs.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\src\test\tsconfig.cjs.json
```

With the existing r7 Mocha dependency paths on `NODE_PATH`, run this once for each `FLUID_TEST_MODULE_SYSTEM=ESM` and `CJS`:

```powershell
node .\node_modules\mocha\bin\mocha.js --grep '^authority publication retries|^capture node references|^atomic authority settlement|^external authority|^detached reinsertion'
```

From `r7-m4-consumer`, run for each `ADVERSARIAL_FORMAT=ESM` and `CJS`:

```powershell
node --test .\capture-disposal.mjs
node --test .\retry-contracts.mjs
node --test .\adversarial\suite.mjs
```

Run `node .\references.cjs <format> <forest>` and `node .\proof.cjs <format> <forest>` for all combinations of `ESM`/`CJS` and `Reference`/`Optimized`. Public types were checked using the existing source TypeScript:

```powershell
node ..\r7-source\packages\dds\tree\node_modules\typescript\bin\tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 .\api-proof.mts .\api-proof.cts
```

The fresh provenance checker is `r7-m4-evidence\verify.ps1`. Its manifest records module paths/hashes, source commit and patch, archive pin, structured test outcomes, baseline failures and preservation comparisons. It confirms:

- All 3,288 installed package files byte-match a fresh extraction of the pinned archive. All 3,287 non-manifest files, including 3,197 production files, also match the committed source/validated build.
- 12,330 protected r5/r6 files and their source HEADs are unchanged.
- All four original r7 delivery files are byte-for-byte unchanged.
- The independently copied wrapper's 46 files match the immutable r2 wrapper.
- The source worktree is clean and the cumulative patch reverse-applies to the delivered commit.

No install/restore, shared-store modification, service, browser, auth, Office build, native/OCS/AFR call, peer message or push was performed for this follow-up. The original r7 consumer and all parent bridge/client/harness files were left alone.

## Unchanged limits

Authority original-context history and the existing wire deduplication ledger remain unbounded; the new public receipt bound is not a total retention bound. There is no durable receipt reopening, restart recovery or service-retention proof. Mock reconnect keeps missed messages without proving production retention guarantees. Fatal incoming protocol/runtime failure recovery remains outside this contract.

Capture references remain opt-in, schema-field-free, process-local and capture-lifetime-bound. Correction-draft-born node to eventual-live correspondence, durable global identity and full older detach parity remain unsupported. Required-field temporary vacancy, mixed hydrated/fresh insertion and fresh-parent cases retain their existing restrictions.

The parent's r5 AFR results remain r5 evidence and are not attributed to this package. No OCS/native correctness or hosted deployment claim is made here.
