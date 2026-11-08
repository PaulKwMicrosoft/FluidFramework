/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable import-x/no-internal-modules */

import { strict as assert, fail } from "node:assert";

import {
	type Anchor,
	type AnchorNode,
	EmptyKey,
	type FieldKey,
	type ITreeSubscriptionCursor,
	type MapTree,
	compareUpPaths,
	rootFieldKey,
} from "../../../core/index.js";
import { Context } from "../../../feature-libraries/flex-tree/context.js";
import { LazyField } from "../../../feature-libraries/flex-tree/lazyField.js";
import { LazyTreeNode } from "../../../feature-libraries/flex-tree/lazyNode.js";
import { withObservation } from "../../../feature-libraries/flex-tree/observer.js";
import {
	type FlexTreeField,
	type FlexTreeNode,
	TreeStatus,
} from "../../../feature-libraries/index.js";
import { JsonAsTree } from "../../../jsonDomainSchema.js";
import {
	SchemaFactory,
	TreeViewConfiguration,
	getInnerNode,
	toUpgradeSchema,
} from "../../../simple-tree/index.js";
import {
	createIndependentTreeAlpha,
	ForestTypeOptimized,
	ForestTypeReference,
	Tree,
} from "../../../shared-tree/index.js";
import { stringSchema } from "../../../simple-tree/leafNodeSchema.js";
import { brand, disposeSymbol } from "../../../util/index.js";
import { getView, SharedTreeTestFactory, TestTreeProviderLite } from "../../utils.js";

import { readonlyTreeWithContent } from "./utils.js";

/**
 * Test {@link LazyTreeNode} implementation.
 */
class TestLazyTree extends LazyTreeNode {}

/**
 * Creates an {@link Anchor} and an {@link AnchorNode} for the provided cursor's location.
 */
function createAnchors(
	context: Context,
	cursor: ITreeSubscriptionCursor,
): { anchor: Anchor; anchorNode: AnchorNode } {
	const anchor = context.checkout.forest.anchors.track(cursor.getPath() ?? fail());
	const anchorNode = context.checkout.forest.anchors.locate(anchor) ?? fail();

	return { anchor, anchorNode };
}

