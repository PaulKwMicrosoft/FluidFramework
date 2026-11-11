# Stable SharedTree checkpoint and API handoff

## r5: atomic accepted-prefix settlement plus authoritative correction

**New implementation checkpoint:** r5 is committed and separately packaged.
It supports a correction authored on a precise captured approved prefix, not
arbitrary subset acceptance or replacement of accepted revisions.

```ts
const capture = authority.capture();
const k = capture.editIds.length; // Or an explicitly accepted leading prefix.
const draft = authority.createDraft(capture, { afterPrefix: k });
const view = draft.viewWith(configuration);
// Apply typed authoritative corrections to this actual A + captured prefix.
const outcome = await authority.publishAdvance({
    batchId,
    nextCheckpoint,
    capture,
    approvePrefix: k,
    draft,
});
```

The draft base is **B = captured A + exactly P[0:k]**, not the live tree or a
JSON reconstruction. It excludes later captured P, newly arriving P and all L.
The publication must use the same capture object and prefix count. On delivery,
new A is B followed by fresh correction commits C. Accepted revisions remain
ancestors; only the remaining P suffix rebases over C, then L rebases over the
new sequenced history. Original Fluid authoring contexts stay immutable.
No obligation is discarded because snapshots happen to match.

`createDraft(capture)` remains A-based. Existing draft-only and pure-prefix
publications are preserved; combining an A-only draft with a positive prefix
still fails. Undo remains ordinary selective SharedTree undo, **not** grouped
undo of an original action plus its authoritative normalization.

| r5 pin | Exact value |
| --- | --- |
| Local branch | `user/paulkw/sharedtree-atomic-settlement` |
| Source commit | `834f2552c7baa214e82b2d9ddbed559d60293009` |
| Incremental patch baseline | `5ffbb9717d4d408f86593338009bb539f3739d18` |
| `r5\fluidframework-tree-2.111.0.tgz` SHA256 | `2EC514151BB1A314EFE8C7020FC1E20F9D7815F6BC7D6BC2908ADBCC4936BA20` |
| `r5\sharedtree-source.patch` SHA256 | `6A7EB231C192956785057AF64AF3B449B6B6F5D866972C0CCC4F1F7F512BB806` |
| `r5\verification.json` SHA256 | `1F9946B214481685927BB415FEA19B47996A46DCB54877538C41BEA199C09303` |

The patch is incremental against the exact private backup baseline above, not
a complete patch against the public release. The backup branch still points
at that baseline. This source commit is local only; parent owns private backup.
Exact metadata, results and limits are in `r5\verification.json`. Paths are
relative to this `.artifacts` directory.

### Cross-context node identity: not an established public r5 API

**No existing supported, schema-field-free API is established here for taking
a node from A, a correction draft, or live A+P+L and resolving its corresponding
logical node in another of those contexts.** The implementation preserves
identity through real history; that does not expose a general cross-branch
node-identity resolver to the native importer.

The existing draft API can materialize separate history-backed views:
`createDraft(capture)` for A,
`createDraft(capture, { afterPrefix: k })` for the accepted-prefix base B,
and `createDraft(capture, { afterPrefix: capture.editIds.length })` for captured
A+P. None includes L. This provides the correct editing bases, not a public
mapping between the wrappers in those views.

The supported API boundaries inspected in the pinned source are:

* `SharedTreeAuthorityCapture` exposes checkpoints, **edit** IDs and content
  exports, not node identities or a cross-context lookup
  (`src\shared-tree\externalAuthorityController.ts:28-34`).
* `TreeAlpha.context(node)` and deprecated `TreeAlpha.branch(node)` retrieve
  that node's own context; the implementation reads its own anchor-set view
  slot. They do not resolve a counterpart in another branch
  (`src\shared-tree\treeAlpha.ts:259-273,844-859`).
  `TreeBranch`/`TreeBranchAlpha` expose fork, merge, rebase, schema, transaction
  and change operations, not such a node-mapping method
  (`src\simple-tree\api\tree.ts:143-185,284-380`).
* `TreeAlpha.identifier(node)` requires an explicit
  `SchemaFactory.identifier` field; `Tree.shortId(node)` likewise returns
  undefined without one. Short IDs are not portable identities.
  `createIdentifierIndex` discovers those identifier fields rather than
  exposing hidden history identities
  (`src\shared-tree\treeAlpha.ts:143-200`,
  `src\simple-tree\api\treeNodeApi.ts:203-220`,
  `src\simple-tree\api\identifierIndex.ts:33-51`).
