/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, debugAssert } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import {
	CursorLocationType,
	EmptyKey,
	forbiddenFieldKindIdentifier,
	mapCursorField,
	mapCursorFields,
	type ITreeCursorSynchronous,
	type SchemaAndPolicy,
	type TreeChunk,
	type FieldKey,
	type TreeFieldStoredSchema,
	tryGetChunk,
} from "../../core/index.js";
import {
	basicChunkTree,
	defaultChunkPolicy,
	defaultSchemaPolicy,
	isFieldInSchema,
	TextRunChunk,
	throwOutOfSchema,
} from "../../feature-libraries/index.js";
import {
	ChunkedFieldContent,
	type Context,
	getInnerNode,
	getKernel,
	getOrCreateNodeFromInnerNode,
	type TreeNode,
	type Unhydrated,
	type UnhydratedFlexTreeField,
	UnhydratedFlexTreeNode,
	createField,
} from "../core/index.js";
import { getUnhydratedContext } from "../createContext.js";
import type { ImplicitFieldSchema, TreeFieldFromImplicitField } from "../fieldSchema.js";

import { unknownTypeError } from "./customTree.js";

/**
 * Creates an unhydrated simple-tree field from a cursor in nodes mode.
 * @remarks
 * Does not support providing missing defaults values.
 * Validates the field is in schema using `destinationSchema` the provided `contextForNewNodes` or the default unhydrated context if not provided.
 *
 * @param contentIsInSchema - True when the cursor's content is already known to be in `destinationSchema`,
 * in the stored schema of `contextForNewNodes`: for example, content read from a forest which uses that stored schema.
 * The content is then only validated in debug builds.
 */
export function createFromCursor<const TSchema extends ImplicitFieldSchema>(
	schema: TSchema,
	cursor: ITreeCursorSynchronous | undefined,
	destinationSchema: TreeFieldStoredSchema,
	contextForNewNodes?: Context,
	contentIsInSchema = false,
): Unhydrated<TreeFieldFromImplicitField<TSchema>> {
	const context = contextForNewNodes ?? getUnhydratedContext(schema);
	assert(context.flexContext.isHydrated() === false, 0xbfe /* Expected unhydrated context */);
	const mapTrees = cursor === undefined ? [] : [unhydratedFlexTreeFromCursor(context, cursor)];

	const schemaAndPolicy: SchemaAndPolicy = {
		policy: defaultSchemaPolicy,
		schema: context.flexContext.schema,
	};

	// Assuming the caller provides the correct `contextForNewNodes`, this should handle unknown optional fields.
	if (contentIsInSchema) {
		debugAssert(() => {
			isFieldInSchema(mapTrees, destinationSchema, schemaAndPolicy, throwOutOfSchema);
			return true;
		});
	} else {
		isFieldInSchema(mapTrees, destinationSchema, schemaAndPolicy, throwOutOfSchema);
	}

	if (mapTrees.length === 0) {
		return undefined as Unhydrated<TreeFieldFromImplicitField<TSchema>>;
	}
	assert(mapTrees.length === 1, 0xa11 /* unexpected field length */);
	// Length asserted above, so this is safe. This assert is done instead of checking for undefined after indexing to ensure a length greater than 1 also errors.
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const mapTree = mapTrees[0]!;

	return getOrCreateNodeFromInnerNode(mapTree) as Unhydrated<
		TreeFieldFromImplicitField<TSchema>
	>;
}

/**
 * Construct an {@link UnhydratedFlexTreeNode} from a cursor in Nodes mode.
 * @remarks
 * This does not fully validate the node is in schema, but does throw UsageErrors for some cases of out-of-schema content.
 *
 * Does not support unknown optional fields: will throw a UsageError if the field is not in schema.
 * This cannot easily be fixed as this code requires a schema for each subtree to process, and none is available for unknown optional fields.
 */
export function unhydratedFlexTreeFromCursor(
	context: Context,
	cursor: ITreeCursorSynchronous,
): UnhydratedFlexTreeNode {
	assert(cursor.mode === CursorLocationType.Nodes, 0xbb4 /* Expected nodes cursor */);
	const identifier = cursor.type;
	const storedSchema =
		context.flexContext.schema.nodeSchema.get(identifier) ?? unknownTypeError(identifier);

	const fields = new Map(
		mapCursorFields(cursor, () => {
			const fieldSchema = storedSchema.getFieldSchema(cursor.getFieldKey());
			if (fieldSchema.kind === forbiddenFieldKindIdentifier) {
				// Check for unexpected fields before recursing into children:
				// Code which hits this case is very likely to also use an unknown type in the unexpected field, which would give a more confusing error message.
				// This case is detected here to improve error quality.
				// Also note that if using the view schema from above to suppress this error for unknownOptionalFields, that would not provide a way to handle unknown types in those fields:
				// they would still error, but with that more confusing message about unknown types.
				throw new UsageError(
					// Using JSON.stringify to handle quoting and escaping since both key and identifier can technically contain quotes themselves.
					`Field ${JSON.stringify(cursor.getFieldKey())} is not defined in the schema ${JSON.stringify(identifier)}.`,
				);
			}
			const key = cursor.getFieldKey();
			const chunks = copyFieldWithTextRuns(cursor);
			return [
				key,
				createField(
					context.flexContext,
					fieldSchema.kind,
					key,
					chunks === undefined
						? mapCursorField(cursor, () => unhydratedFlexTreeFromCursor(context, cursor))
						: new ChunkedFieldContent(chunks, (fieldCursor) =>
								mapCursorField(fieldCursor, () =>
									unhydratedFlexTreeFromCursor(context, fieldCursor),
								),
							),
				),
			];
		}),
	);
	return new UnhydratedFlexTreeNode(
		{ type: cursor.type, value: cursor.value },
		fields,
		context,
	);
}

