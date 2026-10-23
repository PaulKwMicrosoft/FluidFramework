/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import type { TreeNodeSchemaIdentifier } from "../../core/index.js";
import {
	FieldKinds,
	type FlexTreeHydratedContextMinimal,
} from "../../feature-libraries/index.js";
import {
	createIndependentTreeAlpha,
	independentView,
	type SchematizingSimpleTreeView,
	TreeAlpha,
	TreeBeta,
} from "../../shared-tree/index.js";
import {
	getKernel,
	SchemaFactoryAlpha,
	type TreeNode,
	type TreeViewAlpha,
	TreeViewConfiguration,
	type ImplicitFieldSchema,
} from "../../simple-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { UnhydratedFlexTreeNode } from "../../simple-tree/core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { isKnownInStoredSchema } from "../../simple-tree/prepareForInsertion.js";
import { brand } from "../../util/index.js";

function knownInSchema(view: object, node: TreeNode, allowedType: string): boolean {
	const inner = getKernel(node).getInnerNodeIfUnhydrated() as UnhydratedFlexTreeNode;
	const checkout = (view as unknown as SchematizingSimpleTreeView<ImplicitFieldSchema>)
		.checkout;
	return isKnownInStoredSchema(
		[inner],
		{
			kind: FieldKinds.sequence.identifier,
			types: new Set([brand<TreeNodeSchemaIdentifier>(allowedType)]),
			persistedMetadata: undefined,
		},
		{ checkout } as unknown as FlexTreeHydratedContextMinimal,
	);
}

describe("isKnownInStoredSchema", () => {
	const factory = new SchemaFactoryAlpha("known");
	class Point extends factory.object("Point", { x: factory.number, y: factory.number }) {}
	class Points extends factory.array("Points", Point) {}

	function pointsView(): TreeViewAlpha<typeof Points> {
		const view = independentView(new TreeViewConfiguration({ schema: Points }));
		view.initialize([]);
		return view;
	}

	it("is true for constructed and imported content of the view's schema", () => {
		const view = pointsView();
		assert.equal(knownInSchema(view, new Point({ x: 1, y: 2 }), Point.identifier), true);
		const imported = TreeAlpha.importVerbose(Point, {
			type: Point.identifier,
			fields: { x: 1, y: 2 },
		});
		assert.equal(knownInSchema(view, imported, Point.identifier), true);
	});

	it("is false for types the destination field doesn't allow", () => {
		const view = pointsView();
		assert.equal(knownInSchema(view, new Point({ x: 1, y: 2 }), Points.identifier), false);
	});

	it("is false for cloned content", () => {
		const view = pointsView();
		view.root.insertAtEnd(new Point({ x: 1, y: 2 }));
		const clone = TreeBeta.clone<typeof Point>(view.root[0] ?? assert.fail());
		assert.equal(knownInSchema(view, clone, Point.identifier), false);
	});

	it("is false for another schema class with the same identifier", () => {
		const view = pointsView();
		const otherFactory = new SchemaFactoryAlpha("known");
		class OtherPoint extends otherFactory.object("Point", {
			x: otherFactory.number,
			y: otherFactory.number,
		}) {}
		assert.equal(knownInSchema(view, new OtherPoint({ x: 1, y: 2 }), Point.identifier), false);
	});

	it("is false for views with staged upgrades", () => {
		const stagedFactory = new SchemaFactoryAlpha("staged");
		class Label extends stagedFactory.object("Label", { text: stagedFactory.string }) {}
		class Item extends stagedFactory.object("Item", {
			value: stagedFactory.types([stagedFactory.number, stagedFactory.staged(Label)]),
		}) {}
		class Items extends stagedFactory.array("Items", Item) {}
		const view = independentView(new TreeViewConfiguration({ schema: Items }));
		view.initialize([]);
		assert.equal(knownInSchema(view, new Item({ value: 1 }), Item.identifier), false);
		// Staged types the document's stored schema doesn't allow are still rejected.
		assert.throws(
			() => view.root.insertAtEnd(new Item({ value: new Label({ text: "a" }) })),
			validateUsageError(/schema/i),
		);
	});

	it("is false for documents whose stored schema differs from the view schema", () => {
		const oldFactory = new SchemaFactoryAlpha("evolving");
		class OldItem extends oldFactory.object("Item", {
			value: oldFactory.number,
			note: oldFactory.optional(oldFactory.string),
		}) {}
		class OldItems extends oldFactory.array("Items", OldItem) {}

		const newFactory = new SchemaFactoryAlpha("evolving");
		class NewItem extends newFactory.objectAlpha(
			"Item",
			{ value: newFactory.number },
			{ allowUnknownOptionalFields: true },
		) {}
		class NewItems extends newFactory.array("Items", NewItem) {}

		const tree = createIndependentTreeAlpha();
		const oldView = tree.viewWith(new TreeViewConfiguration({ schema: OldItems }));
		oldView.initialize([new OldItem({ value: 1, note: "unknown to the new schema" })]);
		oldView.dispose();
		const view = tree.viewWith(new TreeViewConfiguration({ schema: NewItems }));
		assert.equal(view.compatibility.canView, true);
		assert.equal(view.compatibility.isEquivalent, false);
		assert.equal(knownInSchema(view, new NewItem({ value: 2 }), NewItem.identifier), false);
	});

	it("still rejects clones with unknown optional fields inserted into another tree", () => {
		const oldFactory = new SchemaFactoryAlpha("clones");
		class OldItem extends oldFactory.object("Item", {
			value: oldFactory.number,
			note: oldFactory.optional(oldFactory.string),
		}) {}
		class OldItems extends oldFactory.array("Items", OldItem) {}

		const newFactory = new SchemaFactoryAlpha("clones");
		class NewItem extends newFactory.objectAlpha(
			"Item",
			{ value: newFactory.number },
			{ allowUnknownOptionalFields: true },
		) {}
		class NewItems extends newFactory.array("Items", NewItem) {}

		const sourceTree = createIndependentTreeAlpha();
		const source = sourceTree.viewWith(new TreeViewConfiguration({ schema: OldItems }));
		source.initialize([new OldItem({ value: 1, note: "unknown to the new schema" })]);
		source.dispose();
		const sourceAsNew = sourceTree.viewWith(new TreeViewConfiguration({ schema: NewItems }));
		const clone = TreeBeta.clone<typeof NewItem>(sourceAsNew.root[0] ?? assert.fail());

		const destination = independentView(new TreeViewConfiguration({ schema: NewItems }));
		destination.initialize([]);
		assert.equal(destination.compatibility.isEquivalent, true);
		assert.throws(() => destination.root.insertAtEnd(clone), validateUsageError(/schema/i));
	});
});
