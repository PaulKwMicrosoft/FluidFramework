---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Unhydrated nodes of a schema without staged upgrades share one stored schema

Each schema class used to derive its own stored schema, for the subtree of schema it roots, the first time a node of it was created.
For a large schema this repeated most of the work of deriving the whole schema many times over, and kept each copy in memory.

Constructing a [`TreeViewConfiguration`](https://fluidframework.com/docs/api/fluid-framework/treeviewconfiguration-class) now lets every schema class reachable from it share the stored schema derived for the configuration's root, when the schema has no staged schema upgrades.
Unhydrated nodes are always checked against the relaxed stored schema (all staged types allowed, no unknown optional fields), which gives each schema class the same stored schema whichever root it is derived from, so this does not change which content is accepted.

For a presentation document schema, from a fresh page (medians of 9):

| Measurement | Before | After |
| --- | --- | --- |
| `TreeView.initialize()` of an empty document, first call | 163 ms | 111 ms |
| Building and inserting the presentation's outline (first nodes of most schema classes) | 163 ms | 22 ms |
| Building and inserting the first slide | 678 ms | 520 ms |
| Memory retained after releasing all document data | 11.0 MB | 4.8 MB |

Measured in headless Microsoft Edge on presentation documents converted from PowerPoint into a schema of 242 node types (about 830 fields), with debug-only checks removed as in production bundles. The machine was busy with other work, so compare ratios rather than absolute times. Results depend on the schema and environment.