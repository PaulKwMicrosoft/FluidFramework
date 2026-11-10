/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	buildChunkedForest,
	defaultSchemaPolicy,
	makeTreeChunker,
	textFormatFieldsOnly,
} from "../feature-libraries/index.js";

import { toForestType } from "./forestType.js";

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
 * {@link ForestTypeOptimized}, sharing storage only between identical formats of formatted text atoms.
 * @remarks
 * Other identical subtrees are stored separately.
 * This is a prototype for measuring how much of the memory the optimized forest saves by sharing identical subtrees
 * comes from text formats.
 * @alpha
 */
export const ForestTypeOptimizedSharingTextFormats = toForestType(
	(breaker, schema, idCompressor, shouldEncodeIncrementally) =>
		buildChunkedForest(
			makeTreeChunker(
				schema,
				defaultSchemaPolicy,
				shouldEncodeIncrementally,
				undefined,
				textFormatFieldsOnly,
			),
			undefined,
			idCompressor,
			breaker,
		),
);