* `createArrayInsertionAnchor` tracks an insertion position in its original
  array, not a node across branches or lifecycles
  (`src\simple-tree\node-kinds\array\arrayNode.ts:1483-1538`).

Given the parent's chiudean schema boundary -- numeric native slide/nonVisual
IDs, no SharedTree identifier fields and no native shape-creation UUID -- none
of these APIs establishes the required general correspondence. Initial,
proven native UUID metadata is useful provenance, but matching numeric IDs,
paths, or `exportApproved()`/`exportSequenced()` JSON is not lifecycle identity
and must not turn a sidecar into a claimed durable identity mapping.

The r5 evidence preserves each client's retained object within that client's
checkout through correction/detach/reattach. It does **not** establish wrapper
equality across draft branches or clients, nor durable native identity through
delete/recreate or recovery. This is a handoff clarification only: the r5
source, package, verification manifest, test counts and chosen prefix-base
contract are unchanged. No client schema or parent adapter was modified.

### Mandatory r5 compatibility boundary

Authority envelopes and bootstrap metadata are **version 2**, with an explicit
stable `authoringBase` revision. The authority-only DDS type ends in
`/external-authority-v2`; the combined type is exactly:

`https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2`

**Use fresh containers. No in-place r2/r3/r4 authority migration is provided.**
Parent-owned guards expecting the v1 suffix must deliberately recognize v2 for
an isolated r5 adoption. Existing clients, associations and historical containers
were not changed.

Every participant needs the same tree artifact, matching nonempty authority
labels, and the same factory configuration:

```ts
configuredSharedTreeAlpha({
    minVersionForCollab: "2.80.0",
    externalAuthority: { documentEpoch, authorityId, authorityEpoch },
    enableDetachedRootEditing: true,
});
```

The unchanged r2 `fluid-framework` companion is compatible: all 46 copied wrapper
files byte-match its immutable archive; typed imports and direct/wrapper runtime
identity pass in both formats. No new wrapper package is needed. Public factory
kind opacity is unchanged: guard `getFactory()` rather than assuming it in
public TypeScript. Actual r5 Tree export paths are
`lib\entrypoints\alpha.js` and `dist\entrypoints\alpha.js`, as recorded in its
manifest; do not infer them from historical artifact paths.

### r5 evidence and reproduction

**53 source cases per format: 19 atomic + 16 detach + 18 authority.** Both CJS
and ESM pass. Coverage includes later P/L, old authoring references, concurrent
and mixed-runtime-batch edits, no-net obligations, removed-root retention,
correction detach/edit/reattach, undo/redo ancestry, stale/duplicate delivery,
reconnect, pre-attach context changes and fail-closed invalid contexts.
Both production/test compilers, targeted type-aware lint, formatting and
generated API report passed. No broad regression suite was rerun.

Packed CJS and ESM each additionally run a three-client local ordering scenario:
accepted-prefix normalization while later P and detached local L survive,
followed by a correction that itself removes, edits and reattaches the same
logical node. Every client keeps its original object; final A=S with zero P.
All 3,188 packaged production files byte-match the validated source/build
(378 source, 1,405 ESM and 1,405 CJS). These are **local mock-ordering proofs,
not AFR or OCS**. The independent `r5-consumer` reused copied dependencies without
an install or shared-cache modification; it does not import a source Tree.

Source commands, from `detach-port\packages\dds\tree`, with the installed
`C:\Program Files\nodejs\node.exe` on PATH:

```powershell
node .\node_modules\typescript\bin\tsc --project .\tsconfig.json
node .\node_modules\typescript\bin\tsc --project .\src\test\tsconfig.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\tsconfig.cjs.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\src\test\tsconfig.cjs.json

$base = 'C:\office\FluidFramework-sharedtree-bridge\.artifacts\detach-port'
$env:NODE_PATH = "$base\node_modules\.pnpm\mocha@11.7.5\node_modules\mocha\node_modules;$base\node_modules\.pnpm\mocha@11.7.5\node_modules;$base\node_modules\.pnpm\node_modules"
$env:FLUID_TEST_MODULE_SYSTEM = 'ESM' # Repeat with CJS.
node .\node_modules\mocha\bin\mocha.js --grep '^atomic authority settlement|^external authority|^detached reinsertion'
```

