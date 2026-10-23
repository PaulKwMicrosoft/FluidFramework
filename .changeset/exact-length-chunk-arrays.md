---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Less memory for SharedTree's optimized forest

The optimized forest (`ForestTypeOptimized`) builds the arrays which hold each node's children and each compactly stored subtree's values by appending to them, and JavaScript engines leave spare capacity in arrays grown that way.
For content with many small fields, such as large presentation documents, that spare capacity was a large share of the forest's memory.
These arrays are now copied to arrays of exactly their length once complete.

Memory used by the forest for 200-slide presentations was 0.55 to 0.57 times as much (for example 28.3 MB to 16.2 MB for a real presentation), with load, read and edit times within 5%.

Measured with an equivalent change patched into version 3.2.0, in headless Microsoft Edge, on presentation documents converted from PowerPoint into a schema of 242 node types, 200 slides each; medians. Results depend on the schema and environment.