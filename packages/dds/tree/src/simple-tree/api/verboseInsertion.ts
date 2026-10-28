/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { ITelemetryBaseProperties } from "@fluidframework/core-interfaces";
import { assert, fail } from "@fluidframework/core-utils/internal";
import { isFluidHandle } from "@fluidframework/runtime-utils/internal";
import { tagSchemaArtifacts, UsageError } from "@fluidframework/telemetry-utils/internal";

import {
	aboveRootPlaceholder,
	EmptyKey,
	identifierFieldKindIdentifier,
	keyAsDetachedField,
	LeafNodeStoredSchema,
	MapNodeStoredSchema,
	ObjectNodeStoredSchema,
	ValueSchema,
	type FieldKey,
	type IForestSubscription,
	type SchemaAndPolicy,
	type TreeChunk,
	type TreeFieldStoredSchema,
	type TreeNodeStoredSchema,
	type TreeTypeSet,
} from "../../core/index.js";
import {
	allowsValue,
	chunkFieldForForest,
	forestKeepsChunks,
	verboseTextRun,
	type VerboseTextRun,
	combineChunks,
	compliesWithMultiplicity,
	FieldKinds,
	getSchemaAndPolicy,
	SchemaValidationError,
	throwOutOfSchema,
	TreeStatus,
	type FlexTreeHydratedContext,
	type HydratedFlexTreeNode,
} from "../../feature-libraries/index.js";
import { brand, validateIndex } from "../../util/index.js";
import { getInnerNode, getKernel, NodeKind, type TreeNode } from "../core/index.js";
import { isObjectNodeSchema } from "../node-kinds/index.js";

import { verboseTreeAdapter, type VerboseTree, type VerboseTreeNode } from "./verboseTree.js";

/**
 * Reads {@link VerboseTree} data whose object nodes use stored keys.
 */
const storedKeyAdapter = verboseTreeAdapter({});

/**
 * Implementation of {@link (TreeAlpha:interface).insertVerbose}.
 */
export function insertVerbose(
	array: TreeNode,
	index: number,
	content: readonly VerboseTree[],
): void {
	const flexNode = getFlexNodeInDocument(array, "insertVerbose");
	if (getKernel(array).schema.kind !== NodeKind.Array) {
		throw new UsageError(
			"insertVerbose requires an array node: use setVerbose for other nodes.",
		);
	}
	const field = flexNode.getBoxed(EmptyKey);
	validateIndex(index, field, "TreeAlpha.insertVerbose", true);
	const fieldSchema = getStoredSchema(flexNode).getFieldSchema(EmptyKey);
	const checked = new VerboseContentChecker(flexNode.context).checkChildren(
		content,
		fieldSchema.types,
	);
	const { editor, forest } = flexNode.context.checkout;
	editor
		.sequenceField(field.getFieldPath())
		.insert(index, combineChunks(chunkVerboseContent(forest, checked)));
}

/**
 * Implementation of {@link (TreeAlpha:interface).setVerbose}.
 */
export function setVerbose(
	parent: TreeNode,
	key: string,
	content: VerboseTree | undefined,
): void {
	const flexNode = getFlexNodeInDocument(parent, "setVerbose");
	const schema = getKernel(parent).schema;
	let storedKey: FieldKey;
	switch (schema.kind) {
		case NodeKind.Object: {
			assert(isObjectNodeSchema(schema), "Expected object schema");
			const fieldSchema = schema.fields.get(key);
			if (fieldSchema === undefined) {
				throw new UsageError(
					`${JSON.stringify(key)} is not a property of ${schema.identifier}.`,
				);
			}
			storedKey = brand(fieldSchema.storedKey);
			break;
		}
		case NodeKind.Map:
		case NodeKind.Record: {
			storedKey = brand(key);
			break;
		}
		default: {
			throw new UsageError(
				"setVerbose requires an object, map or record node: use insertVerbose for array nodes.",
			);
		}
	}

	const field = flexNode.getBoxed(storedKey);
	const required = field.schema === FieldKinds.required.identifier;
	if (!required && field.schema !== FieldKinds.optional.identifier) {
		throw new UsageError(`The field ${JSON.stringify(key)} cannot be set.`);
	}
	if (content === undefined && field.length === 0) {
		return;
	}
	const checked = new VerboseContentChecker(flexNode.context).checkField(
		content === undefined ? [] : [content],
		getStoredSchema(flexNode).getFieldSchema(storedKey),
	);
	const { editor, forest } = flexNode.context.checkout;
	const newContent =
		checked.length === 0 ? undefined : combineChunks(chunkVerboseContent(forest, checked));
	const path = field.getFieldPath();
	if (required) {
		assert(
			newContent !== undefined,
			"A required field must have been checked to have content",
		);
		editor.valueField(path).set(newContent);
	} else {
		editor.optionalField(path).set(newContent, field.length === 0);
	}
}