Packed commands, from `r5-consumer`, using that same Node executable:

```powershell
node .\proof.cjs ESM
node .\proof.cjs CJS
node ..\detach-port\packages\dds\tree\node_modules\typescript\bin\tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 .\api-proof.mts .\api-proof.cts
```

Runtime authority summaries, bounded retention, durable original cuts,
historical receipt queries and encoded recovery remain unsupported. Required
field vacancy/reinsertion, mixed fresh/detached insertion and removed children
inside new parents remain outside the existing detach port. All writers remain
trusted. If external OCS acceptance has already completed, a stale publication
requires reconciliation rather than blind recapture/re-authoring.

No parent-owned bridge/client/harness/native code, service, ordering service or
public remote was changed. No r5 AFR or hosted OCS integration is claimed.

---

## Historical r2/r3/r4 handoff

**The following is preserved historical evidence and v1 API guidance, not an
r5 capability or wire-contract claim.** Its earlier "final checkpoint" and
scope-freeze statements describe that earlier work period.

**Final bounded Fluid checkpoint:** immutable r4 delivers sequence/optional
removed-root detach, detached editing and identity-preserving reinsertion.
Supplementary hardening is complete: 16 detach plus 18 authority cases pass in
both CJS and ESM; lint and formatting pass. Production source still matches r4.
The removed-child-in-new-parent stretch and required-field policy are not
implemented. No further large extension or package rebuild was started.

## Keep the two integration checkpoints separate

**Parent's ordinary installed client and historical containers retain immutable
r2.** Separate isolated r4 harnesses now also have real AFR, actual chiudean,
coordinator and fresh-process provisional-history evidence, recorded below.
Do not replace the ordinary installation or reinterpret historical containers.
The browser bundling investigation remains parent-owned.

| Artifact | Role | SHA256 |
| --- | --- | --- |
| `r2\fluidframework-tree-2.111.0.tgz` | Authority-only package already exercised over real AFR by parent | `B018B9E461E39E90006C8554C6C2A16D168FA17715E61E8D29C958FF188C6D33` |
| `r3\fluidframework-tree-2.111.0.tgz` | Authority-only package adding persisted bootstrap-label guards and nonempty configuration validation; not a migration for r2 documents | `921546E57F9F611F374226FF097FED95563BADC1FE92C2476A5823EACFAFABDD` |
| `r2\fluid-framework-2.111.0.tgz` | Regenerated wrapper declarations; compatible with r2, r3 and r4 | `2A0942EE89B05FB58F9E03EE40B7852C73A11DCE4C6A7F459556D8CD2218D16F` |
| `r4\fluidframework-tree-2.111.0.tgz` | Separately validated authority plus optional high-level Detach/Attach | `A3B17F0D75738D37D8D00C366620D9FFE86CABBA2C6C73336D56A84B1208C179` |
| `r4\sharedtree-source.patch` | Complete r4 tree-package source changes against the release base below | `0427441694BDC6F93813B3869F1B9D8753724175D960A58E0B948E9ED9F351D5` |

Paths above are relative to `C:\office\FluidFramework-sharedtree-bridge\.artifacts`.
All packages retain version `2.111.0`; use exact artifacts/hashes, not the version
string alone. Both package formats passed a packed-consumer check with the same
r2 wrapper and one globally resolved tree package. `TextAsTree` remains available.

Release source base: `7c3fc51d5d204a16299014921e93d522590a4af2`.
The public detached-root foundation ported for r4 is
`1b49fc989e3d844cb7fc7c50d3df59d27c5ac702`, with deliberate 2.111 adaptations.
It is not the exact older `2.74.0-370705` experimental package.

### Exact older-artifact provenance and port boundary

The comparison artifact is
`C:\Users\paulkw\.copilot\session-state\d3201c76-9209-4b3b-9930-7f868ad240f4\files\fluid-build-inspection\package`,
whose manifest declares `2.74.0-370705`. Its archive SHA1 is
`938df65cbcfa85cc1672c511674a1e148fdcada6`, matching the previously established
GC2 lockfile baseline. Its full Fluid monorepo source commit remains unidentified.

Within that exact artifact, the higher-level reference points are:

* `src\feature-libraries\default-schema\defaultEditBuilder.ts:358-399`:
  optional attachment, including rename-before-attach for previously attached nodes.
