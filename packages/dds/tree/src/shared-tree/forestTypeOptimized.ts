/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	buildChunkedForest,
	defaultSchemaPolicy,
	makeTreeChunker,
	textFormatsAndFields,
	type SharedFieldPolicy,
} from "../feature-libraries/index.js";

import { type ForestType, toForestType } from "./forestType.js";

/**
 * Optimized implementation of forest.
 * @remarks
 * A complex optimized forest implementation with minimal validation and debuggability.
 * It uses an internal representation that is optimized for size and larger data sets.
 * @beta
 */
export const ForestTypeOptimized = toForestType(
	(breaker, schema, idCompressor, shouldEncodeIncrementally) =>
		buildChunkedForest(
			makeTreeChunker(schema, defaultSchemaPolicy, shouldEncodeIncrementally),
			undefined,
			idCompressor,
			breaker,
		),
);

/**
 * Keys of fields whose content {@link ForestTypeOptimizedSharingTextFormats} shares in addition to text formats.
 * @remarks
 * Fields with these keys commonly hold property bags which many nodes have identical copies of,
 * for example the properties of paragraphs and of text bodies.
 * @alpha
 */
export const defaultSharedPropertyFieldKeys: readonly string[] = Object.freeze([
	"properties",
	"endProperties",
	"bodyProperties",
]);

/**
 * {@link ForestTypeOptimized}, sharing storage between identical formats of formatted text atoms,
 * and between identical subtrees held in fields with any of ieldKeys, in nodes of any type.
 * @remarks
 * Other identical subtrees are stored separately.
 * Shared subtrees are limited in size (at most 64 nodes), and subtrees with fewer than 8 values stored inline are not shared.
 * Sharing only changes how content is stored in memory: content read, edits, summaries and ops are unchanged.
 * @alpha
 */
export function forestTypeOptimizedSharingFields(fieldKeys: Iterable<string>): ForestType {
	return forestTypeSharing(textFormatsAndFields(fieldKeys));
}

/**
 * {@link ForestTypeOptimized}, sharing storage between identical formats of formatted text atoms,
 * and between identical subtrees in fields with the keys in {@link defaultSharedPropertyFieldKeys}.
 * @remarks
 * Other identical subtrees are stored separately.
 * Use {@link forestTypeOptimizedSharingFields} to choose the field keys.
 * @alpha
 */
export const ForestTypeOptimizedSharingTextFormats = forestTypeOptimizedSharingFields(
	defaultSharedPropertyFieldKeys,
);

function forestTypeSharing(policy: SharedFieldPolicy): ForestType {
	return toForestType((breaker, schema, idCompressor, shouldEncodeIncrementally) =>
		buildChunkedForest(
			makeTreeChunker(schema, defaultSchemaPolicy, shouldEncodeIncrementally, undefined, policy),
			undefined,
			idCompressor,
			breaker,
		),
	);
}