/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import type { FieldKey, TreeNodeSchemaIdentifier, TreeValue } from "../../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { BasicChunk } from "../../../feature-libraries/chunked-forest/basicChunk.js";
import {
	defaultSubtreeInternerLimits,
	type SharedFieldPolicy,
	SubtreeInterner,
	textFormatFieldsOnly,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/subtreeInterner.js";
import { defaultIncrementalEncodingPolicy } from "../../../feature-libraries/index.js";
import {
	SchemaFactory,
	SchemaFactoryBeta,
	StagedSchemaUpgradePolicy,
	toStoredSchema,
} from "../../../simple-tree/index.js";
import { FormattedText } from "../../../text/index.js";
import { brand } from "../../../util/index.js";

const sf = new SchemaFactoryBeta("test.subtreeInterner");
class Format extends sf.object("Format", { size: SchemaFactory.number }) {}
class Text extends FormattedText.createSchema(sf, Format, [], { size: 12 }) {}
class Doc extends sf.object("Doc", { text: Text, style: Format }) {}

const schema = toStoredSchema(Doc, StagedSchemaUpgradePolicy.restrictive);
const atomType: TreeNodeSchemaIdentifier = brand(
	"com.fluidframework.text.formatted<test.subtreeInterner>.StringAtom",
);
const formatKey: FieldKey = brand("format");
const styleKey: FieldKey = brand("style");

function format(size: TreeValue = 12): BasicChunk {
	return new BasicChunk(
		brand(Format.identifier),
		new Map([
			[
				brand<FieldKey>("size"),
				[new BasicChunk(brand(SchemaFactory.number.identifier), new Map(), size)],
			],
		]),
	);
}

/**
 * The number of distinct chunks left for four identical formats in field `key` of a node of type `type`.
 */
function distinctAfterInterning(
	type: TreeNodeSchemaIdentifier,
	key: FieldKey,
	sharedFields?: SharedFieldPolicy,
): number {
	const interner = new SubtreeInterner(
		schema,
		defaultIncrementalEncodingPolicy,
		defaultSubtreeInternerLimits,
		sharedFields,
	);
	const chunks = [format(), format(), format(), format()];
	interner.internField(type, key, chunks);
	const distinct = new Set(chunks).size;
	interner.dispose();
	return distinct;
}

describe("SubtreeInterner", () => {
	it("test schema has the node types used", () => {
		assert(schema.nodeSchema.has(atomType));
		assert(schema.nodeSchema.has(brand(Doc.identifier)));
	});

	it("shares identical subtrees in any field by default", () => {
		assert.equal(distinctAfterInterning(atomType, formatKey), 2);
		assert.equal(distinctAfterInterning(brand(Doc.identifier), styleKey), 2);
	});

	it("shares only in the fields its policy allows", () => {
		assert.equal(distinctAfterInterning(atomType, formatKey, textFormatFieldsOnly), 2);
		assert.equal(
			distinctAfterInterning(brand(Doc.identifier), styleKey, textFormatFieldsOnly),
			4,
		);
	});
});