* The same file at `523-630`: corresponding sequence attachment and identity ranges.
* `src\simple-tree\prepareForInsertion.ts:65-96,128-145`: actual hydrated removed-node
  reinsertion, with mixed fresh/hydrated array content explicitly forbidden.
* `defaultEditBuilder.ts:310-319`: previously attached nodes are explicitly rejected
  for required-field reinsertion even by that older build.

r4 ports the compatible public lower-level foundation onto 2.111 and implements
the removed-root array/optional path against current 2.111 editors/hydration,
following that exact artifact's rename-before-attach approach. It does not
silently downgrade the frontend or claim to reproduce the entire older build.
The focused tests actually remove a hydrated node, edit it while removed, and
reinsert that same node, asserting independent-client object identity. These
are not merely move/undo tests.

The main worktree remains the verified authority-only implementation.
The combined implementation is in
`C:\office\FluidFramework-sharedtree-bridge\.artifacts\detach-port`.
The r4 source patch is the immutable checkpoint; later supplementary test edits
in that worktree do not change the r4 artifact.

## Exact factory/API pairing

Import these from patched `@fluidframework/tree/alpha`, or from
`fluid-framework/alpha` with a single tree resolution:

The unchanged wrapper already forwards the new controller **at runtime** through
its existing tree re-export. Parent independently verified ESM and actual-client
CJS helper identity. No second package patch is needed merely for runtime access.
The companion r2 wrapper supplies **regenerated declarations** for typed imports
of the new controller APIs; it is not a new runtime forwarding implementation.

```ts
configuredSharedTreeAlpha({
    minVersionForCollab: "2.80.0",
    externalAuthority: {
        documentEpoch,
        authorityId,
        authorityEpoch,
    },
    // r4 only; every participant must use the same setting:
    enableDetachedRootEditing: true,
});

getSharedTreeAuthority(tree);
```

The factory's public return type is deliberately opaque `SharedObjectKind<ITree>`.
Do not assume `getFactory()` is available in that public TypeScript type. The
parent's explicit runtime capability/type guard is appropriate.

Actual DDS types:

* Authority-only:
  `https://graph.microsoft.com/types/tree/external-authority-v1`
* r4 combined:
  `https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v1`

Use a **fresh experimental container** for combined mode. r3/r4 additionally
require bootstrap authority-label metadata which r2 did not write; do not
reinterpret an existing r2 association. Initial attach summaries are supported.
Later runtime authority summaries remain unsupported. The parent's test-only
runtime summaries-off setting is still required for bounded relay experiments.

**Guard evidence must be paired with the artifact.** r2 intentionally predates
bootstrap metadata write/load validation and factory-side nonempty identity-label
validation. Matching controller declarations do not imply matching guards, and
bridge tests aliased to current compiled source do not establish those guards in
r2. The r3 archive contains these guards: its `sharedTreeCore.js`, `treeFactory.js`
and `externalAuthority.js` byte-match current compiled main-workspace source in
both `lib` and `dist`. r4 also includes bootstrap guarding, with the additional
detached-root implementation kept separate.

The actual authority controller surface is unchanged between these artifacts:

```ts
interface SharedTreeAuthorityController {
    capture(): SharedTreeAuthorityCapture;
    createDraft(capture: SharedTreeAuthorityCapture): SharedTreeAuthorityDraft;
    publishAdvance(publication: SharedTreeAuthorityPublication):
        Promise<"applied" | "duplicate" | "stale">;
    onStateChanged(listener: () => void): () => void;
}

interface SharedTreeAuthorityCapture {
    readonly checkpoint: string;
    readonly editIds: readonly string[];
    exportApproved(): VerboseTree | undefined;
    exportSequenced(): VerboseTree | undefined;
    dispose(): void;
}

interface SharedTreeAuthorityDraft {
    viewWith<TRoot extends ImplicitFieldSchema>(
        configuration: TreeViewConfiguration<TRoot>
    ): TreeView<TRoot>;
    dispose(): void;
}

interface SharedTreeAuthorityPublication {
    readonly batchId: string;
    readonly nextCheckpoint: string;
    readonly capture: SharedTreeAuthorityCapture;
    readonly approvePrefix?: number;
    readonly draft?: SharedTreeAuthorityDraft;
}
```

These are implemented exports, not proposed names. Their source is
`packages\dds\tree\src\shared-tree\externalAuthorityController.ts`.

