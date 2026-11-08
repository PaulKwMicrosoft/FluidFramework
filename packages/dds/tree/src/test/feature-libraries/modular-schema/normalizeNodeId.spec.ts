/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateAssertionError } from "@fluidframework/test-runtime-utils/internal";

import type { ChangesetLocalId } from "../../../core/index.js";
import {
	newChangeAtomIdBTree,
	setInChangeAtomIdMap,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/changeAtomIdBTree.js";
import type { NodeId } from "../../../feature-libraries/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { normalizeNodeId } from "../../../feature-libraries/modular-schema/modularChangeUtils.js";
import { brand } from "../../../util/index.js";
import { mintRevisionTag } from "../../utils.js";

const tag = mintRevisionTag();

function nodeId(localId: number): NodeId {
	return { revision: tag, localId: brand<ChangesetLocalId>(localId) };
}

describe("normalizeNodeId", () => {
	it("returns a node ID without an alias as it is", () => {
		const aliases = newChangeAtomIdBTree<NodeId>();
		setInChangeAtomIdMap(aliases, nodeId(1), nodeId(2));
		const id = nodeId(3);
		assert.equal(normalizeNodeId(id, aliases), id);
		assert.equal(normalizeNodeId(id, newChangeAtomIdBTree()), id);
	});

	it("follows a chain of aliases to the canonical ID", () => {
		const aliases = newChangeAtomIdBTree<NodeId>();
		setInChangeAtomIdMap(aliases, nodeId(1), nodeId(2));
		setInChangeAtomIdMap(aliases, nodeId(2), nodeId(3));
		assert.deepEqual(normalizeNodeId(nodeId(1), aliases), nodeId(3));
		assert.deepEqual(normalizeNodeId(nodeId(2), aliases), nodeId(3));
	});

	it("rejects a loop of aliases", () => {
		const aliases = newChangeAtomIdBTree<NodeId>();
		setInChangeAtomIdMap(aliases, nodeId(1), nodeId(2));
		setInChangeAtomIdMap(aliases, nodeId(2), nodeId(1));
		assert.throws(
			() => normalizeNodeId(nodeId(1), aliases),
			validateAssertionError(/Node alias loop/),
		);
		setInChangeAtomIdMap(aliases, nodeId(3), nodeId(3));
		assert.throws(
			() => normalizeNodeId(nodeId(3), aliases),
			validateAssertionError(/Node alias loop/),
		);
	});
});
