/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import {
	EmptyKey,
	LazyNodeStoredSchemaMap,
	ObjectNodeStoredSchema,
	type TreeNodeSchemaIdentifier,
	type TreeStoredSchema,
} from "../../core/index.js";
import {
	cursorForJsonableTreeField,
	defaultSchemaPolicy,
	FieldKinds,
	isFieldInSchema,
	mapTreeFieldFromCursor,
} from "../../feature-libraries/index.js";
import { exportSimpleSchema } from "../../shared-tree/index.js";
import {
	ExpectStored,
	StagedSchemaUpgradePolicy,
	Unchanged,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../simple-tree/core/index.js";
import {
	generateSchemaFromSimpleSchema,
	SchemaFactory,
	SchemaFactoryAlpha,
	type SimpleAllowedTypeAttributes,
} from "../../simple-tree/index.js";
import {
	getStoredSchema,
	toInitialSchema,
	simpleStoredSchemaToStoredSchema,
	toStoredSchema,
	transformSimpleNodeSchema,
	transformSimpleSchema,
	filterAllowedTypes,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../simple-tree/toStoredSchema.js";
// eslint-disable-next-line import-x/no-internal-modules
import { createTreeSchema } from "../../simple-tree/treeSchema.js";
// eslint-disable-next-line import-x/no-internal-modules
import { normalizeFieldSchema } from "../../simple-tree/fieldSchema.js";
import { brand } from "../../util/index.js";
import {
	getStagedSchemaUpgrades,
	HasStagedAllowedTypes,
	HasStagedAllowedTypesAfterUpdate,
	HasStagedOptionalField,
	HasStagedOptionalFieldAfterUpdate,
	testDocuments,
} from "../testTrees.js";

function getTestDocumentSchemaData(name: string): TreeStoredSchema {
	return testDocuments.find((test) => test.name === name)?.schemaData ?? assert.fail();
}

function getObjectNodeSchema(
	schema: TreeStoredSchema,
	identifier: string,
): ObjectNodeStoredSchema {
	const node = schema.nodeSchema.get(brand(identifier)) ?? assert.fail();
	assert(node instanceof ObjectNodeStoredSchema);
	return node;
}

function typeSet(...identifiers: string[]): Set<TreeNodeSchemaIdentifier> {
	return new Set(identifiers.map((identifier) => brand<TreeNodeSchemaIdentifier>(identifier)));
}

/**
 * The content of a stored schema, with its node schemas in a `Map`, for comparison with `deepEqual`
 * (whatever collection holds them, for example a {@link LazyNodeStoredSchemaMap}).
 */
function comparable(schema: TreeStoredSchema): TreeStoredSchema {
	return { rootFieldSchema: schema.rootFieldSchema, nodeSchema: new Map(schema.nodeSchema) };
}

describe("toStoredSchema", () => {
	describe("toStoredSchema", () => {
		it("minimal", () => {
			const schema = new SchemaFactory("com.example");
			class A extends schema.object("A", {}) {}
			const stored = toStoredSchema(A, StagedSchemaUpgradePolicy.restrictive);
			assert.equal(stored.rootFieldSchema.kind, FieldKinds.required.identifier);
			assert.deepEqual(stored.rootFieldSchema.types, new Set([A.identifier]));
			const storedNodeSchema = stored.nodeSchema.get(brand(A.identifier));
			assert(storedNodeSchema !== undefined);
			assert.deepEqual(storedNodeSchema.encodeV1(), {
				object: Object.create(null) as Record<string, never>,
			});
		});
		it("name collision", () => {
			const schema = new SchemaFactory("com.example");
			class A extends schema.object("A", {}) {}
			class B extends schema.object("A", {}) {}

			assert.throws(
				() => toStoredSchema([A, B], StagedSchemaUpgradePolicy.restrictive),
				/identifier "com.example.A"/,
			);
		});
		it("builtins are the same", () => {
			const schema = new SchemaFactory("com.example");
			const schema2 = new SchemaFactory("com.example");
			assert.equal(schema.number, schema2.number);
		});

		it("derives each node schema on first lookup when there are no staged upgrades", () => {
			const schema = new SchemaFactory("com.example");
			class Leaf extends schema.object("Leaf", { x: schema.number }) {}
			class Unused extends schema.object("Unused", { y: schema.string }) {}
			class Root extends schema.object("Root", {
				leaf: schema.optional(Leaf),
				unused: schema.optional(Unused),
			}) {}

			const restrictive = toStoredSchema(Root, StagedSchemaUpgradePolicy.restrictive);
			const nodeSchema = restrictive.nodeSchema;
			assert(nodeSchema instanceof LazyNodeStoredSchemaMap);
			assert.equal(nodeSchema.derivedCount, 0);
			assert.equal(nodeSchema.size, 5);
			assert(nodeSchema.has(brand(Unused.identifier)));
			assert.equal(nodeSchema.derivedCount, 0);

			const leaf = nodeSchema.get(brand(Leaf.identifier));
			assert(leaf instanceof ObjectNodeStoredSchema);
			assert.equal(nodeSchema.derivedCount, 1);
			assert.equal(nodeSchema.get(brand(Leaf.identifier)), leaf);
			assert.equal(nodeSchema.get(brand("com.example.Missing")), undefined);
			assert.equal(nodeSchema.derivedCount, 1);

			// Without staged upgrades every policy generates the same stored schema, so one is shared.
			assert.equal(toStoredSchema(Root, StagedSchemaUpgradePolicy.permissive), restrictive);

			// Iterating derives the rest, matching the eager conversion.
			const eager = simpleStoredSchemaToStoredSchema(
				transformSimpleSchema(
					createTreeSchema(normalizeFieldSchema(Root)),
					StagedSchemaUpgradePolicy.restrictive,
				),
			);
			assert.deepEqual(comparable(restrictive), comparable(eager));
			assert.deepEqual([...nodeSchema.keys()], [...eager.nodeSchema.keys()]);
			assert.equal(nodeSchema.derivedCount, 5);
			assert.equal(nodeSchema.get(brand(Leaf.identifier)), leaf);
		});

		it("derives staged schema eagerly, per policy", () => {
			const schema = new SchemaFactoryAlpha("com.example");
			class Root extends schema.objectAlpha("Root", {
				x: SchemaFactoryAlpha.optional(
					SchemaFactoryAlpha.types([
						SchemaFactoryAlpha.number,
						SchemaFactoryAlpha.staged(SchemaFactoryAlpha.string),
					]),
				),
			}) {}
			const restrictive = toStoredSchema(Root, StagedSchemaUpgradePolicy.restrictive);
			const permissive = toStoredSchema(Root, StagedSchemaUpgradePolicy.permissive);
			assert(!(restrictive.nodeSchema instanceof LazyNodeStoredSchemaMap));
			assert.notDeepEqual(comparable(restrictive), comparable(permissive));
		});

		describe("test documents", () => {
			for (const testCase of testDocuments) {
				describe(testCase.name, () => {
					if (
						testCase.requiresStagedSchema === true ||
						testCase.hasUnknownOptionalFieldSchema === true
					) {
						// If the document is relying on forwards compatibility options (staged schema or unknown optional fields),
						// then we do not expect to be able to get the same stored schema as in the document by deriving a stored schema from the view schema.
						// For cases just using staged schema, this validates that the staged schema is being discarded due to StagedSchemaUpgradePolicy.restrictive,
						// but the main reason for this conditional is to avoid these cases breaking the "Matches document" case below.
						it("Does not match document", () => {
							const restrictive = toStoredSchema(
								testCase.schema,
								StagedSchemaUpgradePolicy.restrictive,
							);
							assert.notDeepEqual(comparable(restrictive), comparable(testCase.schemaData));
						});
					} else {
						// Ensure that the stored schema captured in these test documents matches what we would generate from the view schema.
						// We can only test this in cases where the document is not relying on forwards compatibility options.
						it("Matches document", () => {
							const restrictive = toStoredSchema(
								testCase.schema,
								StagedSchemaUpgradePolicy.restrictive,
							);
							assert.deepEqual(comparable(restrictive), comparable(testCase.schemaData));
						});
					}

					it("Restrictive and Permissive", () => {
						const restrictive = toStoredSchema(
							testCase.schema,
							StagedSchemaUpgradePolicy.restrictive,
						);
						const permissive = toStoredSchema(
							testCase.schema,
							StagedSchemaUpgradePolicy.permissive,
						);

						// The restrictive case, used for initial schemas and upgrades, does not include any staged schema features.
						// The permissive case, used for unhydrated trees, includes all staged schema features.
						// They should be equal if and only if there are no staged schema features.
						if (getStagedSchemaUpgrades(testCase.schema).size > 0) {
							assert.notDeepEqual(comparable(restrictive), comparable(permissive));
						} else {
							assert.deepEqual(comparable(restrictive), comparable(permissive));
						}

						const tree = mapTreeFieldFromCursor(
							cursorForJsonableTreeField(testCase.treeFactory()),
						);

						// Our test case has an actual tree which is known to comply with its existing stored schema, and the test case's view schema.
						// Therefore, the tree must be in schema for the permissive case, with the exception of any unknown optional fields.
						// We can assert this here.
						// This is a sanity check that the produced permissive schema actually allows the trees it's supposed to.
						// This could catch bugs where simple to stored to simple round trip is correct, but the corresponding stored schema is wrong.
						isFieldInSchema(
							tree,
							permissive.rootFieldSchema,
							{
								schema: permissive,
								policy: defaultSchemaPolicy,
							},
							() => {
								assert(testCase.hasUnknownOptionalFields);
								return true;
							},
						);

						const restrictiveOutOfSchema = isFieldInSchema(
							tree,
							restrictive.rootFieldSchema,
							{
								schema: restrictive,
								policy: defaultSchemaPolicy,
							},
							() => true,
						);
						// Similar to above, we check the produced restrictive schema actually behaves correctly for the test tree.
						assert.equal(
							restrictiveOutOfSchema === true,
							testCase.requiresStagedSchema === true ||
								testCase.hasUnknownOptionalFields === true,
						);

						// These aren't the tests for "exportSimpleSchema", but toStored should work with them, so we can use them to check consistency and round trip.
						const simpleFromRestrictive = exportSimpleSchema(restrictive);
						const simpleFromPermissive = exportSimpleSchema(permissive);

						if (getStagedSchemaUpgrades(testCase.schema).size > 0) {
							assert.notDeepEqual(simpleFromRestrictive, simpleFromPermissive);
						} else {
							assert.deepEqual(simpleFromRestrictive, simpleFromPermissive);
						}

						const restrictive2 = simpleStoredSchemaToStoredSchema(simpleFromRestrictive);
						const permissive2 = simpleStoredSchemaToStoredSchema(simpleFromPermissive);

						assert.deepEqual(comparable(restrictive2), comparable(restrictive));
						assert.deepEqual(comparable(permissive2), comparable(permissive));

						// To further ensure toStoredSchema works with the other schema transforming APIs,
						// validate it with generateSchemaFromSimpleSchema to round trip through view schema.
						// View schema generated from stored schema will never contain staged schema:
						// they will either have been removed, or baked in (with the fact they were staged having been lost).
						const restrictive3 = toStoredSchema(
							generateSchemaFromSimpleSchema(simpleFromRestrictive).root,
							{
								includeStaged: () => assert.fail(),
								includeStagedOptional: () => assert.fail(),
							},
						);
						const permissive3 = toStoredSchema(
							generateSchemaFromSimpleSchema(simpleFromPermissive).root,
							{
								includeStaged: () => assert.fail(),
								includeStagedOptional: () => assert.fail(),
							},
						);

						assert.deepEqual(comparable(restrictive3), comparable(restrictive));
						assert.deepEqual(comparable(permissive3), comparable(permissive));
					});
				});
			}

			it("partially includes staged schema by upgrade identity", () => {
				// Test that the filtering logic in `toStoredSchema` works correctly.
				// These test trees compare the upgrade identity of the staged schema to implement the filter.
				// Schemas that are included by the filter should be present in the resulting stored schema, and any other staged schema should not.
				// See testTrees.ts for the test cases: "NestedMultiStage with one upgrade" and "NestedStagedOptional with one upgrade".
				const allowedTypesNode = getObjectNodeSchema(
					getTestDocumentSchemaData("NestedMultiStage with one upgrade"),
					"test.NestedMultiStage",
				);

				// See NestedMultiStage in testTrees.ts for the definition.
				// Field a: optional([staged(number)]) -> optional, empty types.
				// Field b: required([staged(MapWithStaged), null]) -> required, null only.
				// Field c: required([staged(ArrayWithStaged), null]) -> required, null and ArrayWithStaged.
				const fieldA = allowedTypesNode.getFieldSchema(brand("a"));
				assert.equal(fieldA.kind, FieldKinds.optional.identifier);
				assert.deepEqual(fieldA.types, typeSet());

				const fieldB = allowedTypesNode.getFieldSchema(brand("b"));
				assert.equal(fieldB.kind, FieldKinds.required.identifier);
				assert.deepEqual(fieldB.types, typeSet("com.fluidframework.leaf.null"));

				const fieldC = allowedTypesNode.getFieldSchema(brand("c"));
				assert.equal(fieldC.kind, FieldKinds.required.identifier);
				assert.deepEqual(
					fieldC.types,
					typeSet("com.fluidframework.leaf.null", "test.ArrayWithStaged"),
				);

				const stagedOptionalNode = getObjectNodeSchema(
					getTestDocumentSchemaData("NestedStagedOptional with one upgrade"),
					"test.NestedStagedOptional",
				);

				// See NestedStagedOptional in testTrees.ts for the definition.
				// Field a: stagedOptional(number) -> optional number.
				// Field b: stagedOptional(string) -> required string.
				const stagedOptionalFieldA = stagedOptionalNode.getFieldSchema(brand("a"));
				assert.equal(stagedOptionalFieldA.kind, FieldKinds.optional.identifier);
				assert.deepEqual(
					stagedOptionalFieldA.types,
					typeSet("com.fluidframework.leaf.number"),
				);

				const stagedOptionalFieldB = stagedOptionalNode.getFieldSchema(brand("b"));
				assert.equal(stagedOptionalFieldB.kind, FieldKinds.required.identifier);
				assert.deepEqual(
					stagedOptionalFieldB.types,
					typeSet("com.fluidframework.leaf.string"),
				);
			});
		});
	});

	describe("toInitialSchema with staged schema", () => {
		it("root", () => {
			const converted = toInitialSchema(
				SchemaFactoryAlpha.types([
					SchemaFactoryAlpha.number,
					SchemaFactoryAlpha.staged(SchemaFactoryAlpha.string),
				]),
			);
			const field = converted.rootFieldSchema;
			assert.equal(field.types.size, 1);
		});

		it("shallow", () => {
			const schemaFactory = new SchemaFactoryAlpha("com.example");
			class TestArray extends schemaFactory.arrayAlpha(
				"TestArray",
				SchemaFactoryAlpha.types([
					SchemaFactoryAlpha.number,
					SchemaFactoryAlpha.staged(SchemaFactoryAlpha.string),
				]),
			) {}

			const converted = toInitialSchema(TestArray);
			const node = converted.nodeSchema.get(brand(TestArray.identifier)) ?? assert.fail();
			const field = node.getFieldSchema(EmptyKey);
			assert.equal(field.types.size, 1);
		});

		it("nested", () => {
			const schemaFactory = new SchemaFactoryAlpha("com.example");
			class TestArray extends schemaFactory.arrayAlpha(
				"TestArray",
				SchemaFactoryAlpha.types([
					SchemaFactoryAlpha.number,
					SchemaFactoryAlpha.staged(SchemaFactoryAlpha.string),
				]),
			) {}
			class Root extends schemaFactory.objectAlpha("TestObject", {
				foo: TestArray,
			}) {}
			const converted = toInitialSchema(Root);
			const node = converted.nodeSchema.get(brand(TestArray.identifier)) ?? assert.fail();
			const field = node.getFieldSchema(EmptyKey);
			assert.equal(field.types.size, 1);
		});
	});

	describe("filterAllowedTypes", () => {
		it("minimal", () => {
			const stored = filterAllowedTypes(
				SchemaFactoryAlpha.required(SchemaFactory.number).simpleAllowedTypes,
				StagedSchemaUpgradePolicy.restrictive,
			);
			assert.deepEqual(
				stored,
				new Map([[SchemaFactory.number.identifier, { isStaged: undefined }]]),
			);
		});

		it("staged", () => {
			const storedRestrictive = filterAllowedTypes(
				SchemaFactoryAlpha.required(
					SchemaFactoryAlpha.types([SchemaFactoryAlpha.staged(SchemaFactory.number)]),
				).simpleAllowedTypes,
				StagedSchemaUpgradePolicy.restrictive,
			);
			const staged = SchemaFactoryAlpha.staged(SchemaFactory.number);
			const storedPermissive = filterAllowedTypes(
				SchemaFactoryAlpha.required(SchemaFactoryAlpha.types([staged])).simpleAllowedTypes,
				StagedSchemaUpgradePolicy.permissive,
			);
			const view = filterAllowedTypes(
				SchemaFactoryAlpha.required(
					SchemaFactoryAlpha.types([SchemaFactoryAlpha.staged(SchemaFactory.number)]),
				).simpleAllowedTypes,
				Unchanged,
			);
			assert.deepEqual(storedRestrictive, new Map());
			assert.deepEqual(
				storedPermissive,
				new Map([[SchemaFactory.number.identifier, { isStaged: undefined }]]),
			);
			assert.deepEqual(
				view,
				new Map([
					[
						SchemaFactory.number.identifier,
						{
							isStaged: staged.metadata.stagedSchemaUpgrade,
						} satisfies SimpleAllowedTypeAttributes,
					],
				]),
			);

			assert.throws(
				() =>
					filterAllowedTypes(
						SchemaFactoryAlpha.required(
							SchemaFactoryAlpha.types([SchemaFactoryAlpha.staged(SchemaFactory.number)]),
						).simpleAllowedTypes,
						ExpectStored,
					),
				validateUsageError(
					/use of `ExpectStored`, but view schema specific content was encountered/,
				),
			);
		});
	});

	describe("getStoredSchema", () => {
		it("options", () => {
			const v1 = getStoredSchema(
				transformSimpleNodeSchema(
					HasStagedAllowedTypes,
					StagedSchemaUpgradePolicy.restrictive,
				),
			);
			const v2 = getStoredSchema(
				transformSimpleNodeSchema(
					HasStagedAllowedTypesAfterUpdate,
					StagedSchemaUpgradePolicy.restrictive,
				),
			);
			const v1Permissive = getStoredSchema(
				transformSimpleNodeSchema(HasStagedAllowedTypes, StagedSchemaUpgradePolicy.permissive),
			);
			assert.notDeepEqual(v1.encodeV1(), v1Permissive.encodeV1());
			assert.deepEqual(v1Permissive.encodeV1(), v2.encodeV1());

			const stagedOptionalV1 = getStoredSchema(
				transformSimpleNodeSchema(
					HasStagedOptionalField,
					StagedSchemaUpgradePolicy.restrictive,
				),
			);
			const stagedOptionalV2 = getStoredSchema(
				transformSimpleNodeSchema(
					HasStagedOptionalFieldAfterUpdate,
					StagedSchemaUpgradePolicy.restrictive,
				),
			);
			const stagedOptionalV1Permissive = getStoredSchema(
				transformSimpleNodeSchema(
					HasStagedOptionalField,
					StagedSchemaUpgradePolicy.permissive,
				),
			);
			assert.notDeepEqual(stagedOptionalV1.encodeV1(), stagedOptionalV1Permissive.encodeV1());
			assert.deepEqual(stagedOptionalV1Permissive.encodeV1(), stagedOptionalV2.encodeV1());
		});
	});
});