/**
 * If the field `cursor` is in (in fields mode) holds a {@link TextRunChunk}, returns chunks holding a copy of the field,
 * with the field's text runs kept as runs, each with a reference owned by the caller. Otherwise returns undefined.
 * Leaves the cursor in the field.
 */
function copyFieldWithTextRuns(cursor: ITreeCursorSynchronous): TreeChunk[] | undefined {
	let hasTextRun = false;
	for (let inField = cursor.firstNode(); inField; inField = cursor.nextNode()) {
		if (tryGetChunk(cursor) instanceof TextRunChunk) {
			hasTextRun = true;
			cursor.exitNode();
			break;
		}
	}
	if (!hasTextRun) {
		return undefined;
	}
	const chunks: TreeChunk[] = [];
	let inField = cursor.firstNode();
	while (inField) {
		const chunk = tryGetChunk(cursor);
		if (chunk instanceof TextRunChunk) {
			const within = cursor.fieldIndex - cursor.chunkStart;
			const count = cursor.chunkLength - within;
			if (within === 0) {
				chunk.referenceAdded();
				chunks.push(chunk);
			} else {
				chunks.push(chunk.slice(within, within + count));
			}
			inField = cursor.seekNodes(count);
		} else {
			chunks.push(basicChunkTree(cursor, chunkCopyPolicy));
			inField = cursor.nextNode();
		}
	}
	return chunks;
}

/**
 * Policy for copying content into chunks outside of a forest.
 */
const chunkCopyPolicy = { policy: defaultChunkPolicy, idCompressor: undefined };

/**
 * Makes `chunks` the content of the array node `array`, which must be unhydrated, empty, and not yet observed.
 * @remarks
 * The array holds its content as these chunks (see {@link ChunkedFieldContent}) until something reads its nodes.
 * Takes ownership of one reference to each chunk.
 * The chunks must be in schema for the array and must not contain content with pending defaults.
 */
export function initializeArrayWithChunks(
	array: TreeNode,
	chunks: readonly TreeChunk[],
): void {
	const inner = getKernel(array).getInnerNodeIfUnhydrated();
	assert(inner !== undefined, "Only an unhydrated array can be initialized with chunks");
	const context = inner.simpleContext;
	inner
		.getBoxed(EmptyKey)
		.initializeWithChunks(
			new ChunkedFieldContent(chunks, (cursor) =>
				mapCursorField(cursor, () => unhydratedFlexTreeFromCursor(context, cursor)),
			),
		);
}

/**
 * Returns a function which creates copies of `node`'s content (as it is now), each an unhydrated node of `node`'s schema.
 * @remarks
 * The content is copied into chunks once. Each copy is one node object whose fields hold those chunks by reference
 * (see {@link ChunkedFieldContent}): nodes below it are created only when read,
 * and inserting a copy into a tree inserts the chunks as they are.
 * Copies are independent: editing one does not affect the others.
 * The content must not contain fields with pending defaults (such as identifiers yet to be generated).
 */
export function createCopier<T extends TreeNode>(node: T): () => T {
	const kernel = getKernel(node);
	const context = getUnhydratedContext(kernel.schema);
	const cursor = getInnerNode(node).borrowCursor();
	const chunk = basicChunkTree(cursor, chunkCopyPolicy);
	const storedSchema =
		context.flexContext.schema.nodeSchema.get(chunk.type) ?? unknownTypeError(chunk.type);
	return () => {
		const fields = new Map<FieldKey, UnhydratedFlexTreeField>();
		for (const [key, chunks] of chunk.fields) {
			for (const child of chunks) {
				child.referenceAdded();
			}
			fields.set(
				key,
				createField(
					context.flexContext,
					storedSchema.getFieldSchema(key).kind,
					key,
					new ChunkedFieldContent(chunks, (fieldCursor) =>
						mapCursorField(fieldCursor, () =>
							unhydratedFlexTreeFromCursor(context, fieldCursor),
						),
					),
				),
			);
		}
		const copy = new UnhydratedFlexTreeNode(
			{ type: chunk.type, value: chunk.value },
			fields,
			context,
		);
		return getOrCreateNodeFromInnerNode(copy) as T;
	};
}