/**
 * Gets the flex tree node of `node`, which must be in the document of a tree.
 */
function getFlexNodeInDocument(node: TreeNode, apiName: string): HydratedFlexTreeNode {
	if (getKernel(node).getStatus() !== TreeStatus.InDocument) {
		throw new UsageError(
			`${apiName} requires a node in a document. Content for unhydrated nodes can be created with importVerbose.`,
		);
	}
	const flexNode = getInnerNode(node);
	assert(flexNode.isHydrated(), "A node in the document must be hydrated");
	return flexNode;
}

function getStoredSchema(flexNode: HydratedFlexTreeNode): TreeNodeStoredSchema {
	return (
		flexNode.context.schema.nodeSchema.get(flexNode.type) ??
		fail("A node in the document must have a stored schema")
	);
}

/**
 * Chunks checked content for insertion into `forest`.
 */
function chunkVerboseContent(
	forest: IForestSubscription,
	content: readonly VerboseTree[],
): TreeChunk[] {
	const root: VerboseTreeNode = {
		type: aboveRootPlaceholder,
		// Forests which do not keep chunks read the content through a cursor, which does not understand text runs.
		fields: (forestKeepsChunks(forest)
			? content
			: content.map(expandTextRuns)) as VerboseTree[],
	};
	return chunkFieldForForest(forest, storedKeyAdapter, root, keyAsDetachedField(EmptyKey));
}

/**
 * 	ree with each node standing for a run of text atoms (see {@link VerboseTextRun}) replaced by the atoms it stands for.
 */
function expandTextRuns(tree: VerboseTree): VerboseTree {
	if (!isVerboseTreeNode(tree)) {
		return tree;
	}
	const { fields } = tree;
	if (Array.isArray(fields)) {
		const expanded: VerboseTree[] = [];
		for (const child of fields as VerboseTree[]) {
			const textRun = storedKeyAdapter.textRun?.(child);
			if (textRun === undefined) {
				expanded.push(expandTextRuns(child));
				continue;
			}
			const { layout } = textRun;
			const format = expandTextRuns(
				getChildren(child as VerboseTreeNode, layout.formatKey)[0] as VerboseTree,
			);
			for (const character of textRun.text) {
				const atomFields: Exclude<VerboseTreeNode["fields"], unknown[]> = {};
				const characterFields: Exclude<VerboseTreeNode["fields"], unknown[]> = {};
				defineField(characterFields, layout.characterKey, character);
				defineField(atomFields, layout.contentKey, {
					type: layout.characterType,
					fields: characterFields,
				});
				defineField(atomFields, layout.formatKey, format);
				expanded.push({ type: layout.atomType, fields: atomFields });
			}
		}
		return { type: tree.type, fields: expanded };
	}
	const expandedFields: Exclude<VerboseTreeNode["fields"], unknown[]> = {};
	for (const key of Object.keys(fields)) {
		const child = fields[key];
		if (child !== undefined) {
			defineField(expandedFields, key, expandTextRuns(child));
		}
	}
	return { type: tree.type, fields: expandedFields };
}

