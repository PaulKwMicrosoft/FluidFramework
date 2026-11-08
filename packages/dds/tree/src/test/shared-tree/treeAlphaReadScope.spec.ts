/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

// eslint-disable-next-line import-x/no-internal-modules
import { createIndependentTreeAlpha } from "../../shared-tree/independentView.js";
import { ForestTypeOptimized, TreeAlpha, TreeBeta } from "../../shared-tree/index.js";
import {
	asTreeViewAlpha,
	getInnerNode,
	SchemaFactoryAlpha,
	TreeViewConfigurationAlpha,
	type TreeViewAlpha,
} from "../../simple-tree/index.js";

import { createTestUndoRedoStacks } from "../utils.js";

const sf = new SchemaFactoryAlpha("test.treeAlphaReadScope");
class Point extends sf.object("Point", { x: sf.number, y: sf.number }) {}
class Item extends sf.object("Item", { name: sf.string, pos: Point }) {}
class Root extends sf.object("Root", { items: sf.array("Items", Item) }) {}

function makeView(count = 5) {
	const view = createIndependentTreeAlpha({ forest: ForestTypeOptimized }).viewWith(
		new TreeViewConfigurationAlpha({ schema: Root }),
	);
	view.initialize(
		new Root({
			items: Array.from({ length: count }, (_, i) => ({
				name: `item${i}`,
				pos: { x: i, y: -i },
			})),
		}),
	);
	return view;
}

function anchorCount(view: ReturnType<typeof makeView>): number {
	return (getInnerNode(view.root).context as unknown as { withAnchors: ReadonlySet<unknown> })
		.withAnchors.size;
}

