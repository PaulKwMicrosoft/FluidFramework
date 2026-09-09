# Restricted external-authority SharedTree prototype

This source-aligned prototype starts at Fluid 2.111.0 release commit
`7c3fc51d5d204a16299014921e93d522590a4af2`. It is **not** the user's
`2.74.0-370705` Detach/Attach build and does not yet port that build's new editing
primitives. Normal SharedTree mode retains its existing wire format and behavior.

## Opt in

```ts
import {
    configuredSharedTreeAlpha,
    getSharedTreeAuthority,
} from "@fluidframework/tree/alpha";

const AuthorityTree = configuredSharedTreeAlpha({
    minVersionForCollab: "2.80.0",
    externalAuthority: {
        documentEpoch: "document-incarnation",
        authorityId: "trusted-bridge",
        authorityEpoch: "authority-incarnation",
    },
});
```

All clients must use this configuration. Authority trees deliberately use a
different DDS type, ending in `/external-authority-v1`. This is a new experimental
protocol, not wire-compatible with an unmodified tree. The Fluid ordering service
is unchanged. IDs and epochs provide fencing; **they do not authenticate writers**.
Every writer in this prototype is trusted and can access the controller.

## Controller

`getSharedTreeAuthority(tree)` exposes:

* `capture()` — a consistent immutable approved checkpoint, ordered stable
  `editIds`, `exportApproved()` and `exportSequenced()` snapshots. The latter is
  **A+P**, never A+P+L. Snapshots are real checkout forks with history diffs applied
  to their forests, schemas and removed-root indexes. They do not follow live edits.
* `createDraft(capture)` — a private fork at **A**, edited with ordinary
  `draft.viewWith(configuration)` and typed tree operations. It does not submit
  ordinary Fluid operations.
* `publishAdvance({ batchId, nextCheckpoint, capture, approvePrefix?, draft? })`
  — publishes one authority message. The promise reports `"applied"`,
  `"duplicate"` or `"stale"` only after normal sequenced self-echo.
* `onStateChanged(listener)` — notification after sequenced processing; returns
  an unsubscribe function.

Use **either** an unchanged `approvePrefix` count from that capture **or** an
external draft. Combined transformed settlement is rejected rather than
approximated. Publishing seals the draft for further publication. Complete any
open draft transaction before publishing. Dispose drafts/captures when no longer
needed. Snapshots use SharedTree's existing `VerboseTree` format; the authority
controller does not perform package serialization or application-level merging.

Example unchanged-prefix settlement:

```ts
const authority = getSharedTreeAuthority(tree);
const cut = authority.capture();
const outcome = await authority.publishAdvance({
    batchId: "unique-external-batch",
    nextCheckpoint: "unique-approved-checkpoint",
    capture: cut,
    approvePrefix: cut.editIds.length,
});
cut.dispose();
```

Attach/initialize the tree and approve its initialization before authoring
external drafts. Schema evolution after the first authority advance is rejected.
For an external draft, capture A, create the draft, edit it, then publish it using
the same capture. An intervening authority advance makes that publication stale;
capture and author again. Ordinary optimistic edits may continue concurrently.

## What actually changes

* `shared-tree-core/editManager.ts` retains original Fluid-reference checkpoints
  **T**, plus separate approved **A**, sequenced provisional **P** and local **L**
  history roles. Historical sequence mappings are not rewritten when A advances.
* Peer reconstruction rebases a sender's pending branch onto its original T
  checkpoint, not a new interpretation of the old reference.
* An external draft extends A. Existing rebasers transform P over the new A, then
  L over that new sequenced trunk. Live checkout observers receive the resulting
  transition through the existing rebase event, not a silent `setHead`.
* `sharedTreeCore.ts` wraps existing change codecs in one versioned authority
  envelope. Draft changes retain revision/session/compressor context and are
  enriched using their actual draft checkout. Fluid acknowledgment still retires
  ordinary retransmission; authority approval retires P separately.
* `externalAuthorityController.ts` provides capture, ordinary draft editing and
  publication without exposing changeset internals or a second application queue.
* Authority-mode undo resolves the original stable revision in the **current
  semantic history** before inversion. Inverting the old retained authoring
  commit instead would restore an obsolete pre-authority value. This opt-in
  behavior is propagated to forks; normal-mode undo is unchanged.

## Deliberate limits

* **No runtime summaries.** Attach/bootstrap summaries use existing machinery;
  runtime summaries after sequenced authority-mode work fail explicitly. Do not
  enable production summarization or claim durable reopen/replay support.
  Pre-attach seed edits become the approved baseline with P empty. Bootstrap
  summaries persist all three configured authority labels; loading checks them
  before loading tree state. Wrong/missing labels or loading an authority summary
  with an ordinary factory fails explicitly. Older experimental summaries without
  this metadata are deliberately unsupported, rather than silently reinterpreted.
  Matching-label bootstrap load is tested using a separately deserialized
  IdCompressor. This does not establish later authority-history recovery.
* All history, removed-root retention and authority deduplication records are
  retained without a bound. This is for bounded experiments, not production GC.
* Reconnect/resubmit of ordinary work and an authority publication have dedicated
  real-client tests. Persisted pending-state replay and summary reconstruction are
  not thereby proved.
* No subset acceptance, transformed/coalesced replacement, rejection rollback,
  arbitrary historical base authoring, authority election, or cryptographic
  authorization. Duplicate batch IDs with different content are protocol errors.
* No shared branches or schema evolution. Required-field vacancy and same-object
  detached-node reinsertion remain unsupported on this 2.111 base. The user's
  2.74 experimental build already supports sequence/optional reinsertion; that is
  a distinct, unported feature, not something disproved by this prototype.
* Existing move and removal/undo identity are tested across authority rebases.
  That is not a substitute for general Detach/Attach.
* Conflicting-write undo/redo is tested across repeated authority advances.
  This restricted stable-revision model does not establish undo semantics for
  future transformed/subset settlement that discards or replaces revisions.

## Validation

From the Fluid workspace, using its existing pnpm toolchain:

```powershell
$env:JS_DEVMAIN_USE_SYSTEM_TOOLS = '1'
pnpm --filter @fluidframework/tree run build:esnext
pnpm --filter @fluidframework/tree run build:test:esm
pnpm --filter @fluidframework/tree run test:mocha:esm -- --grep 'external authority'
```

The suite is `src/test/shared-tree/externalAuthority.spec.ts`. It uses actual
independent SharedTree clients and compressors and compares tree content,
observable atomic transitions and hydrated object identity. It includes the
decisive order reversal (Fluid P writes 1, external A writes 2, rebased P still
wins with 1), old-reference sender predecessors, local L, immutable cuts,
prefix/dedup/stale handling, undo, reconnect/resubmit, mixed runtime batches,
explicit summary rejection and unsupported editing boundaries.
