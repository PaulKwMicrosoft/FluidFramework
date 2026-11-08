---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Prototype: the nodes read under a node can be released without creating nodes for its unread children

The new alpha function `TreeAlpha.releaseDescendants(node)` releases the objects created for reading the nodes under `node`, as `TreeAlpha.release` does for each of them, and keeps `node` itself.
It visits only nodes which have been read, so unlike calling `TreeAlpha.release` on each of `TreeAlpha.children(node)`, it creates no nodes for children which were never read.

Nodes under `node` which have event listeners are kept, along with the nodes between them and `node`, and their listeners keep working.
`node` keeps its own listeners.
