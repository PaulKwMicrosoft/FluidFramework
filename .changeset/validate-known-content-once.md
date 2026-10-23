---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Less repeated schema validation when cloning and inserting content

Two cases no longer validate content against a schema it is already known to conform to, outside of debug builds:

- [`TreeBeta.clone`](https://fluidframework.com/docs/api/fluid-framework/treebeta-interface#clone-methodsignature) of a node in a tree: the content is read from the tree, which only holds content in the stored schema the clone uses.
- Inserting content into a tree whose stored schema allows exactly what its view schema does (the view's compatibility `isEquivalent`), when the view schema has no staged schema upgrades, and every inserted node was constructed or imported (for example with `TreeAlpha.importVerbose`) through the view's own schema classes.
  Such content was already checked against a stored schema generated from those classes when it was created, which in this case is the same as the document's.

Content which can differ from the document's stored schema is still validated on insertion: content of views with staged upgrades, of documents whose stored schema differs from the view schema, of other schema classes, and cloned content, which keeps any unknown optional fields of the tree it was cloned from.

For 200-slide presentations (each slide imported with `TreeAlpha.importVerbose` or constructed, then inserted; medians of 3), per slide:

| Measurement | Before | After |
| --- | --- | --- |
| `TreeBeta.clone` of a slide, text-heavy deck | 110.5 ms | 68.1 ms |
| `TreeBeta.clone` of a slide, diagram deck | 86.7 ms | 58.6 ms |
| Inserting a slide, text-heavy deck | 206.1 ms | 193.7 ms |
| Inserting a slide, diagram deck | 179.6 ms | 170.0 ms |

Measured in headless Microsoft Edge on presentation documents converted from PowerPoint into a schema of 242 node types (about 830 fields), with debug-only checks removed as in production bundles. The machine was busy with other work, so compare ratios rather than absolute times. Results depend on the schema and environment.