## Checkpoint and publication semantics

* A bootstrap starts at checkpoint `"initial"`. Pre-attach seed content is A,
  not P.
* `capture.checkpoint` identifies approved history A, **not a unique A+P cut**.
  More P can arrive without changing that string.
* The capture object contains immutable A and A+P materializations.
  `editIds` identifies its P commits with stable decompressed revision identities.
  Neither export includes local unsequenced L.
* Publish an unchanged prefix using `approvePrefix`. Publish an externally
  authored change using a draft created from that capture's A.
  Positive prefix approval plus a draft is rejected: it is not a transformed
  settlement operation.
* `nextCheckpoint` is a distinct caller-supplied approved-history label.
  There is no separate SharedTree `externalRevision` API. Any mapping to an
  external service revision belongs to the bridge.
* The expected checkpoint comes from the capture automatically.
  Additional P after capture does not silently expand its approval prefix.
* Local publication does not update A or live checkout early. The outcome Promise
  resolves through ordinary sequenced self-echo. State notifications require
  rereading the controller; they are not durable receipts.
* Keep the original capture alive through publication. Drafts seal on publication.
  Disposal is not cancellation of a previously submitted Fluid message.
* All clients, including future native clients, still join via ordinary Fluid
  ordering. This is not a Polaris-private native ordering API.

## Bridge recovery boundary

There is **no** exported serialized `prepareAdvance`, durable cut `reopen`, or
receipt-query operation. Captures are controller-owned WeakMap capabilities.
Checkpoint strings, edit ID arrays, and exported trees cannot reconstruct one
after a process restart.

The valid initial bridge adapter is process-lifetime and must preserve its original
live controller, capture, and in-flight publication Promise. Same-process handoff
must transfer that binding, not create a new capture. Fluid owns transport
retransmission. An adapter may cache a receipt actually observed from the Promise;
it must not invent one or blind-republish an ambiguous authority request.
Fresh-process recovery of unresolved bridge attempts remains explicitly
reconcile-required. This is distinct from reconstructing an already settled
document by replaying retained Fluid operations.

### Parent's independent settled-document replay proof

Using r2 and the actual chiudean transport/schema, the creator process disposed
all clients and exited. A separate `node.exe` then loaded the same document and
labels and matched checkpoint `15942101-b7a6-4355-a29f-f236fc3f04c7`, both complete
approved/sequenced verbose snapshots, and empty P. Summaries were disabled.

Evidence under `C:\office\ppt-sharedtree-bridge\harness\artifacts`:

* Creation: `chiudean-afr-54dbc8d1-338a-47d0-82f0-84b001b6d1df.json`
* Separate-process reload: `chiudean-afr-b5eb04b3-db40-464f-8da0-bc6dc208e4ee.json`

This proves the bounded initial-attachment-summary plus retained-op replay path,
not runtime authority summaries, unsequenced local pending-state recovery, exact capture reopening,
or recovery of the bridge's journal/publication obligations.

## Proven scope and precise remaining limits

r4 release validation: **734 ESM tests pass**, **8 pre-existing pending**;
**29 authority/Detach tests pass in CJS**. Compilation, generated current API
report, targeted lint, and packed-consumer ESM/CJS/types/deduplication pass.
See `r4\verification.json` and `detach-authority-*.log`.

Independent-client traces cover same-checkout removed-root reinsertion through
array/optional APIs, removed-node edits, concurrent reattachments and edits,
identity, combined A/P/L rebasing, prefix approval, undo, and bootstrap load.
The r4 package itself has not been run over AFR by this agent. Parent subsequently
reported an independent **real-AFR r4 run on four clients**:

`C:\office\ppt-sharedtree-bridge\harness-r4\artifacts\detach-afr-6dec4d99-fc97-4607-9376-f280478615bb.json`

The parent's script is `harness-r4\src\detach-afr.mjs`. Reported stages cover real
sequence removal, detached mutation visible through a peer's retained node,
independent Presence preview/cancel, an external draft beneath detached P,
optional reinsertion preserving each client's object identity, captured-prefix
approval retaining a later peer edit, optional detach/edit/array reattachment
inside a transaction, approval followed by identity-preserving undo/redo, and a
fourth reader's final approved/sequenced snapshots. Parent verified package/source
hashes and kept r2 and the client unchanged.

