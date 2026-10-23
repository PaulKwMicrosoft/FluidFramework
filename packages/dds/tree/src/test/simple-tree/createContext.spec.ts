/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import { TreeAlpha } from "../../shared-tree/index.js";
import {
	SchemaFactoryAlpha,
	TreeViewConfigurationAlpha,
	getUnhydratedContext,
	toStoredSchema,
	toUnhydratedSchema,
} from "../../simple-tree/index.js";

describe("getUnhydratedContext", () => {
	it("shares one context among the node schemas of a configuration", () => {
		const factory = new SchemaFactoryAlpha("shared");
		class Point extends factory.object("Point", { x: factory.number, y: factory.number }) {}
		class Shape extends factory.objectAlpha(
			"Shape",
			{ position: Point, label: factory.optional(factory.string) },
			{ allowUnknownOptionalFields: true },
		) {}
		class Shapes extends factory.array("Shapes", Shape) {}
		const config = new TreeViewConfigurationAlpha({ schema: Shapes });

		const context = getUnhydratedContext(Point);
		assert.equal(getUnhydratedContext(Shape), context);
		assert.equal(getUnhydratedContext(Shapes), context);

		// The shared context holds the same stored schema for each node schema as one generated from that node schema alone.
		for (const nodeSchema of [Point, Shape, Shapes]) {
			const own = toStoredSchema(nodeSchema, toUnhydratedSchema);
			for (const [identifier, stored] of own.nodeSchema) {
				assert.deepEqual(context.flexContext.schema.nodeSchema.get(identifier), stored);
			}
		}

		// Content is still validated against the schema it is created for.
		const point = TreeAlpha.importVerbose(Point, {
			type: Point.identifier,
			fields: { x: 1, y: 2 },
		});
		assert(point instanceof Point);
		assert.throws(
			() =>
				TreeAlpha.importVerbose(Point, {
					type: Shapes.identifier,
					fields: [],
				}),
			validateUsageError(/schema/i),
		);
		assert.equal(config.definitions.size > 0, true);
	});

	it("does not share contexts for schemas with staged upgrades", () => {
		const factory = new SchemaFactoryAlpha("staged");
		class Leaf extends factory.object("Leaf", { value: factory.number }) {}
		class Root extends factory.object("Root", {
			child: factory.types([factory.number, factory.staged(Leaf)]),
		}) {}
		const config = new TreeViewConfigurationAlpha({ schema: Root });
		assert.notEqual(getUnhydratedContext(Leaf), getUnhydratedContext(Root));
		assert.equal(config.definitions.has(Leaf.identifier), true);
	});

	it("keeps a context created before the configuration", () => {
		const factory = new SchemaFactoryAlpha("early");
		class Point extends factory.object("Point", { x: factory.number }) {}
		class Points extends factory.array("Points", Point) {}
		const pointContext = getUnhydratedContext(Point);
		const config = new TreeViewConfigurationAlpha({ schema: Points });
		assert.equal(getUnhydratedContext(Point), pointContext);
		assert.notEqual(getUnhydratedContext(Points), pointContext);
		assert.equal(config.definitions.size > 0, true);
	});
});