function isVerboseTreeNode(node: VerboseTree): node is VerboseTreeNode {
	return typeof node === "object" && node !== null && !isFluidHandle(node);
}

/**
 * The children of the field `key` of `node`.
 */
function getChildren(node: VerboseTreeNode, key: FieldKey): readonly VerboseTree[] {
	const fields = node.fields;
	if (Array.isArray(fields)) {
		return key === EmptyKey ? fields : [];
	}
	if (!Object.prototype.hasOwnProperty.call(fields, key)) {
		return [];
	}
	const child = fields[key];
	return child === undefined ? [] : [child];
}

/**
 * The keys of the non-empty fields of `node`.
 */
function getNonEmptyFieldKeys(node: VerboseTreeNode): FieldKey[] {
	const fields = node.fields;
	if (Array.isArray(fields)) {
		return fields.length === 0 ? [] : [EmptyKey];
	}
	return Object.keys(fields).filter((key) => fields[key] !== undefined) as FieldKey[];
}

/**
 * The number of non-empty fields of `node`.
 */
function countNonEmptyFields(node: VerboseTreeNode): number {
	const fields = node.fields;
	if (Array.isArray(fields)) {
		return fields.length === 0 ? 0 : 1;
	}
	let count = 0;
	for (const key of Object.keys(fields)) {
		if (fields[key] !== undefined) {
			count++;
		}
	}
	return count;
}

/**
 * Checks {@link VerboseTree} content with stored keys against the stored schema of a tree it is inserted into.
 *
 * @remarks
 * Applies the checks {@link isFieldInSchema} applies to other content inserted into the tree, and reports errors the same way.
 * An identifier field without content gets a new identifier from the tree, as when constructing a node.
 * Content is not modified: nodes which get identifiers are copied (along with their ancestors in the content),
 * with their fields in the order of the stored schema.
 */
class VerboseContentChecker {
	private readonly schemaAndPolicy: SchemaAndPolicy;

	/**
	 * The path, from the inserted content, to the field or node being checked.
	 */
	private readonly path: (string | number)[] = [];

	public constructor(private readonly context: FlexTreeHydratedContext) {
		this.schemaAndPolicy = getSchemaAndPolicy(context);
	}

	/**
	 * Checks `children` as the content of a field with schema `fieldSchema`.
	 * @returns `children`, or a copy of it holding nodes which got identifiers.
	 */
	public checkField(
		children: readonly VerboseTree[],
		fieldSchema: TreeFieldStoredSchema,
	): readonly VerboseTree[] {
		const kind = this.schemaAndPolicy.policy.fieldKinds.get(fieldSchema.kind);
		if (kind === undefined) {
			this.fail(SchemaValidationError.Field_KindNotInSchemaPolicy, {
				fieldKind: fieldSchema.kind,
			});
		}
		const multiplicityError = compliesWithMultiplicity(children.length, kind.multiplicity);
		if (multiplicityError !== undefined) {
			this.fail(
				multiplicityError,
				{ fieldKind: fieldSchema.kind },
				{ childCount: children.length },
			);
		}
		return this.checkChildren(children, fieldSchema.types);
	}

	/**
	 * Checks that each of `children` is a node of one of `types` in schema.
	 * @returns `children`, or a copy of it holding nodes which got identifiers.
	 */
	public checkChildren(
		children: readonly VerboseTree[],
		types: TreeTypeSet,
	): readonly VerboseTree[] {
		let result: VerboseTree[] | undefined;
		for (let index = 0; index < children.length; index++) {
			// Not `?? oob()`: a child can be `null` (a null leaf).
			const child = children[index] as VerboseTree;
			this.path.push(index);
			const type = storedKeyAdapter.type(child);
			if (!types.has(type)) {
				this.fail(SchemaValidationError.Field_NodeTypeNotAllowed, {
					nodeType: type,
					allowedTypes: JSON.stringify([...types].sort()),
				});
			}
			const textRun = storedKeyAdapter.textRun?.(child);
			const checked =
				textRun === undefined
					? this.checkNode(child, type)
					: this.checkTextRun(child as VerboseTreeNode, type, textRun);
			this.path.pop();
			if (checked !== child) {
				result ??= [...children];
				result[index] = checked;
			}
		}
		return result ?? children;
	}

