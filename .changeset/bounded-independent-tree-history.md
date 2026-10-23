---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Independent trees can limit their undo history

The new alpha option `maxRevertibles` of [`createIndependentTreeAlpha`](https://fluidframework.com/docs/api/fluid-framework#createindependenttreealpha-function) and [`createIndependentTreeViewAlpha`](https://fluidframework.com/docs/api/fluid-framework#createindependenttreeviewalpha-function) limits how many revertibles for the tree's commits are valid at once.
When a revertible is obtained beyond the limit, the oldest valid one is disposed; reverting it afterwards throws a `UsageError`.

With the option set, the tree also keeps only the history that its valid revertibles need.
Without it, an independent tree keeps every commit since it was created, along with the content each commit removed, because nothing else releases them.
An application that loads a large document in many steps (for example, a presentation loaded slide by slide), and that only takes revertibles for user edits, keeps the commits and removed content of the loading steps for as long as the tree exists.
Limiting the undo depth bounds this history, and with it the cost of undoing an edit and of starting a transaction.

```typescript
const tree = createIndependentTreeAlpha({ maxRevertibles: 50 });
const view = tree.viewWith(config);
view.events.on("changed", (metadata, getRevertible) => {
	// Only user edits are made undoable: commits without a revertible do not hold history back.
	if (getRevertible !== undefined && !metadata.labels.has("load")) {
		undoStack.push(getRevertible());
	}
});
```

Each undo rebases its inverse over every commit made since the undone one, so in an editor that keeps an unbounded history, the 10th, 50th and 200th consecutive undo of a 200-slide presentation took 1.7, 9.4 and 51.6 ms. With `maxRevertibles` set to the editor's undo depth, the deepest undo is bounded by that depth (about 3.5 ms at a depth of 20), and the trimmed commits and their repair data are freed (1 to 2.6 MB for 200 slides).

Measured with an equivalent change patched into version 3.2.0, in headless Microsoft Edge, on presentation documents converted from PowerPoint into a schema of 242 node types, 200 slides each; medians. Results depend on the schema and environment.
