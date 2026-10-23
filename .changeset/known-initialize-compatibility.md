---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Faster `TreeView.initialize()` for schemas without staged upgrades

[`TreeView.initialize()`](https://fluidframework.com/docs/api/fluid-framework/treeview-interface#initialize-methodsignature) no longer compares the view schema with the whole stored schema it installs, when the view schema has no staged schema upgrades.
The stored schema is generated from the view schema, so only the root field can differ from it (a required root is installed as optional first, while the content is inserted).
Compatibility is computed from the root field alone in that case.

For a presentation document schema, the first `TreeView.initialize()` of an empty document took about 23% less time:

| Measurement | Before | After |
| --- | --- | --- |
| `TreeView.initialize()`, first call in a fresh page (median of 9) | 163 ms | 126 ms |

Measured in headless Microsoft Edge on presentation documents converted from PowerPoint into a schema of 242 node types (about 830 fields), with debug-only checks removed as in production bundles. The machine was busy with other work, so compare ratios rather than absolute times. Results depend on the schema and environment.