describe("LazyNode", () => {
	for (const [name, forest] of [
		["ChunkedForest", ForestTypeOptimized],
		["ObjectForest", ForestTypeReference],
	] as const) {
		it(`an edit takes the cursor of every entity read since the last edit (${name})`, () => {
			const sf = new SchemaFactory("edit-cursors");
			class Item extends sf.object("Item", { value: sf.number, label: sf.string }) {}
			class Items extends sf.array("Items", Item) {}
			const view = createIndependentTreeAlpha({ forest }).viewWith(
				new TreeViewConfiguration({ schema: Items }),
			);
			view.initialize(Array.from({ length: 200 }, (_, i) => ({ value: i, label: `${i}` })));
			const context = getInnerNode(view.root).context;
			assert(context instanceof Context);
			const readAll = (): number =>
				view.root.reduce((sum, item) => sum + item.value + item.label.length, 0);

			const total = readAll();
			assert(context.cursorHolderCount >= 200);
			view.root[0].value = 1000;
			// The edit's own reads may get cursors again after it, but not those of the other items.
			assert(context.cursorHolderCount < 10);
			assert.equal(readAll(), total + 1000);
			view.root[1].value = 2000;
			assert.equal(readAll(), total + 1000 + 2000 - 1);
			view.dispose();
		});

		it(`entities which give up their cursor between edits are not kept for the next edit (${name})`, () => {
			const sf = new SchemaFactory("cursor-holders");
			class Item extends sf.object("Item", { value: sf.number }) {}
			class Items extends sf.array("Items", Item) {}
			const view = createIndependentTreeAlpha({ forest }).viewWith(
				new TreeViewConfiguration({ schema: Items }),
			);
			view.initialize(Array.from({ length: 200 }, (_, i) => ({ value: i })));
			const root = getInnerNode(view.root);
			assert(root instanceof LazyTreeNode);
			const context = root.context;
			const field = root.getBoxed(EmptyKey);
			for (let round = 0; round < 10; round++) {
				for (let i = 0; i < 200; i++) {
					const item = field.boxedAt(i);
					assert(item instanceof LazyTreeNode);
					assert(item.holdsCursor);
					item[disposeSymbol]();
				}
				// The list is compacted as entities are added, so it doesn't grow with the 2000 entities made here.
				assert(context.listedCursorHolderCount <= 2 * (context.cursorHolderCount + 1) + 64);
			}
			view.dispose();
		});

		it(`entities which give up their cursor are not kept listed until the next add (${name})`, () => {
			const sf = new SchemaFactory("cursor-holders-disposed");
			class Item extends sf.object("Item", { value: sf.number }) {}
			class Items extends sf.array("Items", Item) {}
			const view = createIndependentTreeAlpha({ forest }).viewWith(
				new TreeViewConfiguration({ schema: Items }),
			);
			view.initialize(Array.from({ length: 200 }, (_, i) => ({ value: i })));
			const root = getInnerNode(view.root);
			assert(root instanceof LazyTreeNode);
			const context = root.context;
			const field = root.getBoxed(EmptyKey);
			const items = Array.from({ length: 200 }, (_, i) => field.boxedAt(i));
			for (const item of items) {
				assert(item instanceof LazyTreeNode);
				assert(item.holdsCursor);
			}
			for (const item of items) {
				assert(item instanceof LazyTreeNode);
				item[disposeSymbol]();
			}
			assert(context.listedCursorHolderCount <= 2 * context.cursorHolderCount + 64);
			view.dispose();
		});

		it(`cached parents follow moves and removal without cursor recovery (${name})`, () => {
			const sf = new SchemaFactory("cached-parents");
			class Item extends sf.object("Item", { value: sf.number }) {}
			class Items extends sf.array("Items", Item) {}
			class Root extends sf.object("Root", { left: Items, right: Items }) {}
			const view = createIndependentTreeAlpha({ forest }).viewWith(
				new TreeViewConfiguration({ schema: Root }),
			);
			view.initialize({ left: [{ value: 1 }, { value: 2 }], right: [] });
			const root = view.root;
			const item = root.left[1];
			const node = getInnerNode(item);
			assert(node instanceof LazyTreeNode);
			const originalField = node.parentField.parent;
			root.right.moveToStart(1, root.left);
			const rightNode = getInnerNode(root.right);
			const destination = rightNode.getBoxed(EmptyKey);
			node.context.releaseCursors();
			let observations = 0;
			withObservation(
				{
					observeNodeDeep: () => assert.fail("unexpected deep observation"),
					observeNodeFields: () => assert.fail("unexpected fields observation"),
					observeNodeField: () => assert.fail("unexpected field observation"),
					observeParentOf: (observed) => {
						assert.equal(observed, node);
						observations++;
					},
				},
				() => {
					assert.deepEqual(node.parentField, { parent: destination, index: 0 });
					assert.equal(destination.parent, rightNode);
				},
			);
			assert.equal(observations, 1);
			assert.equal(node.context.cursorHolderCount, 0);
			assert.notEqual(destination, originalField);
			assert.equal(Tree.parent(item), root.right);
			assert.equal(Tree.key(item), 0);
			root.right.removeAt(0);
			assert.equal(Tree.parent(item), undefined);
			const checkout = node.context.checkout;
			view.dispose();
			assert.throws(() => node.parentField);
			assert.throws(() => destination.parent);
			checkout.dispose();
		});

		it(`cached fields preserve observation, emptiness and lifetime (${name})`, () => {
			const sf = new SchemaFactory("cached-fields");
			class Item extends sf.object("Item", { value: sf.optional(sf.number) }) {}
			const view = createIndependentTreeAlpha({ forest }).viewWith(
				new TreeViewConfiguration({ schema: Item }),
			);
			view.initialize({});
			const node = getInnerNode(view.root);
			assert(node instanceof LazyTreeNode);
			const key: FieldKey = brand("value");
			const field = node.getBoxed(key);
			node.context.releaseCursors();
			let observations = 0;
			withObservation(
				{
					observeNodeDeep: () => {},
					observeNodeFields: () => {},
					observeParentOf: () => {},
					observeNodeField: (observed, observedKey) => {
						assert.equal(observed, node);
						assert.equal(observedKey, key);
						observations++;
					},
				},
				() => assert.equal(node.getBoxed(key), field),
			);
			assert.equal(observations, 1);
			assert.equal(node.context.cursorHolderCount, 0);
			assert.equal(node.tryGetField(key), undefined);
			view.root.value = 1;
			assert.equal(node.tryGetField(key), field);
			view.root.value = undefined;
			assert.equal(node.getBoxed(key), field);
			assert.equal(node.tryGetField(key), undefined);
			const checkout = node.context.checkout;
			view.dispose();
			assert.throws(() => node.getBoxed(key));
			checkout.dispose();
		});

		for (const compatible of [true, false]) {
			it(`invalidates cached fields after ${compatible ? "compatible" : "incompatible"} schema replacement (${name})`, () => {
				const sf = new SchemaFactory("schema-dependent-cache");
				class Item extends sf.object("Item", { value: sf.number }) {}
				const view = createIndependentTreeAlpha({ forest }).viewWith(
					new TreeViewConfiguration({ schema: Item }),
				);
				view.initialize({ value: 1 });
				const item = view.root;
				const node = getInnerNode(item);
				assert(node instanceof LazyTreeNode);
				const key: FieldKey = brand("value");
				const field = node.getBoxed(key);
				const checkout = node.context.checkout;
				checkout.updateSchema(toUpgradeSchema(compatible ? Item : [Item, sf.string]));
				assert.throws(() => node.getBoxed(key));
				assert.throws(() => field.length);
				assert.throws(() => item.value);
				assert.equal(view.compatibility.canView, compatible);
				if (!compatible) {
					checkout.updateSchema(toUpgradeSchema(Item), true);
				}
				const replacement = getInnerNode(view.root);
				assert.notEqual(replacement, node);
				assert.notEqual(replacement.getBoxed(key), field);
				assert.equal(view.root.value, 1);
				view.dispose();
				checkout.dispose();
			});
		}

		it(`invalidates cached fields after a remote schema change (${name})`, () => {
			const sf = new SchemaFactory("remote-schema-dependent-cache");
			class Item extends sf.object("Item", { value: sf.number }) {}
			const config = new TreeViewConfiguration({ schema: Item });
			const provider = new TestTreeProviderLite(
				2,
				new SharedTreeTestFactory(() => {}, undefined, { forest }),
			);
			const [sourceTree, targetTree] = provider.trees;
			assert(sourceTree !== undefined && targetTree !== undefined);
			const source = sourceTree.viewWith(config);
			source.initialize({ value: 1 });
			provider.synchronizeMessages();
			const target = targetTree.viewWith(config);
			const item = target.root;
			const node = getInnerNode(item);
			assert(node instanceof LazyTreeNode);
			const key: FieldKey = brand("value");
			const field = node.getBoxed(key);
			const sourceNode = getInnerNode(source.root);
			assert(sourceNode instanceof LazyTreeNode);
			sourceNode.context.checkout.updateSchema(toUpgradeSchema([Item, sf.string]));
			provider.synchronizeMessages();
			assert.equal(target.compatibility.canView, false);
			assert.throws(() => node.getBoxed(key));
			assert.throws(() => field.length);
			assert.throws(() => item.value);
			source.dispose();
			target.dispose();
		});

		describe(`reads after an edit (${name})`, () => {
			const sf = new SchemaFactory("reads-after-edit");
			class Offset extends sf.object("Offset", { x: sf.number, y: sf.number }) {}
			class Transform extends sf.object("Transform", {
				off: Offset,
				rot: sf.optional(sf.number),
			}) {}
			class Shape extends sf.object("Shape", { id: sf.number, xfrm: Transform }) {}
			class Shapes extends sf.array("Shapes", Shape) {}
			class Slide extends sf.object("Slide", { shapes: Shapes, title: sf.string }) {}
			function createSlide(count: number) {
				const view = createIndependentTreeAlpha({ forest }).viewWith(
					new TreeViewConfiguration({ schema: Slide }),
				);
				view.initialize({
					title: "slide",
					shapes: Array.from({ length: count }, (_, i) => ({
						id: i,
						xfrm: { off: { x: i, y: -i }, rot: i % 2 === 0 ? i : undefined },
					})),
				});
				return view;
			}
			const lazy = (node: object): LazyTreeNode => {
				const inner = getInnerNode(node as Shape);
				assert(inner instanceof LazyTreeNode);
				return inner;
			};

			it("read the same nodes and values, and give cursors only to nodes whose leaves are read", () => {
				const view = createSlide(5);
				const shapes = [...view.root.shapes];
				const transforms = shapes.map((shape) => shape.xfrm);
				const offsets = transforms.map((xfrm) => xfrm.off);
				const sum = (): number =>
					view.root.shapes.reduce(
						(total, shape) =>
							total + shape.id + shape.xfrm.off.x + shape.xfrm.off.y + (shape.xfrm.rot ?? 0),
						0,
					);
				const before = sum();
				view.root.title = "edited";
				assert.equal(sum(), before);
				assert.deepEqual([...view.root.shapes], shapes);
				assert.deepEqual(
					view.root.shapes.map((shape) => shape.xfrm),
					transforms,
				);
				assert.deepEqual(
					view.root.shapes.map((shape) => shape.xfrm.off),
					offsets,
				);
				// Reading `shape.xfrm.off` finds each node from its parent's anchor, so `xfrm` gets no cursor.
				view.root.title = "edited again";
				for (const shape of view.root.shapes) {
					assert.equal(shape.xfrm.off.x, shape.id);
				}
				for (const xfrm of transforms) {
					assert.equal(lazy(xfrm).holdsCursor, false);
				}
				for (const offset of offsets) {
					assert(lazy(offset).holdsCursor);
				}
				view.dispose();
			});

			it("give a node a cursor at its own place in the tree", () => {
				const view = createSlide(4);
				const offsets = view.root.shapes.map((shape) => shape.xfrm.off);
				view.root.title = "edited";
				// The first shape's cursor is one an offset's cursor can be derived from.
				assert.equal(view.root.shapes[0]?.id, 0);
				for (const offset of offsets) {
					const node = lazy(offset);
					assert.equal(node.holdsCursor, false);
					const cursor = node.cursor;
					assert.equal(compareUpPaths(cursor.getPath(), node.anchorNode), true);
					assert.equal(cursor.type, Offset.identifier);
				}
				assert.deepEqual(
					offsets.map((offset) => [offset.x, offset.y]),
					[0, 1, 2, 3].map((i) => [i, i === 0 ? 0 : -i]),
				);
				view.dispose();
			});

			it("follow replaced and moved nodes", () => {
				const view = createSlide(3);
				const [first, second] = view.root.shapes;
				assert(first !== undefined && second !== undefined);
				const oldOffset = first.xfrm.off;
				first.xfrm.off = new Offset({ x: 10, y: 20 });
				assert.notEqual(first.xfrm.off, oldOffset);
				assert.equal(first.xfrm.off.x, 10);
				assert.equal(Tree.status(oldOffset), TreeStatus.Removed);
				view.root.shapes.insertAtStart({ id: 9, xfrm: { off: { x: 9, y: 9 } } });
				assert.equal(view.root.shapes[1], first);
				assert.equal(view.root.shapes[2], second);
				assert.equal(view.root.shapes[0]?.xfrm.off.x, 9);
				view.root.shapes.moveToEnd(1);
				assert.equal(view.root.shapes[3], first);
				assert.equal(view.root.shapes[1], second);
				assert.equal(first.xfrm.off.y, 20);
				view.dispose();
			});

			it("find known nodes of a sequence only in bounds and only for nodes already read", () => {
				const view = createSlide(3);
				const field = lazy(view.root.shapes).getBoxed(EmptyKey);
				assert(field instanceof LazyField);
				assert.equal(field.knownNodeAt(0), undefined);
				const first = view.root.shapes[0];
				const third = view.root.shapes[2];
				assert(first !== undefined && third !== undefined);
				assert.equal(field.knownNodeAt(0), lazy(first));
				assert.equal(field.knownNodeAt(1), undefined);
				assert.equal(field.knownNodeAt(3), undefined);
				view.root.shapes.removeAt(1);
				assert.equal(field.knownNodeAt(1), lazy(third));
				assert.equal(field.knownNodeAt(2), undefined);
				assert.equal(view.root.shapes[2], undefined);
				assert.equal(view.root.shapes[1], third);
				view.dispose();
			});

			it("read leaves with flex tree nodes as values", () => {
				const view = createSlide(2);
				const shape = view.root.shapes[0];
				assert(shape !== undefined);
				const idField = lazy(shape).getBoxed(brand("id"));
				assert(idField.boxedAt(0) instanceof LazyTreeNode);
				view.root.title = "edited";
				assert.equal(shape.id, 0);
				const numbers = createIndependentTreeAlpha({ forest }).viewWith(
					new TreeViewConfiguration({ schema: sf.array("Numbers", sf.number) }),
				);
				numbers.initialize([1, 2, 3]);
				assert(lazy(numbers.root).getBoxed(EmptyKey).boxedAt(1) instanceof LazyTreeNode);
				numbers.root.insertAtEnd(4);
				assert.deepEqual([...numbers.root], [1, 2, 3, 4]);
				assert.equal(numbers.root[1], 2);
				numbers.dispose();
				view.dispose();
			});
		});
	}

	it("cached fields preserve current reads but reject recovery in a broken forest", () => {
		const { context, cursor } = readonlyTreeWithContent({
			schema: JsonAsTree.JsonObject,
			initialTree: { x: 1 },
		});
		const node = context.root.boxedAt(0);
		assert(node !== undefined);
		const field = node.getBoxed(brand("x"));
		const breaker = context.checkout.forest.breaker;
		assert.throws(() => breaker.break(new Error("test break")), /test break/);
		assert.equal(node.getBoxed(brand("x")), field);
		assert(node instanceof LazyTreeNode);
		node.prepareForEdit();
		assert.throws(() => node.getBoxed(brand("x")), /invalid state/);
		breaker.clearError();
		cursor.free();
		context[disposeSymbol]();
	});

	it("does not reuse fields from a disposed context on the same anchors", () => {
		const { context, cursor } = readonlyTreeWithContent({
			schema: JsonAsTree.JsonObject,
			initialTree: { x: 1 },
		});
		const node = context.root.boxedAt(0);
		assert(node instanceof LazyTreeNode);
		const key: FieldKey = brand("x");
		const field = node.getBoxed(key);
		const forest = context.checkout.forest;
		const retainedAnchor = forest.anchors.track(node.anchorNode);
		cursor.free();
		context[disposeSymbol]();
		const replacement = new Context(
			context.schemaPolicy,
			context.checkout,
			context.nodeKeyManager,
		);
		const replacementNode = replacement.root.boxedAt(0);
		assert(replacementNode instanceof LazyTreeNode);
		assert.equal(replacementNode.anchorNode, forest.anchors.locate(retainedAnchor));
		assert.notEqual(replacementNode.getBoxed(key), field);
		assert.throws(() => node.getBoxed(key));
		replacement[disposeSymbol]();
		forest.anchors.forget(retainedAnchor);
	});

	describe("LazyNode", () => {
		it("parent", () => {
			const schemaFactory = new SchemaFactory("test");
			const ParentNode = schemaFactory.map("map", schemaFactory.string);

			const { context, cursor } = readonlyTreeWithContent({
				schema: ParentNode,
				initialTree: { [EmptyKey]: "test" },
			});
			cursor.enterNode(0);

			const { anchor, anchorNode } = createAnchors(context, cursor);

			const node = new TestLazyTree(
				context,
				brand(ParentNode.identifier),
				cursor,
				anchorNode,
				anchor,
			);
			const { index, parent } = node.parentField;
			assert.equal(index, 0);
			assert.equal(parent.key, rootFieldKey);
		});

		it("keys", () => {
			{
				const { context, cursor } = readonlyTreeWithContent({
					schema: JsonAsTree.JsonObject,
					initialTree: {},
				});
				cursor.enterNode(0);
				const { anchor, anchorNode } = createAnchors(context, cursor);
				const node = new TestLazyTree(
					context,
					brand(JsonAsTree.JsonObject.identifier),
					cursor,
					anchorNode,
					anchor,
				);
				assert.deepEqual([...node.keys()], []);
			}
			{
				const { context, cursor } = readonlyTreeWithContent({
					schema: JsonAsTree.JsonObject,
					initialTree: { x: 5 },
				});
				cursor.enterNode(0);
				const { anchor, anchorNode } = createAnchors(context, cursor);
				const node = new TestLazyTree(
					context,
					brand(JsonAsTree.JsonObject.identifier),
					cursor,
					anchorNode,
					anchor,
				);
				assert.deepEqual([...node.keys()], ["x"]);
			}
		});

		it("leaf", () => {
			const { context, cursor } = readonlyTreeWithContent({
				schema: stringSchema,
				initialTree: "Hello world",
			});
			cursor.enterNode(0);

			const { anchor, anchorNode } = createAnchors(context, cursor);

			const node = new LazyTreeNode(
				context,
				brand(stringSchema.identifier),
				cursor,
				anchorNode,
				anchor,
			);

			assert.equal(node.value, "Hello world");
		});

		describe("fields", () => {
			const factory = new SchemaFactory("LazyNode-fields");
			class Item extends factory.object("Item", { value: factory.number }) {}
			class Holder extends factory.object("Holder", {
				item: factory.optional(Item),
				items: factory.array(Item),
			}) {}
			const config = new TreeViewConfiguration({ schema: Holder });

			function setup() {
				const view = getView(config);
				view.initialize({ item: { value: 1 }, items: [{ value: 2 }, { value: 3 }] });
				const node = getInnerNode(view.root);
				assert(node instanceof LazyTreeNode);
				const anchors = view.checkout.forest.anchors;
				let tracked = 0;
				const track = anchors.track.bind(anchors);
				anchors.track = (path) => {
					tracked++;
					return track(path);
				};
				return { view, node, anchors, trackCount: () => tracked };
			}

			it("tryGetField and getBoxed reuse the cached field without anchoring", () => {
				const { view, node, trackCount } = setup();
				const field = node.getBoxed(brand("items"));
				const afterFirstRead = trackCount();
				assert.equal(node.tryGetField(brand("items")), field);
				assert.equal(node.getBoxed(brand("items")), field);
				assert.equal(node.fields.get(brand("items")), field);
				assert.equal(trackCount(), afterFirstRead);
				view.dispose();
			});

			it("tryGetField returns undefined for an empty cached field", () => {
				const { view, node } = setup();
				const field = node.getBoxed(brand("item"));
				assert.equal(field.length, 1);
				view.root.item = undefined;
				assert.equal(node.tryGetField(brand("item")), undefined);
				assert.equal(node.getBoxed(brand("item")), field);
				view.root.item = new Item({ value: 4 });
				assert.equal(node.tryGetField(brand("item")), field);
				view.dispose();
			});

			it("reads an optional field holding a known node without a cursor at the field", () => {
				const { view, node } = setup();
				const item = view.root.item;
				assert(item !== undefined);
				const field = node.getBoxed(brand("item"));
				assert(field instanceof LazyField);
				// Edits release cursors.
				view.root.items.insertAtEnd({ value: 4 });
				assert.equal(field.holdsCursor, false);
				assert.equal(node.tryGetField(brand("item")), field);
				assert.equal(view.root.item, item);
				assert.equal(field.holdsCursor, false);

				// Emptying, filling, and replacing the field are seen.
				view.root.item = undefined;
				assert.equal(node.tryGetField(brand("item")), undefined);
				assert.equal(view.root.item, undefined);
				const replacement = new Item({ value: 5 });
				view.root.item = replacement;
				assert.equal(node.tryGetField(brand("item")), field);
				assert.equal(view.root.item, replacement);
				view.root.item = new Item({ value: 6 });
				assert.equal(view.root.item?.value, 6);
				assert.equal(Tree.status(replacement), TreeStatus.Removed);
				view.dispose();
			});

			it("anchors new fields and child nodes from the parent's anchor node", () => {
				const { view, anchors } = setup();
				const arrayNode = getInnerNode(view.root.items);
				assert(arrayNode instanceof LazyTreeNode);
				const field = arrayNode.getBoxed(EmptyKey);
				assert(field instanceof LazyField);
				assert(field.anchor.parent !== undefined);
				assert.equal(anchors.locate(field.anchor.parent), arrayNode.anchorNode);

				const unboxed = field.atIndex(0);
				assert(unboxed instanceof LazyTreeNode);
				assert.equal(unboxed.anchorNode.parent, arrayNode.anchorNode);
				assert.equal(anchors.locate(unboxed.anchor), unboxed.anchorNode);
				assert.equal(field.atIndex(0), unboxed);
				assert.equal(field.boxedAt(0), unboxed);

				// Fields and nodes keep working after edits move them.
				view.root.items.insertAt(0, { value: 0 });
				assert.equal(unboxed.anchorNode.parentIndex, 1);
				assert.equal(field.atIndex(1), unboxed);
				assert.equal(field.length, 3);
				assert.equal(view.root.items[1].value, 2);

				view.dispose();
				assert(anchors.isEmpty());
			});
		});
	});
});

function fieldToMapTree(field: FlexTreeField): MapTree[] {
	const results: MapTree[] = [];
	for (const child of field) {
		results.push(nodeToMapTree(child));
	}
	return results;
}

function nodeToMapTree(node: FlexTreeNode): MapTree {
	const fields: Map<FieldKey, MapTree[]> = new Map();
	for (const field of node) {
		fields.set(field.key, fieldToMapTree(field));
	}

	return { fields, type: node.type, value: node.value };
}