This is parent-owned live integration evidence, separate from this agent's
supplementary CJS/ESM component runs. It does not establish runtime authority
summaries or durable capture/publication recovery. Actual chiudean opt-in/schema
integration remains parent-owned; no duplicate harness work was performed here.

### Subsequent parent integration checkpoints

The parent separately exercised real chiudean `Presentation` classes and the
actual opt-in factory over AFR. The original Slide was removed, edited while
detached and reinserted; an optional SolidFill background was likewise detached,
RGB-edited and reinserted. Per-client identities and provisional edit obligations
were preserved. Initial evidence:
`harness\artifacts\chiudean-afr-9d4a5687-76e0-42f4-af34-7a52c9980e75.json`.

The following parent-owned evidence files were subsequently read during this
handoff update, under `C:\office\ppt-sharedtree-bridge`:

* `harness\artifacts\coordinator-afr-34deb358-0ff3-41a3-90c4-3f448979819c\result.json`
  reports `passed` with the exact r4 hash and combined DDS type. It covers a real
  optional-node detach/edit/reattach transaction, the actual coordinator,
  FileAttemptJournal and live controller over AFR, self-echo-only prefix approval,
  original-cut same-process handoff, retained later P and a fresh fourth reader.
  It records one capture, conversion, simulated OCS submission and publication.
  Its fixture is not the chiudean schema, `actualNativeFixture` is false, and
  `ocsPublicationReady` is false.
* `harness\artifacts\chiudean-afr-cd59b4bb-6395-42d9-bfbf-e60368daff27.json`
  reports all ten real-schema authority/detach stages passing, including
  old-context offline work, Slide reinsertion and optional background reinsertion.
* `harness\artifacts\chiudean-afr-601f0895-b597-4d5b-9c40-fa43ce9a62ba.json`
  identifies the preceding source run and reports a fresh-process reload at
  checkpoint `5cf3edaf-092b-4ccc-b02b-6ce7de748ffc`, retaining all eight sequenced
  provisional edit IDs. This establishes the bounded retained-op replay case
  with nonempty P, not recovery of unsequenced L.

Do not combine these separate proofs into a claim of one real chiudean/native/
OCS/coordinator/r4 pipeline. Native execution and OCS acceptance are explicitly
absent from the r4 coordinator fixture; the real-schema replay does not exercise
the coordinator. Runtime authority summaries, durable cut reopening, historical
receipt queries and unresolved-publication recovery remain unsupported.
Parent reports all its clients disposed and its normal client store unchanged on
r2. No agent-owned validation command remains running in this Fluid scope.

Still unsupported or unproved:

1. Required-field temporary vacancy and required-field reinsertion.
2. Reusing removed children inside newly constructed enclosing objects;
   mixed fresh/detached insertion content; full parity with the older build.
3. Transformed/coalesced/subset settlement and attribution/recovery for it.
4. Runtime summaries, bounded retention/GC, unsequenced L stash recovery and
   recovery of unresolved bridge publication obligations.
5. Serialized preparation, durable cut reopening and durable receipt lookup.
6. Cryptographic authority enforcement: labels fence trusted writers only.
7. Schema evolution/shared branches in authority mode.
8. Full native/OCS/PPTX/UI integration.

The authority history work reuses existing merge algebra. The Detach/Attach
foundation is substantive CRDT work inherited from its public branch, not a
small wrapper around deletion or JSON copying. The combined r4 source patch
contains 179 files, predominantly that lower-level foundation and its tests.

## Post-r4 bounded questions

Additional tests in the same worktree probe all four concurrent array/optional
reattachment target combinations, authority-aware redo after approval, preservation
of four no-net undo/redo submission obligations, and abort/commit of a
detach/edit/attach transaction. All **16 detached-reinsertion ESM tests pass**,
including the five added cases. No production source change was needed.
These supplementary tests are not retroactively claimed to be inside the
immutable r4 archive.

