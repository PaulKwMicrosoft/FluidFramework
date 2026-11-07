/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import {
	ObjectNodeStoredSchema,
	type FieldKey,
	type TreeChunk,
	type TreeFieldStoredSchema,
	type UpPath,
} from "../../core/index.js";
import {
	combineChunks,
	cursorForMapTreeField,
	FieldKinds,
	inPlaceValueChange,
	TreeStatus,
	type FieldSet,
	type FlexTreeField,
	type FlexTreeHydratedContext,
	type HydratedFlexTreeNode,
} from "../../feature-libraries/index.js";
import { brand } from "../../util/index.js";
import { getInnerNode, getKernel, type TreeNode } from "../core/index.js";
import type { FieldSchema } from "../fieldSchema.js";
import { isObjectNodeSchema } from "../node-kinds/index.js";
import { prepareForInsertionBatch } from "../prepareForInsertion.js";
import type { InsertableContent } from "../unhydratedFlexTreeFromInsertable.js";

/**
 * A property of an object node, and the value to set it to, for {@link (TreeAlpha:interface).setFields}.
 * @alpha
 */
export type FieldAssignment = readonly [
	node: TreeNode,
	key: string,
	value: InsertableContent | undefined,
];

/**
 * A resolved {@link FieldAssignment}.
 */
interface ResolvedAssignment {
	readonly inner: HydratedFlexTreeNode;
	readonly storedKey: FieldKey;
	readonly schema: FieldSchema;
	readonly value: InsertableContent | undefined;
}

/**
 * Implementation of {@link (TreeAlpha:interface).setFields}.
 */
export function setFields(assignments: readonly FieldAssignment[]): void {
	let context: FlexTreeHydratedContext | undefined;
	// The fields set, by the anchor of their parent node.
	const targets = new Map<UpPath, Set<FieldKey>>();
	const resolved: ResolvedAssignment[] = [];
	for (const [node, key, value] of assignments) {
		const kernel = getKernel(node);
		const schema = kernel.schema;
		if (!isObjectNodeSchema(schema)) {
			throw new UsageError("setFields can only set properties of object nodes.");
		}
		const fieldSchema = schema.fields.get(key);
		if (fieldSchema === undefined) {
			throw new UsageError(
				`${JSON.stringify(key)} is not a property of ${schema.identifier}.`,
			);
		}
		if (kernel.getStatus() !== TreeStatus.InDocument) {
			throw new UsageError("setFields requires nodes in the document of a tree.");
		}
		const inner = getInnerNode(node);
		assert(inner.isHydrated(), "A node in the document must be hydrated");
		if (context === undefined) {
			context = inner.context;
		} else if (inner.context !== context) {
			throw new UsageError("setFields requires nodes in the same tree.");
		}
		const storedKey: FieldKey = brand(fieldSchema.storedKey);
		let keys = targets.get(inner.anchorNode);
		if (keys === undefined) {
			keys = new Set();
			targets.set(inner.anchorNode, keys);
		} else if (keys.has(storedKey)) {
			throw new UsageError(
				`setFields was given the property ${JSON.stringify(key)} of the same node more than once.`,
			);
		}
		keys.add(storedKey);
		resolved.push({ inner, storedKey, schema: fieldSchema, value });
	}
	if (context === undefined) {
		return;
	}

	// Fields are identified by their paths before the edit, so no node whose property is set may be in content replaced by the same edit.
	for (const { inner } of resolved) {
		for (
			let path: UpPath | undefined = inner.anchorNode;
			path !== undefined;
			path = path.parent
		) {
			if (
				path.parent !== undefined &&
				targets.get(path.parent)?.has(path.parentField) === true
			) {
				throw new UsageError(
					"setFields cannot set a property of a node which is under a property set by the same call.",
				);
			}
		}
	}

	const items: {
		readonly assignment: ResolvedAssignment;
		readonly destinationSchema: TreeFieldStoredSchema;
		readonly field: FlexTreeField | undefined;
		readonly wasEmpty: boolean;
	}[] = [];
	for (const assignment of resolved) {
		const { inner, storedKey, value } = assignment;
		const storedSchema = context.schema.nodeSchema.get(inner.type);
		assert(storedSchema instanceof ObjectNodeStoredSchema, "Expected ObjectNodeStoredSchema");
		const destinationSchema = storedSchema.getFieldSchema(storedKey);
		const kind = destinationSchema.kind;
		// A required field is never empty, so it is only read when its leaf may be changed in place.
		const field =
			kind !== FieldKinds.required.identifier || context.checkout.editor.inPlaceValueChanges
				? inner.tryGetField(storedKey)
				: undefined;
		const wasEmpty = kind !== FieldKinds.required.identifier && field === undefined;
		if (value === undefined && wasEmpty) {
			continue;
		}
		if (kind !== FieldKinds.required.identifier && kind !== FieldKinds.optional.identifier) {
			throw new UsageError(`The property ${JSON.stringify(storedKey)} cannot be set.`);
		}
		items.push({ assignment, destinationSchema, field, wasEmpty });
	}

	const prepared = prepareForInsertionBatch(
		items.map(({ assignment: { schema, value }, destinationSchema }) => ({
			data: value,
			schema,
			destinationSchema,
		})),
		context,
	);

	const { editor, forest } = context.checkout;
	const sets = items.map(
		(
			{ assignment: { inner, storedKey }, destinationSchema, field: currentField, wasEmpty },
			index,
		): FieldSet<TreeChunk> => {
			const content = prepared[index];
			const field = { parent: inner.anchorNode, field: storedKey };
			if (content !== undefined && currentField !== undefined) {
				const change = inPlaceValueChange(currentField, destinationSchema, content);
				if (change !== undefined) {
					return { kind: "value", field, change };
				}
			}
			const chunk: TreeChunk | undefined =
				content === undefined
					? undefined
					: combineChunks(forest.chunkField(cursorForMapTreeField([content])));
			if (destinationSchema.kind === FieldKinds.required.identifier) {
				assert(chunk !== undefined, "A required field must have been checked to have content");
				return { kind: "required", field, content: chunk } satisfies FieldSet<TreeChunk>;
			}
			return {
				kind: "optional",
				field,
				content: chunk,
				wasEmpty,
			} satisfies FieldSet<TreeChunk>;
		},
	);
	editor.setFields(sets);
}
