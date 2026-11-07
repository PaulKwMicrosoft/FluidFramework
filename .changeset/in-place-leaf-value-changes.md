---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
New experimental alpha option `enableInPlaceValueChanges` to change leaf values without replacing the leaves

Setting a property to a new number, string or boolean replaces the leaf node holding the old value with a new one.
That needs the new leaf to be built, the old one to be detached and kept for undo, and the new one to be attached.

With `enableInPlaceValueChanges` (in `SharedTreeOptions` and the options of independent trees), setting a required property whose only allowed type is a number, string or boolean changes the value of its leaf in place, through a property assignment or `TreeAlpha.setFields`.
The tree and its events are the same as when replacing the leaf, and concurrent sets of the same property are still resolved by the last one winning.
Undoing such a change needs no removed content, so none is kept for it (for small leaves such as numbers, this saves little memory).

```typescript
const factory = configuredSharedTree({ enableInPlaceValueChanges: true });
```

Edits with in-place value changes are written in persisted formats which are not yet released, so documents edited with this option enabled can only be opened by clients which support those formats.
Optional properties and properties allowing several types are still set by replacing their leaves.

In a tree keeping an undo history of up to 50 edits:

| Edit | Replacing leaves | In place |
| --- | --- | --- |
| Set one number property, in a transaction | 0.74 ms | 0.63 ms |
| Undo it | 0.44 ms | 0.42 ms |
| Set two number properties of each of 100 objects with one `TreeAlpha.setFields` | 14.4 ms | 12.0 ms |
| The same as 200 assignments in a transaction | 65.9 ms | 56.1 ms |

Measured in Node.js 22, with both versions in one process, as medians of 25 repetitions.
Results depend on the schema and environment.