**Supplementary hardening is now complete:** all 16 detach cases and 18 authority
cases pass in **both CJS and ESM (34 per lane)**. Both test compilations,
type-aware ESLint (`--quiet`, as in the package's existing lint command), and
Biome check pass. All 378 non-test production source files were freshly
byte-compared with the immutable r4 archive and still match. No r4-blocking
production bug was found in these cases.

Evidence is in `post-r4-supplementary-verification.json` and
`post-r4-supplementary-*-final.log`. The exact test-only delta against
`r4\sharedtree-source.patch` is `post-r4-supplementary-tests.patch`
(SHA256 `3B2ADDD1056028E40056F6C08858A8D59C5A9DB3A1A35094D5497331E5065388`).
The immutable r4 package, source patch and original release verification were
not rewritten; the supplement records their exact hashes and compatibility.

Earlier stalled supplementary attempts are historical, not the final result.
The completed runs use the installed `fluid-tsc`/`tsc` directly without
build-graph scanning. A direct Mocha invocation initially lacked the pnpm
shim's `NODE_PATH`; reproducing that existing shim environment resolves its
CJS package self-reference. Biome corrected one test import's formatting.
No dependency installation, production source change, or authority repackaging
was needed.

## Bounded required-field finding

An additional targeted two-client trace confirms the actual rule:

1. Both clients know the same removed root A.
2. Client 1 assigns A into a populated optional field, displacing O.
3. Concurrently, client 2 inserts A into an array.
4. After sequencing/rebase, the array contains A and the optional field is empty.

This is legitimate optional-field behavior, preserves A's identity, and passes
in `required-field-boundary-test.log`. It is not a test of an unsupported
required-field insertion.

However, `src\feature-libraries\optional-field\requiredField.ts:38-50` implements
required-field editing by `optionalFieldEditor.set(false, ids)` and reuses
`optionalChangeHandler`. Merely removing the high-level required-field guard is
therefore not a justified implementation: the existing competing-reattachment
rule can empty a destination.

A possible **new, unimplemented** API would be an atomic required-field
replacement group, accepting source node identities and destination parent/key
pairs, with a defined conflict outcome. It must ensure every required field
vacated by the group remains populated. Crucially, grouping the initial
replacement is insufficient: later ordinary reattachments rebased over that
placement must also preserve required-field multiplicity or fail the conflicting
operation coherently. Silently making the schema optional is not a solution.

This does not establish impossibility. It identifies a concrete merge-policy
decision and the counterexample that any required-field implementation must pass.
Authority history rearrangement is already tested; this remaining required-field
work reaches into the detached-node conflict rules rather than just API plumbing.

## Bridge-owner sub-integration milestone

The bridge owner reports a passing concrete live-only adapter at
`C:\office\ppt-sharedtree-bridge\bridge\integration\liveSharedTreeAuthority.ts`.
It uses the actual exported controller/capture/draft types without casts,
actual modified SharedTree with `TestTreeProviderLite`, the real coordinator,
and `FileAttemptJournal`. Native/OCS implementations in this test lane are
explicitly test-only doubles; this is not live native/OCS or relay integration.

Reported validation: seven integration tests plus 58 component tests pass;
both strict typechecks pass. Commands from the bridge directory:
`yarn typecheck:sharedtree` and `yarn test:sharedtree`.

Covered boundaries include A+P excluding L, self-echo-only prefix settlement,
preserving later P/L, no-net metadata settlement, actual stale checkpoints,
retained-pin handoff and fail-closed lost publication/capture handles.
The adapter uses capture plus prefix without a draft, persists an explicitly
live handle, and declares `supportsExactPublicationReplay=false`.

The exact resolved runtime artifact/source path should accompany this evidence:
the main compiled Fluid worktree, immutable r2 and immutable r4 are distinct
checkpoints even though the authority API is shared. Durable preparation,
historical receipt lookup and original-cut reopening remain future seams.

### Subsequent real-native fixture loop

The bridge owner subsequently reports a passing loop from an actual SharedTree
captured x/y candidate through the actual native Open/Edit/Save/wire-export helper,
the coordinator/fsynced journal, and actual SharedTree sequenced self-echo.
Fluid ordering in this lane is still `TestTreeProviderLite`; OCS attribution is
still explicitly test-only.

The exported native result contains 35 parts, 14 contexts and five changed parts;
the target is exactly x=1905000/y=1428750 EMU and the second shape is preserved.
The owned worker exited. Evidence:
`C:\office\ppt-sharedtree-bridge\bridge\native-artifacts\latest-sharedtree-native-proof.json`.

Latest reported total is 72 tests: 64 standalone, seven real-SharedTree
integration tests, and one opt-in real-native/SharedTree test. This closes a
bounded fixture loop, not actual chiudean schema mapping, a general native host,
live OCS attribution, AFR integration of the loop, general Detach/Attach, or
durable recovery.
