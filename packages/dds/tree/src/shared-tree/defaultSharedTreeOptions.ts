/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { FluidClientVersion, FormatValidatorNoOp } from "../codec/index.js";
import {
	TreeCompressionStrategy,
	defaultIncrementalEncodingPolicy,
} from "../feature-libraries/index.js";

import { ForestTypeReference } from "./forestTypeReference.js";
import type { SharedTreeOptionsInternal } from "./sharedTree.js";

/**
 * The default {@link SharedTreeOptionsInternal}.
 * @remarks
 * This is in its own module, as is {@link exportSimpleSchema}, so that independent trees, which use them,
 * do not import the module defining the SharedTree DDS kernel.
 */
export const defaultSharedTreeOptions: Required<SharedTreeOptionsInternal> = {
	jsonValidator: FormatValidatorNoOp,
	minVersionForCollab: FluidClientVersion.v2_0,
	forest: ForestTypeReference,
	treeEncodeType: TreeCompressionStrategy.Compressed,
	shouldEncodeIncrementally: defaultIncrementalEncodingPolicy,
	enableSharedBranches: false,
	healUnresolvableIdentifiersOnDecode: false,
	writeVersionOverrides: new Map(),
	allowPossiblyIncompatibleWriteVersionOverrides: false,
	retainHistory: false,
	validateCommitsOnFirstSubmission: false,
	validateRebasedCommitsBeforeResubmission: false,
};
