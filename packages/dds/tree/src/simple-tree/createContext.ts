/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";

import type { TreeFieldStoredSchema } from "../core/index.js";
import { defaultSchemaPolicy } from "../feature-libraries/index.js";
import { getOrCreate } from "../util/index.js";

import {
	Context,
	getTreeNodeSchemaPrivateData,
	UnhydratedContext,
	type TreeNodeSchema,
	type TreeNodeSchemaInitializedData,
} from "./core/index.js";
import { normalizeFieldSchema, type ImplicitFieldSchema } from "./fieldSchema.js";
import {
	hasStagedSchemaUpgrades,
	toStoredFieldSchema,
	toStoredSchema,
	toUnhydratedSchema,
} from "./toStoredSchema.js";
import type { TreeSchema } from "./treeSchema.js";

const contextCache: WeakMap<ImplicitFieldSchema, Context> = new WeakMap();

/**
 * For node schemas which share the unhydrated context of a tree schema's root (see {@link shareUnhydratedContext}), that root.
 */
const sharedContextRoots: WeakMap<ImplicitFieldSchema, ImplicitFieldSchema> = new WeakMap();

/**
 * Lets every node schema in `treeSchema` use the unhydrated context of `treeSchema`'s root,
 * instead of each generating a stored schema for its own subtree.
 * @remarks
 * Unhydrated contexts always generate stored schema with {@link toUnhydratedSchema},
 * which gives a node schema the same stored schema whichever root it is reached from.
 * The root's context therefore holds the same stored schema for each node schema as that node schema's own context would,
 * plus the rest of the tree schema's node schemas, which content of the node schema cannot use as its validation goes by its own fields.
 *
 * This is only done for tree schemas with no staged upgrades (see {@link hasStagedSchemaUpgrades}).
 * Node schemas which already have an unhydrated context, or which were already shared by another tree schema, keep it.
 */
export function shareUnhydratedContext(treeSchema: TreeSchema): void {
	if (hasStagedSchemaUpgrades(treeSchema)) {
		return;
	}
	for (const nodeSchema of treeSchema.definitions.values()) {
		if (!contextCache.has(nodeSchema) && !sharedContextRoots.has(nodeSchema)) {
			sharedContextRoots.set(nodeSchema, treeSchema.root);
		}
	}
}

/**
 * See note in {@link getUnhydratedContext}.
 */
let getUnhydratedContextIsRunning = false;

/**
 * Utility for creating {@link Context}s for unhydrated nodes.
 * @remarks
 * The resulting context will not allow any unknown optional fields.
 *
 * The context may be shared with other schemas (see {@link shareUnhydratedContext}),
 * so its root field schema is not necessarily `schema`: use {@link getUnhydratedRootFieldSchema} for that.
 */
export function getUnhydratedContext(schema: ImplicitFieldSchema): Context {
	// Due to caching, calling this reentrantly can cause issues.
	// Due to recursive schema, and generally lots of lazy initialization code depending on this, bugs with this going reentrant are not uncommon.
	// To make debugging such cases much easier, we assert that this is not called reentrantly.
	assert(
		!getUnhydratedContextIsRunning,
		0xca7 /* getUnhydratedContext should not be reentrant */,
	);
	getUnhydratedContextIsRunning = true;
	try {
		const contextSchema = sharedContextRoots.get(schema) ?? schema;
		return getOrCreate(contextCache, contextSchema, (s) => {
			const normalized = normalizeFieldSchema(contextSchema);

			const flexContext = new UnhydratedContext(
				defaultSchemaPolicy,
				toStoredSchema(contextSchema, toUnhydratedSchema),
			);
			return new Context(
				flexContext,
				Context.schemaMapFromRootSchema(normalized.allowedTypesFull.evaluate()),
			);
		});
	} finally {
		getUnhydratedContextIsRunning = false;
	}
}

/**
 * The stored schema, in the unhydrated context of `schema` (see {@link getUnhydratedContext}), of a field holding content of `schema`.
 */
export function getUnhydratedRootFieldSchema(
	schema: ImplicitFieldSchema,
): TreeFieldStoredSchema {
	return toStoredFieldSchema(normalizeFieldSchema(schema), toUnhydratedSchema);
}

/**
 * Utility for creating {@link TreeNodeSchemaInitializedData}.
 */
export function getTreeNodeSchemaInitializedData(
	schema: TreeNodeSchema,
	handler: Pick<TreeNodeSchemaInitializedData, "toFlexContent" | "shallowCompatibilityTest">,
): TreeNodeSchemaInitializedData {
	const data = getTreeNodeSchemaPrivateData(schema);
	return {
		...handler,
		context: getUnhydratedContext(schema),
		childAllowedTypes: data.childAllowedTypes.map((t) => t.evaluate()),
	};
}
