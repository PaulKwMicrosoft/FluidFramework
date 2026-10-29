/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import { TreeStoredSchemaRepository } from "../../../core/index.js";
import {
	defaultSchemaPolicy,
	isFieldInSchema,
	SchemaValidationError,
} from "../../../feature-libraries/index.js";
import {
	createIndependentTreeAlpha,
	independentView,
	TreeAlpha,
} from "../../../shared-tree/index.js";
import {
	createCopier,
	createFromCursor,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../simple-tree/api/create.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { UnhydratedFlexTreeNode } from "../../../simple-tree/core/index.js";
import {
	getKernel,
	StagedSchemaUpgradePolicy,
	SchemaFactory,
	SchemaFactoryAlpha,
	toStoredSchema,
	type TreeNode,
	TreeViewConfiguration,
} from "../../../simple-tree/index.js";
import { singleJsonCursor } from "../../json/index.js";

describe("simple-tree create", () => {
	describe("createFromCursor", () => {
		it("Success", () => {
			const cursor = singleJsonCursor("Hello world");
			createFromCursor(
				SchemaFactory.string,
				cursor,
				toStoredSchema(SchemaFactory.string, StagedSchemaUpgradePolicy.restrictive)
					.rootFieldSchema,
			);
		});

		it("Failure: unknown schema", () => {
			const cursor = singleJsonCursor("Hello world");
			assert.throws(
				() =>
					createFromCursor(
						SchemaFactory.number,
						cursor,
						toStoredSchema(SchemaFactory.number, StagedSchemaUpgradePolicy.restrictive)
							.rootFieldSchema,
					),
				validateUsageError(
					`Failed to parse tree due to occurrence of type "com.fluidframework.leaf.string" which is not defined in this context.`,
				),
			);
		});

		it("Failure: out of schema", () => {
			const factory = new SchemaFactory("test");
			class Obj extends factory.object("Obj", { x: SchemaFactory.string }) {}
			const cursor = singleJsonCursor("Hello world");
			assert.throws(
				() =>
					createFromCursor(
						Obj,
						cursor,
						toStoredSchema(Obj, StagedSchemaUpgradePolicy.restrictive).rootFieldSchema,
					),
				validateUsageError(/does not conform to schema/),
			);
		});
	});

	describe("createCopier", () => {
		const oldFactory = new SchemaFactoryAlpha("copies");
		class OldItem extends oldFactory.object("Item", {
			value: oldFactory.number,
			note: oldFactory.optional(oldFactory.string),
		}) {}
		class OldItems extends oldFactory.array("Items", OldItem) {}
		class OldHolder extends oldFactory.object("Holder", { item: OldItem }) {}

		const newFactory = new SchemaFactoryAlpha("copies");
		class NewItem extends newFactory.objectAlpha(
			"Item",
			{ value: newFactory.number },
			{ allowUnknownOptionalFields: true },
		) {}
		class NewItems extends newFactory.array("Items", NewItem) {}
		class NewHolder extends newFactory.object("Holder", { item: NewItem }) {}

		/**
		 * A view with schema `NewItems` of a tree whose stored schema is `OldItems`, holding `content`.
		 */
		function viewOfOldItems(content: readonly OldItem[]): ReturnType<typeof newItemsView> {
			const tree = createIndependentTreeAlpha();
			const oldView = tree.viewWith(new TreeViewConfiguration({ schema: OldItems }));
			oldView.initialize([...content]);
			oldView.dispose();
			return newItemsView(tree);
		}

		function newItemsView(tree: ReturnType<typeof createIndependentTreeAlpha>) {
			const view = tree.viewWith(new TreeViewConfiguration({ schema: NewItems }));
			assert.equal(view.compatibility.canView, true);
			return view;
		}

		it("checks each copy against the stored schema of the tree it is inserted into", () => {
			const source = viewOfOldItems([new OldItem({ value: 1, note: "unknown to NewItem" })]);
			const copy = TreeAlpha.copier(source.root[0] ?? assert.fail());

			const accepting = viewOfOldItems([]);
			accepting.root.insertAtEnd(copy());
			accepting.root.insertAtEnd(copy());

			const rejecting = independentView(new TreeViewConfiguration({ schema: NewItems }));
			rejecting.initialize([]);
			assert.throws(() => rejecting.root.insertAtEnd(copy()), validateUsageError(/schema/i));
			assert.equal(rejecting.root.length, 0);

			accepting.root.insertAtEnd(copy());
			assert.equal(accepting.root.length, 3);
		});

		it("checks every copy of shared content, including against a stored schema which accepted another copy", () => {
			const copy = createCopier(
				new OldHolder({ item: new OldItem({ value: 1, note: "unknown to NewItem" }) }),
			);
			const oldStored = toStoredSchema(OldHolder, StagedSchemaUpgradePolicy.restrictive);
			const stored = new TreeStoredSchemaRepository(oldStored);
			const schemaAndPolicy = { schema: stored, policy: defaultSchemaPolicy };
			const check = (node: TreeNode): SchemaValidationError | undefined =>
				isFieldInSchema(
					[getKernel(node).getInnerNodeIfUnhydrated() as UnhydratedFlexTreeNode],
					oldStored.rootFieldSchema,
					schemaAndPolicy,
					(details) => details.error,
				);

			assert.equal(check(copy()), undefined);
			assert.equal(check(copy()), undefined);
			stored.apply(toStoredSchema(NewHolder, StagedSchemaUpgradePolicy.restrictive));
			assert.equal(check(copy()), SchemaValidationError.ObjectNode_FieldNotInSchema);
		});
	});
});
