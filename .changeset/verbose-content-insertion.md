---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Prototype: content in the verbose format can be inserted directly into a tree

New alpha functions insert content in the [`VerboseTree`](https://fluidframework.com/docs/api/fluid-framework/verbosetree-typealias) format directly into a tree:
`TreeAlpha.insertVerbose(array, index, content)` inserts items into an array node, and `TreeAlpha.setVerbose(parent, key, content)` sets an object property or a map or record entry.
`TreeAlpha.replaceAsBaseVerbose(parent, key, newContent)` is the equivalent of `TreeAlpha.replaceAsBase` for such content.

These functions are a prototype of importing content directly into a specific tree.
They may be replaced by APIs which create content in the context of a tree.

Inserting content created with `TreeAlpha.importVerbose` checks it against the schema twice: once when it is created, and again against the stored schema of the tree it is inserted into.
The new functions check the content once, against the stored schema of the destination tree, and build it directly into the tree's storage, without creating nodes for it.
The edit they make, its events, and its behavior in transactions and when reverted are those of the equivalent `insertAt` or property assignment.

The content uses stored keys, as produced by `TreeAlpha.exportVerbose` with `KeyEncodingOptions.allStoredKeys`.
Identifier fields without content get new identifiers.
Since the content is only checked against the stored schema, checks which node constructors run from the view schema (for example, those of tables made by `TableSchema`) do not run.

```typescript
TreeAlpha.insertVerbose(view.root.slides, index, [
	{ type: Slide.identifier, fields: { title: "Title", shapes: { type: Shapes.identifier, fields: [] } } },
]);
```

Importing verbose content and inserting it, per slide of 200-slide presentations:

| Measurement | `importVerbose` + insert | `insertVerbose` |
| --- | --- | --- |
| Synthetic slides, optimized forest | 9.0 ms | 1.0 ms |
| Synthetic slides, reference forest | 9.0 ms | 3.0 ms |
| Text-heavy presentation, optimized forest, with the other changes of this release (headless Microsoft Edge, busy machine) | 162.9 ms | 22.7 ms |
| Diagram presentation, same conditions | 130.5 ms | 18.9 ms |

The content is the same in both cases, and so is the forest's chunk layout. Results depend on the schema and environment.
