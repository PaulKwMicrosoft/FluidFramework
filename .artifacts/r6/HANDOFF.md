# r6: capture-local node references

## Pins and isolation

All paths below are under `C:\office\FluidFramework-sharedtree-bridge\.artifacts`.

| Item | Exact pin |
| --- | --- |
| Source | `ae2ecd6572c1bc46b7a3cd6207106d5ecc5ff1e0` |
| Parent / patch base | `834f2552c7baa214e82b2d9ddbed559d60293009` |
| Worktree | `r6-source` |
| Local branch | `user/paulkw/sharedtree-capture-node-references` |
| Tree archive | `r6\fluidframework-tree-2.111.0.tgz` |
| Archive SHA256 | `F5F78A8748F73F51E5AF20A3E0C15BE9847D0A829847E91DC3ECF5F6B0745367` |
| Incremental patch | `r6\sharedtree-source.patch` |
| Patch SHA256 | `211F763B5FE4C43C66A65265ABD58E227E7EEF6811EF069ED7D2B670CD54B1D4` |
| Provenance manifest | `r6\verification.json` |
| Manifest SHA256 | `BB270148399AC6CA423D5C11214430F3029C0AF52BCE2DC1E4F0787B5B9A1ADF` |
| Existing companion wrapper | `r2\fluid-framework-2.111.0.tgz` |
| Wrapper SHA256 | `2A0942EE89B05FB58F9E03EE40B7852C73A11DCE4C6A7F459556D8CD2218D16F` |

The package still says `2.111.0`; its archive hash, not its version string,
identifies r6. No push was made. Parent owns private backup and adoption.
The r5 worktree remains at its original commit. All 6,155 files in the pre-work
r5 source/build/artifact ledger match byte-for-byte, as do the historical
r2/r3/r4/r5 archives. The r6 dependency tree and build outputs are independent
copies; no restore/install or installed client/harness mutation was performed.

## Minimum public API

```ts
const authority = getSharedTreeAuthority(tree);
const cut = authority.capture({
    trackNodeReferences: true,
    maxNodes: 10000, // optional default
    maxDrafts: 16,  // optional default
});
const approved = authority.createDraft(cut); // captured A
const a = approved.viewWith(configuration);
const prefix = authority.createDraft(cut, { afterPrefix: k });
const b = prefix.viewWith(configuration);   // captured A + P[0:k]

const source = cut.reference(a.root.someExistingNode);
if (source.kind === "tracked") {
    const counterpart = cut.resolve(source.reference, prefix);
    if (counterpart.kind === "node" && Tree.is(counterpart.node, ExpectedSchema)) {
        // This is b's counterpart. Edit it with normal typed tree operations.
    }
    const live = cut.resolve(source.reference, "live");
}
```

`someExistingNode`, `ExpectedSchema` and `configuration` are application-specific;
the API adds no identifier fields to that schema.

The return type is `SharedTreeAuthorityReferenceCapture`. New named types are
`SharedTreeAuthorityNodeReference`, `SharedTreeAuthorityNodeResolution`,
`SharedTreeAuthorityReferenceResult`, `SharedTreeAuthorityReferenceOptions`,
and `SharedTreeAuthorityReferenceCapture`, exported from
`@fluidframework/tree/alpha`. The unchanged r2 `fluid-framework/alpha` wrapper
supports the inferred new controller API and has the same runtime Tree identity,
but does not newly re-export those five type names. Import them directly from the
patched Tree package. Both `.mts` and `.cts` fixtures prove this combination.

Ordinary `capture()` retains its r5 shape: no `reference` or `resolve` methods.
Existing r5 publication semantics are unchanged:

```ts
await authority.publishAdvance({
    batchId, nextCheckpoint, capture: cut, approvePrefix: k, draft: prefix,
});
```

The accepted revisions remain in history; correction commits have fresh revision
identities. Later P and L rebase normally, and completion still requires sequenced
self-echo. This is not arbitrary subset settlement.

## Meaning and ownership

