---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Unhydrated nodes of a schema without staged upgrades share one context per view configuration

Each schema class gets its own unhydrated context the first time a node of it is created.
Converted node definitions are shared between these contexts, but each context still has its own lookup maps of every schema reachable from its class (except among classes of the same recursive group).
For a large schema of mostly non-recursive types, this builds and keeps many overlapping maps, each nearly as large as the whole schema.

Constructing a [`TreeViewConfiguration`](https://fluidframework.com/docs/api/fluid-framework/treeviewconfiguration-class) now lets every schema class reachable from it share the unhydrated context of the configuration's root, when the schema has no staged schema upgrades.
Unhydrated nodes are always checked against the relaxed stored schema (all staged types allowed, no unknown optional fields), which gives each schema class the same stored schema whichever root it is derived from, so this does not change which content is accepted.
Schema classes which already have an unhydrated context keep it.

For a presentation document schema, from a fresh page (medians of 9):

For a presentation document schema, from a fresh page (medians of 5):

| Measurement | Before | After |
| --- | --- | --- |
| Building and inserting the presentation's outline (first nodes of most schema classes) | 18.6 ms | 13.0 ms |
| Memory retained after releasing all document data | 5.5 MB | 4.25 MB |

Measured in headless Microsoft Edge on presentation documents converted from PowerPoint into a schema of 242 node types (about 830 fields), with debug-only checks removed as in production bundles, on top of the shared stored-schema conversion. The machine was shared with background work, so compare ratios rather than absolute times. Results depend on the schema and environment.

Measured in headless Microsoft Edge on presentation documents converted from PowerPoint into a schema of 242 node types (about 830 fields), with debug-only checks removed as in production bundles. The machine was busy with other work, so compare ratios rather than absolute times. Results depend on the schema and environment.
