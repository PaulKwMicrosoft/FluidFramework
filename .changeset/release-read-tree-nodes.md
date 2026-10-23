---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
New alpha `TreeAlpha.release` API for freeing the memory used to read nodes

Reading a node of a [TreeView](https://fluidframework.com/docs/api/fluid-framework/treeview-interface) creates objects for it, including its `TreeNode`, which are kept as long as the view exists.
An app which reads a large tree once and keeps the view therefore keeps memory proportional to everything it has read.
For example, an app which reads every slide of a large presentation once to render it, and then keeps the tree open for editing, keeps several objects per node it read for the lifetime of the view.

`TreeAlpha.release(node)` frees these objects for `node` and for every node under it which has been read, without changing the tree's content.
Afterwards, the released `TreeNode` objects cannot be used: reading the same location again, for example from the node's parent, returns a new `TreeNode`.

```typescript
for (const slide of view.root.slides) {
	render(slide);
	TreeAlpha.release(slide);
}
```

Nodes which have event listeners on them or on any node under them cannot be released, and neither can unhydrated nodes.
See the documentation of `TreeAlpha.release` for details.

Reading all slides of 200-slide presentations once kept 250 to 900 MB for the life of the view (1.3 to 4.5 MB per slide); after `TreeAlpha.release` of each slide, memory returned to that of the never-read view. Releasing took about 1 to 4 ms per slide.

Measured with an equivalent change patched into version 3.2.0, in headless Microsoft Edge, on presentation documents converted from PowerPoint into a schema of 242 node types, 200 slides each; medians. Results depend on the schema and environment.
