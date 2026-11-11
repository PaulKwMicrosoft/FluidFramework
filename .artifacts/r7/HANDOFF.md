# r7 public authority publication retries

## Delivery pins

Base directory: `C:\office\FluidFramework-sharedtree-bridge\.artifacts`.

| Item | Pin |
| --- | --- |
| Source commit | `69604b14fb00180252bfa04e6f28c9d2d980103b` |
| Parent / incremental patch base | `ae2ecd6572c1bc46b7a3cd6207106d5ecc5ff1e0` |
| Local worktree | `r7-source` |
| Local branch | `user/paulkw/sharedtree-publication-retries` |
| Package | `r7\fluidframework-tree-2.111.0.tgz` |
| Package SHA256 | `F8F4E58F5BC67AFBFA7E0D9B4D9851833B989698547E82AC423411FC9FA1DECE` |
| Patch | `r7\sharedtree-source.patch` |
| Patch SHA256 | `5BDA42FFA2B3E11ED0DA0B9FB429209801D53C1C575912AEB6557056AA467C98` |
| Provenance | `r7\verification.json` |
| Provenance SHA256 | `58FFB0BD93B6E909488B33AB5338842C1B0CC1F822E0542ED14909084409621D` |
| Unchanged r2 wrapper SHA256 | `2A0942EE89B05FB58F9E03EE40B7852C73A11DCE4C6A7F459556D8CD2218D16F` |

Version remains `2.111.0`; the archive hash is the experimental pin. There is no
new package dependency, public API signature, envelope version or DDS name.
Combined DDS remains
`https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2`.
No in-place v1 migration or mixed-version deployment is asserted.

Only a local topic commit was made, with both required trailers. No push,
service/auth/browser operation, Office build, or bridge/client/native/harness-r5
edit was made. Parent owns private backup and adoption.

## Fixed contract

The existing API is used unchanged:

```ts
const first = authority.publishAdvance(publication);
const concurrentRetry = authority.publishAdvance({ ...publication });
const results = await Promise.all([first, concurrentRetry]);
const afterEcho = await authority.publishAdvance(publication);
```

* Before the local sequenced echo, identical calls share one underlying send and
  complete with the same outcome. This does not promise JavaScript Promise
  object identity: the public methods are async.
* After an applied local echo, identical retry returns `duplicate`; stale stays
  `stale`. The synchronous sequenced ledger is consulted even before Promise
  callbacks have run or after a later checkpoint has advanced.
* Retries do not send an additional authority message. They are not sequencing
  barriers and do not flush/acknowledge unrelated L.
* Identity is batch ID plus the original owned capture, normalized prefix count
  (omitted means zero), next checkpoint, and original owned draft/head.
  A different capture or equivalent freshly authored draft is not a retry.
* Changed inputs, changed committed draft heads and unfinished draft transactions
  reject without breaking the live kernel or disturbing its first publication.
* Sealed original drafts are admitted for exact retries, not for a new batch.
  There is no JSON equality test, snapshot reconstruction, new cut substitution
  or reminting of correction revisions.

F1 is fixed at both the public controller and core send boundary. F2 is fixed
through the original publication record, before the ordinary "unpublished draft"
validation path.

## Receipt ownership and lifetime

Controllers are canonicalized by **kernel**, not ITree facade object. The test
suite uses two public ITree facades over the same kernel and verifies one
controller/submission. The core method independently protects identical pending
sends and changed-payload rejection, so bypassing the controller memo does not
reintroduce F1's fatal assertion.

Public retry records are limited to **128 per kernel**. A completed capture's
disposal releases its records. If disposed before completion, its submitted send
continues, and the record is released when its Promise completion is processed.
The core separately admits at most **128 in-flight sends**. Limit failures occur
before sealing a new public draft. No eviction silently permits batch reuse.

Public retries require the original capture and correction draft to remain
undisposed. Capture disposal expires this retry scope but does not cancel
already submitted work. A disposed draft also makes public retry invalid.
Previously sequenced IDs remain reserved by the existing wire ledger even after
the public receipt is released; they cannot be adopted using a new capture.

These are receipt-entry bounds, **not** a total memory bound. Retained captures,
forests, authority history, original sequencing contexts and wire fingerprints
have their existing retention costs. Authority mode still bypasses history
trimming; local retention does not extend service log retention.

There is no durable receipt, encoded reopening API, process restart recovery,
service-expiry recovery or original-cut recreation.

## Source review notes

All code paths are relative to `r7-source\packages\dds\tree\src`.

| Source | Change / invariant |
| --- | --- |
| `shared-tree\externalAuthorityController.ts`, `Controller.publishAdvance` | Reads caller properties once. Records exact owners/head before submission, so synchronous reentrant calls see the same operation. Exact retries bypass the sealed-draft first-publication rejection. Broken kernels cannot serve memoized successes. |
| Same file, `getSharedTreeAuthority` | Weak map keys are underlying kernels; supported facade access does not create competing per-object caches. |
| Same file, capture disposal / completion handlers | Bounded public record retention. Disposing an unresolved capture does not discard the send or claim it failed remotely. |
| `shared-tree-core\sharedTreeCore.ts`, `publishExternalAuthority` | Read-only preflight and same-ID encoded fingerprint comparison use `@throwIfBroken`, not the fatal `@breakingClass` wrapper. Identical pending core calls reuse the same receipt. |
| Same file, `submitExternalAuthorityAdvance` | Actual submission remains behind the fatal breaking boundary. Its error is propagated to all waiting receipts; the catch only fans out the original failure and never clears/resets the breaker or produces success. |
| Same file, `processMessagesCore` | Only a local echo completes a pending local send. An identical peer batch is insufficient; this is independently exercised. Incoming invalid-wire assertions remain fatal. |
| `shared-tree-core\editManager.ts` | Adds read-only access to the existing sequenced batch fingerprint/outcome. No history, rebase, ancestry, deduplication or trim algorithm changed. |
| `shared-tree\sharedTree.ts` | Checkout disposal notification rejects pending core receipts. |

