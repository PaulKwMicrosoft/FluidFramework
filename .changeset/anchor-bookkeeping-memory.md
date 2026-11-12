---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Hydrated nodes use less memory for their internal bookkeeping

Each node read from a SharedTree retains less heap for the internal records that track it.
In a benchmark reading 6,000 object nodes, retained heap per hydrated node fell by about 1,050 bytes, to about 1,360 bytes with the default forest and about 1,185 bytes with `ForestTypeOptimized`.

A node's internal event emitter is now created only when something subscribes to the node's events.
Subscribing to a node's events therefore costs a little more than before, but a node with listeners still uses less memory overall.