describe("TreeAlpha.readScope", () => {
	it("does not keep the nodes it releases alive, after an edit and its undo", async () => {
		// The test runner does not expose gc, so expose it here.
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const view = makeView(2000);
		const root = view.root;
		const context = getInnerNode(root).context as unknown as {
			readonly cursorHolderCount: number;
			readonly listedCursorHolderCount: number;
		};
		const { undoStack, unsubscribe } = createTestUndoRedoStacks(asTreeViewAlpha(view).events);
		const read = (): WeakRef<object>[] =>
			TreeAlpha.readScope(root, () => {
				const released: WeakRef<object>[] = [];
				for (const item of root.items) {
					released.push(new WeakRef(getInnerNode(item)), new WeakRef(getInnerNode(item.pos)));
				}
				return released;
			});

		read();
		const edited = root.items[0] ?? assert.fail();
		edited.pos.x = 100;
		undoStack.pop()?.revert();
		assert.equal(root.items[0]?.pos.x, 0);
		const released = read();
		unsubscribe();

		// Released entities do not stay listed as cursor holders until the next edit.
		assert(context.listedCursorHolderCount <= 2 * context.cursorHolderCount + 64);
		// WeakRef targets are kept until the current job ends.
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
		// At most the list's slack of entries for released entities is kept, out of the thousands released.
		const alive = released.filter((ref) => ref.deref() !== undefined).length;
		assert(alive <= 2 * context.cursorHolderCount + 64, `${alive} released nodes kept`);
		view.dispose();
	});

	it("returns the result of reading and releases nodes first read in it", () => {
		const view = makeView();
		const root = view.root;
		const anchorsBefore = anchorCount(view);
		let firstItem: Item | undefined;
		const sum = TreeAlpha.readScope(root, () => {
			let total = 0;
			for (const item of root.items) {
				total += item.pos.x + item.pos.y + item.name.length;
			}
			firstItem = root.items[0];
			return total;
		});
		assert.equal(sum, 5 * 5);
		assert.equal(anchorCount(view), anchorsBefore);
		assert(firstItem !== undefined);
		assert.throws(() => firstItem?.name, validateUsageError(/released/));
		// Reading again gives new, usable nodes.
		const again = root.items[0];
		assert(again !== undefined);
		assert.notEqual(again, firstItem);
		assert.equal(again.name, "item0");
		again.pos.x = 10;
		assert.equal(root.items[0]?.pos.x, 10);
	});

	it("does not affect nodes which existed before it", () => {
		const view = makeView();
		const root = view.root;
		const item = root.items[1] ?? assert.fail();
		const pos = item.pos;
		let events = 0;
		const off = TreeBeta.on(pos, "nodeChanged", () => events++);
		TreeAlpha.readScope(root, () => {
			// Reading through a parent first read in the scope reaches the existing nodes.
			assert.equal(root.items[1], item);
			assert.equal(item.pos, pos);
			// Existing nodes can be subscribed to in the scope.
			TreeBeta.on(item, "nodeChanged", () => {})();
		});
		assert.equal(root.items[1], item);
		assert.equal(item.pos, pos);
		pos.x = 42;
		assert.equal(events, 1);
		assert.equal(root.items[1]?.pos.x, 42);
		off();
	});

	it("keeps existing nodes under a node first read in the scope usable", () => {
		const view = makeView();
		const root = view.root;
		const pos = root.items[2]?.pos ?? assert.fail();
		// Release the item (but not its position) so that it is first read again in the scope.
		const item = root.items[2] ?? assert.fail();
		TreeAlpha.readScope(root, () => {
			assert.equal(root.items[2]?.pos.x, 2);
		});
		assert.equal(item.name, "item2");
		assert.equal(pos.x, 2);
		pos.x = 7;
		assert.equal(root.items[2]?.pos.x, 7);
	});

	it("forbids edits inside it", () => {
		const view = makeView();
		const root = view.root;
		const existing = root.items[0] ?? assert.fail();
		assert.throws(
			() =>
				TreeAlpha.readScope(root, () => {
					existing.name = "changed";
				}),
			validateUsageError(/read scope/),
		);
		assert.throws(
			() =>
				TreeAlpha.readScope(root, () => {
					root.items.insertAtEnd({ name: "new", pos: { x: 0, y: 0 } });
				}),
			validateUsageError(/read scope/),
		);
		assert.throws(
			() =>
				TreeAlpha.readScope(root, () =>
					(view as unknown as TreeViewAlpha<typeof Root>).runTransaction(() => {}),
				),
			validateUsageError(/read scope/),
		);
		assert.equal(existing.name, "item0");
		assert.equal(root.items.length, 5);
		// Edits work again afterwards.
		existing.name = "changed";
		assert.equal(root.items[0]?.name, "changed");
	});

	it("forbids subscribing to nodes first read inside it", () => {
		const view = makeView();
		const root = view.root;
		assert.throws(
			() =>
				TreeAlpha.readScope(root, () => {
					const item = root.items[3] ?? assert.fail();
					TreeBeta.on(item, "nodeChanged", () => {});
				}),
			validateUsageError(/read scope/),
		);
		// Nodes read afterwards can be subscribed to.
		const item = root.items[3] ?? assert.fail();
		TreeBeta.on(item, "nodeChanged", () => {})();
	});

	it("cannot be nested", () => {
		const view = makeView();
		const root = view.root;
		assert.throws(
			() => TreeAlpha.readScope(root, () => TreeAlpha.readScope(root, () => 1)),
			validateUsageError(/nested/),
		);
		// The failed scope ended: a new one can run.
		assert.equal(
			TreeAlpha.readScope(root, () => root.items.length),
			5,
		);
	});

	it("releases nodes when reading throws", () => {
		const view = makeView();
		const root = view.root;
		const anchorsBefore = anchorCount(view);
		assert.throws(() =>
			TreeAlpha.readScope(root, () => {
				for (const item of root.items) {
					assert(item.pos.x >= 0);
				}
				throw new Error("read failed");
			}),
		);
		assert.equal(anchorCount(view), anchorsBefore);
		assert.equal(root.items[4]?.pos.y, -4);
	});
});
