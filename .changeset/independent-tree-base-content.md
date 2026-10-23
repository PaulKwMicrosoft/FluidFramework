---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Content can be loaded into independent trees outside their edit history

The new alpha function `TreeAlpha.replaceAsBase(parent, key, newContent)` replaces the content under a key of a node (an array element, an object property, or a map or record entry) as part of the base state of the tree's history, rather than as an edit.
It is available for trees created by [`createIndependentTreeAlpha`](https://fluidframework.com/docs/api/fluid-framework#createindependenttreealpha-function) with the new alpha option `enableBaseContent`.

The tree and its nodes are updated, and node change events are raised, as for the equivalent edit.
But no commit is created: there is no `changed` event and no revertible, and the replaced content is discarded.
Reverting commits made before or after the replacement does not revert it, as if the new content had always been there.

This is useful for applications that load a large document into a tree in steps, such as a presentation whose slides are loaded on demand to replace placeholders.
Loading such content with ordinary edits adds a commit for each step to the history, and every undo of an earlier user edit has to be rebased over all of them, so undo gets slower as the document loads.
Content loaded with `replaceAsBase` is not part of the history, so the cost of undo does not depend on it.

```typescript
const tree = createIndependentTreeAlpha({ enableBaseContent: true, maxRevertibles: 50 });
const view = tree.viewWith(config);
// ...
// Replace a placeholder slide with its content, which was loaded on demand.
TreeAlpha.replaceAsBase(view.root.slides, index, loadedSlide);
```

The replaced content must not have been changed by a commit retained in the tree's history, since such a commit could no longer be reverted: `replaceAsBase` throws a `UsageError` in that case.
It also throws during transactions and change events, and while the tree has forks.

Undoing a user edit made before slides were loaded in the background, 200-slide presentations:

| Measurement | Before | After |
| --- | --- | --- |
| Undo after 30 slides were loaded since the edit | 8.1 to 10.1 ms | 0.5 ms |
| Undo after 100 slides were loaded since the edit | 20.5 to 23.2 ms | 0.4 to 0.5 ms |

Loading time is unchanged, and about 1 MB less history is kept for 200 slides.

Measured with an equivalent change patched into version 3.2.0, in headless Microsoft Edge, on presentation documents converted from PowerPoint into a schema of 242 node types, 200 slides each; medians. Results depend on the schema and environment.
