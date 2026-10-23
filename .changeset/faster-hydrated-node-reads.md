---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Faster first reads of nodes in a SharedTree

Reading a property of a node in a [TreeView](https://fluidframework.com/docs/api/fluid-framework/treeview-interface) is faster the first time each property and each child node is read.
The field or child node read is anchored directly under its parent node, instead of from its path from the root of the tree.
Reading a property again returns the field object created on an earlier read without first navigating to the field.

This helps apps that read large parts of a tree, for example an app that renders every slide of a large presentation from the tree.

On top of reusing cached fields and anchors for navigation, reading every node of 200-slide presentations showed no consistent change at two runs per configuration (first read +7%, -32% and -16% on three presentations; re-reads within noise). The change removes per-read work that does not show up as a consistent end-to-end gain in this measurement.