The frozen r6 reference implementation was not audited or changed here; its
existing tests were rerun as regressions.

### Failure boundaries

Real submission errors still permanently break that kernel and reject its
waiting receipts with the original error. Source tests inject a failure with
another batch already pending, assert both failures, and assert subsequent
public use remains broken. No production breaker is cleared.

Healthy checkout disposal rejects pending receipts. The pre-existing API may
refuse to dispose an already fatally broken checkout. Such a fixture/instance
must be abandoned; this implementation is not broken-kernel recovery.
Fatal incoming protocol errors remain fatal rather than being caught and
reclassified. No new receipt-liveness guarantee is made after such a fatal
delivery failure or loss of the runtime; uncertain external work still requires
reconciliation, not a success/failure inference from local teardown.

## Executed evidence

| Layer | ESM | CJS |
| --- | --- | --- |
| Source: 20 new retry cases + 83 r6 authority/atomic/detach/reference regressions | 103 passed | 103 passed |
| Actual packed positive public retry contracts | 12 passed | 12 passed |
| Adapted legal adversarial wire/reconnect/MSN scenarios | 18 passed, 2 historical repros skipped | 18 passed, 2 historical repros skipped |
| Packed reference/atomic traces, both forest kinds | 4 completed | 4 completed |
| Public `.mts` / `.cts` declarations through existing wrapper | Passed | Passed |

Targeted type-aware ESLint also passes. The 20 source cases include in-flight
and before-callback post-echo retries, changed inputs, stale results, later P,
genuine L and detached identity, facade/kernel routes, peer-before-self echo,
post-seal edits/transactions, aborted preparation, synchronous reentrancy,
real submit failure, later checkpoint advancement, disposal and receipt limits.

The adapted audit's 18 executed cases comprise 13 supported scenarios, four
intentional invalid-wire rejections, and one unsupported-summary boundary.
They are not 18 positive production guarantees. Its two original r5 defect
repros are deliberately skipped: F1's old expectation of rejection is obsolete.
The separate new positive contracts prove F1/F2 against r7.

Only generic ordering/runtime mocks are imported from the r7 source dependency
tree. Packed tests import the actual installed tarball and check wrapper/Tree
identity. All results remain **local mock ordering**, not AFR, hosted OCS,
native conversion or real server retention/restart evidence.

The package has 3,288 inventoried files; all non-manifest files match the
validated source/build byte-for-byte, including **3,197 production files**.
pnpm rewrites the publishing manifest. All **46 wrapper files** match r2.
All **12,330 protected r5/r6 source/build/artifact files** in the pre-work ledger
still match, and both protected source HEADs are unchanged.

`r7-evidence\candidate-1` preserves the earlier C762... candidate and its results;
only the F8F4... pin above is final. This does not overwrite any r5/r6 evidence.

## Reproduction

Paths are under the base directory given above. Existing real Node is
`C:\Program Files\nodejs\node.exe` (24.16.0), TypeScript 5.4.5, pnpm 11.9.0.
No dependencies were installed/restored. No broad source suite was run.

Targeted builds and source cases:

```powershell
$b = 'C:\office\FluidFramework-sharedtree-bridge\.artifacts'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
Set-Location "$b\r7-source\packages\dds\tree"
node .\node_modules\typescript\bin\tsc --project .\tsconfig.json
node .\node_modules\typescript\bin\tsc --project .\src\test\tsconfig.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\tsconfig.cjs.json
node .\node_modules\@fluidframework\build-tools\bin\fluid-tsc commonjs --project .\src\test\tsconfig.cjs.json
$env:NODE_PATH = @(
    "$b\r7-source\node_modules\.pnpm\mocha@11.7.5\node_modules\mocha\node_modules",
    "$b\r7-source\node_modules\.pnpm\mocha@11.7.5\node_modules",
    "$b\r7-source\node_modules\.pnpm\node_modules"
) -join ';'
$env:FLUID_TEST_MODULE_SYSTEM = 'ESM' # Repeat with CJS.
node .\node_modules\mocha\bin\mocha.js --grep '^authority publication retries|^capture node references|^atomic authority settlement|^external authority|^detached reinsertion'
```

Packed public contracts, audit adaptation and declaration fixtures:

```powershell
Set-Location "$b\r7-consumer"
$env:ADVERSARIAL_FORMAT = 'ESM' # Repeat with CJS.
node --test .\retry-contracts.mjs
node --test .\adversarial\suite.mjs
node .\references.cjs ESM Reference
node .\proof.cjs ESM Reference
# Repeat the traces with CJS and Optimized.
node ..\r7-source\packages\dds\tree\node_modules\typescript\bin\tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 .\api-proof.mts .\api-proof.cts
```

Final logs and provenance checker are in `r7-evidence`. Packed structured results
are in `r7-consumer\artifacts`; `verification.json` embeds their results and pins.
The original `harness-r5\adversarial` inputs and evidence were only read/copied,
never edited or rerun in place.