`reference(node)` accepts the controller's live nodes and nodes in active
unpublished drafts owned by this exact capture. It returns a tracked opaque
object or `outsideCapture`. The token domain is retained nodes in captured S,
including retained removed content. An L-born node is outside that old capture
even after acknowledgment. A later or correction-draft birth is outside too.

`resolve(token, "live" | draft)` requires an active compatible target view.
It returns the target view's node wrapper and `inDocument` / `removed` status,
`absent` for absence in the historical projection, or
`unavailable` / `destroyed` after physical destruction of an existing counterpart.
It never searches for a replacement with the same path, JSON or numeric ID.
`removed` does not authorize unsupported insertion of a non-root removed child.

Foreign/fabricated tokens, foreign source checkouts, wrong-capture draft targets,
disposed/sealed drafts, expired captures, missing target views, unfinished
transactions and transient change-event access fail explicitly. A sealed draft
cannot be a reference source either. Capture disposal releases the registry's
anchors and disposes its public reference-draft checkouts, but never live.

To relate old captured A, captured prefix and live, no existing schema identifier
is required. However, **correction-draft-born node -> eventual live correspondence
is not implemented**. It cannot be inferred from matching snapshots or numeric
native IDs. There is no serialization/reopen API for tokens, no durable global
identity, and no durable native UUID sidecar contract.

## Implementation invariants

* `core\tree\anchorSet.ts`: `trackForFork` validates/copies detached-root metadata,
  not context slots, wrappers or listeners. It acquires no anchor before a
  conflicting-metadata assertion.
* `shared-tree\treeCheckout.ts`: bounded eager enrollment and lock-protected
  anchor transfer before fork notification. Previously unhydrated removed roots
  get metadata from the actual `DetachedFieldIndex`.
* `shared-tree\authorityNodeReferences.ts`: capture-owned token/index maps,
  exact checkout ownership, target-wrapper hydration, and lifetime cleanup.
* `shared-tree\externalAuthorityController.ts`: opt-in overload and tracked
  draft construction. Captured S is projected from live by rollback of L.
  Every tracked A/prefix draft forks S directly, then rolls back the excluded
  suffix. It does not pass through A and recreate P-born nodes.

ObjectForest and ChunkedForest have different cursor details. Enrollment uses
actual detached-field coordinates plus already tracked parent anchors, not the
chunk cursor's synthetic-root path. Paths are used only at the verified clone
boundary; subsequent correspondence follows real anchor/delta history.

## Bounds and compatibility

Defaults: 10,000 stored nodes, 16 concurrently retained public reference drafts;
maximum enrollment depth 256. Nodes include leaves and retained removed trees.
Positive safe-integer node/draft overrides are accepted. Excess enrollment,
depth or draft count fails instead of truncating coverage.

Space is O(enrolled nodes * retained views), in addition to checkout snapshots
and history. Limits are enrollment/concurrency limits, not a cap on subsequent
live/draft growth or new ancestor paths. There is no implicit eviction.
Dispose captures/drafts when no longer needed and release application references
to them when their snapshots are no longer needed.

Wire protocol and DDS naming remain v2:
`https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2`.
All participants still need the combined detached-root option and matching
authority/document labels. r6 adds only process-local API/state, not a wire
field or new persisted format. Mixed r5/r6 deployment has not been exercised.
This does not authorize migration of v1, r4, ordinary or legacy detach containers.

Runtime summaries, durable original-cut recovery, bounded authority-history GC,
and full historical detach parity remain separate work. Required-field vacancy,
mixed fresh/detached insertion, and removed children supplied in fresh-parent
construction remain unsupported. Anchors alone do not retain destroyed repair
data; the existing authority prototype still disables history trimming.

## Executed evidence

30 new reference cases (15 per forest) plus 19 atomic, 16 detach and 18 authority
regressions: **83 ESM + 83 CJS passing**. These are local prototype ordering tests,
not AFR or OCS. Focused coverage includes:

