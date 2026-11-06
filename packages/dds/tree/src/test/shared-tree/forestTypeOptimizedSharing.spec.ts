/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

// eslint-disable-next-line import-x/no-internal-modules
import { createIndependentTreeAlpha } from "../../shared-tree/independentView.js";
import {
	defaultSharedPropertyFieldKeys,
	ForestTypeOptimizedSharingTextFormats,
	forestTypeOptimizedSharingFields,
} from "../../shared-tree/index.js";
import { SchemaFactoryAlpha, TreeViewConfigurationAlpha } from "../../simple-tree/index.js";

const sf = new SchemaFactoryAlpha("test.forestTypeOptimizedSharing");
class Properties extends sf.object("Properties", {
	a: sf.number,
	b: sf.number,
	c: sf.number,
	d: sf.number,
	e: sf.number,
	f: sf.number,
	g: sf.number,
	h: sf.string,
}) {}
class Item extends sf.object("Item", {
	properties: Properties,
	other: Properties,
}) {}
class Root extends sf.array("Root", Item) {}

function properties(a = 1): Properties {
	return new Properties({ a, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: "same" });
}

describe("Optimized forest sharing configured fields", () => {
	it("default keys", () => {
		assert.deepEqual(
			[...defaultSharedPropertyFieldKeys],
			["properties", "endProperties", "bodyProperties"],
		);
	});

	for (const [name, forest] of [
		["default keys", ForestTypeOptimizedSharingTextFormats],
		["configured keys", forestTypeOptimizedSharingFields(["properties"])],
	] as const) {
		it(`content and edits are unaffected by sharing (${name})`, () => {
			const tree = createIndependentTreeAlpha({ forest });
			const view = tree.viewWith(new TreeViewConfigurationAlpha({ schema: Root }));
			const count = 20;
			view.initialize(
				new Root(
					Array.from(
						{ length: count },
						() => new Item({ properties: properties(), other: properties() }),
					),
				),
			);
			for (const item of view.root) {
				assert.equal(item.properties.a, 1);
				assert.equal(item.properties.h, "same");
				assert.equal(item.other.a, 1);
			}

			const edited = view.root[3] ?? assert.fail();
			edited.properties.a = 42;
			for (const [index, item] of view.root.entries()) {
				assert.equal(item.properties.a, index === 3 ? 42 : 1);
				assert.equal(item.properties.g, 7);
			}

			view.root.insertAt(0, new Item({ properties: properties(), other: properties(5) }));
			assert.equal(view.root.length, count + 1);
			assert.equal(view.root[0]?.other.a, 5);
			assert.equal(view.root[4]?.properties.a, 42);
			assert.equal(view.root[5]?.properties.a, 1);
			view.dispose();
		});
	}
});