	/**
	 * Checks a node standing for a run of text atoms (see {@link VerboseTextRun}):
	 * the atoms' content field must allow the run's characters, and the node's only field, the format, must be in schema.
	 */
	private checkTextRun(
		node: VerboseTreeNode,
		type: string,
		textRun: VerboseTextRun,
	): VerboseTree {
		const { layout } = textRun;
		const schema = this.schemaAndPolicy.schema.nodeSchema.get(brand(type));
		const characterSchema = this.schemaAndPolicy.schema.nodeSchema.get(layout.characterType);
		if (
			!(schema instanceof ObjectNodeStoredSchema) ||
			schema.objectNodeFields.get(layout.contentKey)?.types?.has(layout.characterType) !==
				true ||
			!(characterSchema instanceof ObjectNodeStoredSchema) ||
			characterSchema.objectNodeFields
				.get(layout.characterKey)
				?.types?.has(layout.leafType) !== true
		) {
			this.fail(SchemaValidationError.Field_NodeTypeNotAllowed, {
				nodeType: layout.characterType,
				allowedTypes: JSON.stringify([type]),
			});
		}
		if (textRun.text.length === 0) {
			throw new UsageError("A text run must not be empty.");
		}
		const formatSchema =
			schema.objectNodeFields.get(layout.formatKey) ?? fail("format field checked above");
		if (countNonEmptyFields(node) !== 1) {
			this.fail(SchemaValidationError.ObjectNode_FieldNotInSchema, {
				nodeType: type,
				unexpectedFields: JSON.stringify(
					getNonEmptyFieldKeys(node)
						.filter((key) => key !== layout.formatKey)
						.sort(),
				),
			});
		}
		this.path.push(layout.formatKey);
		const children = getChildren(node, layout.formatKey);
		const checked = this.checkField(children, formatSchema);
		this.path.pop();
		if (checked === children) {
			return node;
		}
		const fields: Exclude<VerboseTreeNode["fields"], unknown[]> = {};
		defineField(fields, layout.formatKey, checked[0] as VerboseTree);
		return {
			type: node.type,
			fields,
			[verboseTextRun]: textRun,
		} as unknown as VerboseTreeNode;
	}

	private checkNode(node: VerboseTree, type: string): VerboseTree {
		const schema = this.schemaAndPolicy.schema.nodeSchema.get(brand(type));
		if (schema === undefined) {
			this.fail(SchemaValidationError.Node_MissingSchema, { nodeType: type });
		}
		if (schema instanceof LeafNodeStoredSchema) {
			if (isVerboseTreeNode(node)) {
				const keys = getNonEmptyFieldKeys(node);
				if (keys.length > 0) {
					this.fail(SchemaValidationError.LeafNode_FieldsNotAllowed, {
						nodeType: type,
						unexpectedFields: JSON.stringify(keys.sort()),
					});
				}
			}
			const value = isVerboseTreeNode(node) ? undefined : node;
			if (!allowsValue(schema.leafValue, value)) {
				this.fail(
					SchemaValidationError.LeafNode_InvalidValue,
					{ nodeType: type, expectedValueType: ValueSchema[schema.leafValue] },
					{ actualValueType: value === null ? "null" : typeof value },
				);
			}
			return node;
		}
		if (!isVerboseTreeNode(node)) {
			this.fail(
				SchemaValidationError.NonLeafNode_ValueNotAllowed,
				{ nodeType: type },
				{ actualValueType: node === null ? "null" : typeof node },
			);
		}
		if (schema instanceof ObjectNodeStoredSchema) {
			return this.checkObjectNode(node, schema);
		}
		if (schema instanceof MapNodeStoredSchema) {
			return this.checkMapNode(node, schema);
		}
		fail("Unknown TreeNodeStoredSchema type");
	}

