---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Faster property reads on nodes in a SharedTree

Reading a property of a node in a [TreeView](https://fluidframework.com/docs/api/fluid-framework/treeview-interface) is faster, especially when the same nodes are read repeatedly.
Reading a property again reuses the field object created on the first read without locating the node in the tree again.
Fields and child nodes read for the first time are anchored directly under their parent instead of from their path from the root of the tree.

This helps apps that read large parts of a tree, for example an app that renders every slide of a large presentation from the tree and re-renders slides after edits.

Reading every slide of 200-slide presentations through the node API, per slide:

| Measurement | Before | After |
| --- | --- | --- |
| First read, real / text-heavy / diagram presentation | 8.6 / 10.0 / 30.3 ms | 5.6 / 8.3 / 22.9 ms |
| Second read of the same nodes | 4.6 / 6.9 / 16.5 ms | 2.5 / 3.3 / 8.8 ms |

Measured with an equivalent change patched into version 3.2.0, in headless Microsoft Edge, on presentation documents converted from PowerPoint into a schema of 242 node types, 200 slides each; medians. Results depend on the schema and environment.
