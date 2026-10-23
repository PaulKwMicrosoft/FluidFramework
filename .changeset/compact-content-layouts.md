---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Less memory for SharedTree content whose schema allows several layouts

The optimized forest (`ForestTypeOptimized`) stores subtrees whose schema fixes their whole layout compactly, as shared layout information plus a flat array of values.
Any optional field, sequence field or field allowing several types prevented that, so content such as large presentation documents, with optional fields on most nodes, was stored with a separate map and arrays for every node.

The optimized forest now also derives layouts from the content itself: a subtree in which each field holds a single child of a recurring layout is stored compactly as well, and identical sibling subtrees share storage.
This also applies to content loaded from a summary or received in ops, which is stored compactly when it is added to the forest, at the cost of some additional work when loading.
The cached layouts are bounded in number and size, and fields which are summarized incrementally keep their own storage.
This changes how content is stored in memory only: the content, its field order and the summaries and ops produced from it are unchanged.

With exact-length chunk arrays, memory used by the forest for 200-slide presentations:

| Measurement | Before | After |
| --- | --- | --- |
| Real presentation | 27.8 MB | 5.5 MB |
| Text-heavy presentation | 36.0 MB | 6.5 MB |
| Diagram presentation | 89.5 MB | 10.5 MB |

Inserting content took 0.89 to 1.10 times as long; loading content from a summary takes longer, as it is re-chunked (2.6 to 3.5 times as long in the measurement), in exchange for the memory saving.

Measured with an equivalent change patched into version 3.2.0, in headless Microsoft Edge, on presentation documents converted from PowerPoint into a schema of 242 node types, 200 slides each; medians. Results depend on the schema and environment.