	private checkObjectNode(
		node: VerboseTreeNode,
		schema: ObjectNodeStoredSchema,
	): VerboseTreeNode {
		// Fields whose checked content differs from the node's.
		let replaced: Map<FieldKey, readonly VerboseTree[]> | undefined;
		let nonEmptyFieldCount = 0;
		for (const [key, fieldSchema] of schema.objectNodeFields) {
			const children = getChildren(node, key);
			let content = children;
			if (children.length > 0) {
				nonEmptyFieldCount++;
			} else if (fieldSchema.kind === identifierFieldKindIdentifier) {
				const { nodeKeyManager } = this.context;
				content = [
					nodeKeyManager.stabilizeNodeIdentifier(nodeKeyManager.generateLocalNodeIdentifier()),
				];
			}
			this.path.push(key);
			const checked = this.checkField(content, fieldSchema);
			this.path.pop();
			if (checked !== children) {
				replaced ??= new Map();
				replaced.set(key, checked);
			}
		}

		// The stored schema of a node does not allow fields it does not list,
		// whether or not the view schema allows unknown optional fields.
		if (countNonEmptyFields(node) !== nonEmptyFieldCount) {
			this.fail(SchemaValidationError.ObjectNode_FieldNotInSchema, {
				nodeType: node.type,
				unexpectedFields: JSON.stringify(
					getNonEmptyFieldKeys(node)
						.filter((key) => !schema.objectNodeFields.has(key))
						.sort(),
				),
			});
		}

		if (replaced === undefined) {
			return node;
		}
		const sequence = replaced.get(EmptyKey);
		if (Array.isArray(node.fields) && sequence !== undefined && replaced.size === 1) {
			return { type: node.type, fields: [...sequence] };
		}
		const fields: Exclude<VerboseTreeNode["fields"], unknown[]> = {};
		for (const key of schema.objectNodeFields.keys()) {
			const children = replaced.get(key) ?? getChildren(node, key);
			assert(
				children.length <= 1,
				"Only the field of an array node can have several children",
			);
			if (children.length > 0) {
				defineField(fields, key, children[0] as VerboseTree);
			}
		}
		return { type: node.type, fields };
	}
	private checkMapNode(node: VerboseTreeNode, schema: MapNodeStoredSchema): VerboseTreeNode {
		if (Array.isArray(node.fields)) {
			// Children in an array are the field under the empty key.
			const children = node.fields;
			if (children.length === 0) {
				return node;
			}
			this.path.push(EmptyKey);
			const checked = this.checkField(children, schema.mapFields);
			this.path.pop();
			return checked === children ? node : { type: node.type, fields: [...checked] };
		}
		let fields: Exclude<VerboseTreeNode["fields"], unknown[]> | undefined;
		for (const key of getNonEmptyFieldKeys(node)) {
			const children = getChildren(node, key);
			this.path.push(key);
			const checked = this.checkField(children, schema.mapFields);
			this.path.pop();
			if (checked !== children) {
				fields ??= { ...node.fields };
				defineField(fields, key, checked[0] as VerboseTree);
			}
		}
		return fields === undefined ? node : { type: node.type, fields };
	}

	private fail(
		error: SchemaValidationError,
		schemaArtifacts: Record<string, string>,
		properties?: ITelemetryBaseProperties,
	): never {
		throwOutOfSchema({
			error,
			path: [...this.path],
			telemetryProperties: { ...tagSchemaArtifacts(schemaArtifacts), ...properties },
		});
	}
}

/**
 * Sets the field `key` of `fields` to `child`, as an own property even when `key` is the name of an inherited property.
 */
function defineField(
	fields: Exclude<VerboseTreeNode["fields"], unknown[]>,
	key: string,
	child: VerboseTree,
): void {
	Object.defineProperty(fields, key, {
		value: child,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}
