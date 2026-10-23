/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";

import type { TreeFieldStoredSchema } from "../core/index.js";
import { defaultSchemaPolicy } from "../feature-libraries/index.js";

import {
	Context,
	getTreeNodeSchemaPrivateData,
	UnhydratedContext,
	type TreeNodeSchema,
	type TreeNodeSchemaInitializedData,
} from "./core/index.js";
import { normalizeFieldSchema, type ImplicitFieldSchema } from "./fieldSchema.js";
import { toStoredFieldSchema, toStoredSchema, toUnhydratedSchema } from "./toStoredSchema.js";
import { getSchemaDerivedData, tryGetSchemaDerivedData } from "./treeSchema.js";

/**
 * The contexts created by {@link getUnhydratedContext}.
 */
const generatedContexts: WeakSet<Context> = new WeakSet();

/**
 * Returns true if `context` was created by {@link getUnhydratedContext}.
 * @remarks
 * The stored schema of such a context is generated from view schema with {@link toUnhydratedSchema}:
 * for each of its schema classes, it holds the node schema generated from that class, with all staged types allowed and no unknown optional fields.
 * Other unhydrated contexts, like those of cloned nodes, use the stored schema of the tree the content came from.
 */
export function isGeneratedUnhydratedContext(context: Context): boolean {
	return generatedContexts.has(context);
}

/**
 * For node schemas which share the unhydrated context of a root (see {@link shareUnhydratedContext}), that root.
 */
const sharedContextRoots = new WeakMap<ImplicitFieldSchema, ImplicitFieldSchema>();

/**
 * Lets every node schema reachable from `root` use the unhydrated context of `root`,
 * rather than each deriving its own schema lookup maps and context.
 * @remarks
 * Unhydrated contexts always generate stored schema with {@link toUnhydratedSchema},
 * which gives a node schema the same stored schema whichever root it is reached from.
 * The root's context therefore holds the same stored schema for each node schema as that node schema's own context would,
 * plus the rest of the root's node schemas, which content of the node schema cannot use as its validation goes by its own fields.
 *
 * This is only done for roots without staged upgrades (as reported by {@link getSchemaDerivedData}).
 * Node schemas which already have an unhydrated context, or which already share another root's context, keep it.
 *
 * {@link getSchemaDerivedData} caches by root identity, so passing the root a configuration was created from
 * lets the shared context use the configuration's definitions map rather than building another.
 */
export function shareUnhydratedContext(root: ImplicitFieldSchema): void {
	const { hasStagedSchema, treeSchema } = getSchemaDerivedData(root);
	if (hasStagedSchema) {
		return;
	}
	for (const nodeSchema of treeSchema.definitions.values()) {
		if (
			tryGetSchemaDerivedData(nodeSchema)?.unhydratedContext === undefined &&
			!sharedContextRoots.has(nodeSchema)
		) {
			sharedContextRoots.set(nodeSchema, root);
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
 * {@link getSchemaDerivedData} owns the shared root cache; this function fills its context slot only after construction succeeds.
 * The cached graph supplies the context's node lookup map without another traversal or map copy.
 * Contexts remain root-specific even when their immutable schema lookup maps are shared,
 * except that node schemas may share the context of a root which reaches them (see {@link shareUnhydratedContext}).
 * The root field schema of the resulting context is therefore not necessarily `schema`: use {@link getUnhydratedRootFieldSchema} for that.
 *
 * {@link toStoredSchema} uses the same analysis but a separate policy-specific result cache.
 * Analysis must not initialize contexts because context construction calls stored-schema generation.
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
		const data = getSchemaDerivedData(contextSchema);
		if (data.unhydratedContext === undefined) {
			const flexContext = new UnhydratedContext(
				defaultSchemaPolicy,
				toStoredSchema(contextSchema, toUnhydratedSchema),
			);
			const context = new Context(flexContext, data.treeSchema.definitions);
			generatedContexts.add(context);
			data.unhydratedContext = context;
		}
		return data.unhydratedContext;
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
 * @remarks
 * Node-specific conversion handlers and evaluated child types belong to this initialization data.
 * Its context is shared through {@link getUnhydratedContext} and {@link getSchemaDerivedData}, which also support field and union roots.
 * Stored-schema generation can access root analysis without invoking node initialization.
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