| Gate | Source evidence, both forests |
| --- | --- |
| Real cross-context identity | Different wrappers, identical values/native IDs, A/prefix/S/live counterparts |
| Causal cut boundaries | P births absent before creation; L/later/draft births remain outside old capture |
| Removed lifecycle | Never-hydrated removed roots, metadata transfer, edit/reattach and cross-checkout rejection |
| No retargeting | Replacement/reordering/repeated detach; physical destruction gives unavailable |
| Concurrent history | Accepted-prefix correction, later P, peer correction while L remains unsequenced |
| Rollback ancestry | Existing child rescued from locally created parent; retained lifecycle undo/redo |
| Ownership/lifetime | Foreign/fabricated refs, wrong capture/checkout/view, sealed/disposed targets and sources |
| Atomicity/resources | Node/draft limits, excessive depth, reentrant access/disposal, fork locks and failed-observer cleanup |

An independently copied consumer executes the actual tarball, not source Tree
helpers: **8 packed three-client runs** (reference and atomic/detach scenarios,
each in ESM/CJS and ObjectForest/ChunkedForest). Only generic local transport mocks
come from r6 source dependencies. The packed traces additionally verify genuine
unsequenced L, original-node reinsertion and wrapper identity.

Public declaration fixtures and targeted type-aware ESLint pass. The initial
unfiltered root clean refused because unrelated packages are intentionally not
installed. Without installing them, the root build tool clean-rebuilt Tree's
complete installed dependency closure: **385 tasks succeeded**. This eliminated
unrelated API drift; only the intended alpha report additions are committed.
Entrypoint-source generation preceded the rebuild.

All **3,197 packaged production files** byte-match the validated source/build.
All 3,288 package files are inventoried; every non-manifest file matches the
source/build tree, while pnpm rewrites the publishing manifest. All 46 copied
wrapper files match r2. `verification.json` contains individual file hashes,
fixture/evidence hashes and the completed packed results.

## Reproduction locations and commands

`r6-evidence` retains source logs, the root rebuild log, packed results and
`verify.ps1`. `r6-consumer` retains `references.cjs`, `proof.cjs`,
`api-proof.mts`, `api-proof.cts` and its independent dependencies.

Use real Node `C:\Program Files\nodejs\node.exe` (24.16.0), not an Office wrapper.
The existing TypeScript is 5.4.5; pnpm is 11.9.0.

From `r6-source`, the offline clean dependency-closure build was:

```powershell
node .\node_modules\@fluidframework\build-tools\bin\fluid-build --rebuild --dep --task build:esnext --task build:commonjs --task build:api-reports '^@fluidframework/tree$'
```

The exact targeted compile and source-run commands are:

```powershell
$b = 'C:\office\FluidFramework-sharedtree-bridge\.artifacts'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
Set-Location "$b\r6-source\packages\dds\tree"
node .\node_modules\typescript\bin\tsc --project .\tsconfig.json
node .\node_modules\typescript\bin\tsc --project .\src\test\tsconfig.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\tsconfig.cjs.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\src\test\tsconfig.cjs.json
$env:NODE_PATH = @(
    "$b\r6-source\node_modules\.pnpm\mocha@11.7.5\node_modules\mocha\node_modules",
    "$b\r6-source\node_modules\.pnpm\mocha@11.7.5\node_modules",
    "$b\r6-source\node_modules\.pnpm\node_modules"
) -join ';'
$env:FLUID_TEST_MODULE_SYSTEM = 'ESM' # Repeat with CJS.
node .\node_modules\mocha\bin\mocha.js --grep '^capture node references|^atomic authority settlement|^external authority|^detached reinsertion'
```

From `r6-consumer`, each format/forest combination:

```powershell
node .\references.cjs ESM Reference
node .\proof.cjs ESM Reference
# Repeat with CJS and with Optimized.
node ..\r6-source\packages\dds\tree\node_modules\typescript\bin\tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 .\api-proof.mts .\api-proof.cts
```

No r6 native conversion, OCS submission, AFR, service, client-schema or private
push work was performed. Parent's separately reported r5 AFR run remains r5
evidence and is not relabeled as r6 proof.
