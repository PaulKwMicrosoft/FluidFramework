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
	rootFieldKey,
} from "../../../core/index.js";
import type { Context } from "../../../feature-libraries/flex-tree/context.js";
import { LazyField } from "../../../feature-libraries/flex-tree/lazyField.js";
import { LazyTreeNode } from "../../../feature-libraries/flex-tree/lazyNode.js";
import type { FlexTreeField, FlexTreeNode } from "../../../feature-libraries/index.js";
import { JsonAsTree } from "../../../jsonDomainSchema.js";
import {
	getInnerNode,
	SchemaFactory,
	TreeViewConfiguration,
} from "../../../simple-tree/index.js";
import { stringSchema } from "../../../simple-tree/leafNodeSchema.js";
import { brand } from "../../../util/index.js";
import { getView } from "../../utils.js";

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
