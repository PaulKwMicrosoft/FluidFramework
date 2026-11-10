---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Prototype: several properties can be set to content in the verbose format as one edit

The new alpha function `TreeAlpha.setFieldsVerbose(assignments)` is `TreeAlpha.setFields` for content in the [`VerboseTree`](https://fluidframework.com/docs/api/fluid-framework/verbosetree-typealias) format.
It checks and builds the content as `TreeAlpha.setVerbose` does, directly into the tree's storage without creating nodes for it, and sets all the properties as one edit, as `TreeAlpha.setFields` does.

When the same content object is given for several properties which allow the same types, it is checked and built once, and the properties share it in the tree's storage until one of them is edited.
Content which gets new identifiers is not shared, so that each property gets its own identifiers.

```typescript
const fill = { type: SolidFill.identifier, fields: { color: "#FF0000" } };
TreeAlpha.setFieldsVerbose(items.map((item) => [item, "fill", fill] as const));
```

Setting one property of 100 nodes of a large document to the same new value, and undoing it (median of 4 alternating process pairs, Node.js, production mode):

| Measurement | Imported nodes with `setFields` | `setFieldsVerbose` |
| --- | --- | --- |
| Edit | 27.4 ms | 20.0 ms |
| Undo | 23.6 ms | 17.8 ms |

Results depend on the schema and environment.
