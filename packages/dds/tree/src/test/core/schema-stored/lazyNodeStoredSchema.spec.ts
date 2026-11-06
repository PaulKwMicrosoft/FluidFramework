/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	LazyNodeStoredSchemaMap,
	LeafNodeStoredSchema,
	type TreeNodeSchemaIdentifier,
	type TreeNodeStoredSchema,
	type TreeStoredSchema,
	TreeStoredSchemaRepository,
	ValueSchema,
	storedEmptyFieldSchema,
} from "../../../core/index.js";
import { brand } from "../../../util/index.js";

function lazySchema(identifiers: string[]): {
	schema: TreeStoredSchema & { nodeSchema: LazyNodeStoredSchemaMap };
	derivedLog: string[];
} {
	const derivedLog: string[] = [];
	const nodeSchema = LazyNodeStoredSchemaMap.create(
		new Map(identifiers.map((identifier) => [identifier, undefined])),
		(identifier): TreeNodeStoredSchema => {
			derivedLog.push(identifier);
			return new LeafNodeStoredSchema(ValueSchema.Number);
		},
	);
	return { schema: { rootFieldSchema: storedEmptyFieldSchema, nodeSchema }, derivedLog };
}

const id = (s: string): TreeNodeSchemaIdentifier => brand(s);

describe("LazyNodeStoredSchemaMap", () => {
	it("derives each schema once, on first lookup", () => {
		const { schema, derivedLog } = lazySchema(["b", "a", "c"]);
		const map = schema.nodeSchema;
		assert.equal(map.size, 3);
		assert(map.has(id("a")));
		assert(!map.has(id("d")));
		assert.deepEqual(derivedLog, []);
		const a = map.get(id("a"));
		assert(a !== undefined);
		assert.equal(map.get(id("a")), a);
		assert.equal(map.get(id("d")), undefined);
		assert.deepEqual(derivedLog, ["a"]);
		assert.equal(map.derivedCount, 1);
	});

	it("iterates in the identifiers' order, or sorted", () => {
		const { schema, derivedLog } = lazySchema(["b", "a", "c"]);
		const map = schema.nodeSchema;
		assert.deepEqual([...map.keys()], ["b", "a", "c"]);
		assert.deepEqual(derivedLog, []);
		const sorted = map.withSortedIteration();
		assert.deepEqual([...sorted.keys()], ["a", "b", "c"]);
		assert.equal(sorted.withSortedIteration(), sorted);
		const a = sorted.get(id("a"));
		// The sorted variant shares the derived schema.
		assert.equal(map.get(id("a")), a);
		assert.deepEqual(
			[...sorted.entries()].map(([key]) => key),
			["a", "b", "c"],
		);
		assert.deepEqual(derivedLog, ["a", "b", "c"]);
		assert.equal([...map.values()].length, 3);
		const visited: string[] = [];
		map.forEach((value, key) => visited.push(key));
		assert.deepEqual(visited, ["b", "a", "c"]);
	});
});

describe("TreeStoredSchemaRepository with lazy node schema", () => {
	it("keeps node schema lazy through construction, clone and apply", () => {
		const { schema, derivedLog } = lazySchema(["b", "a"]);
		const repository = new TreeStoredSchemaRepository(schema);
		assert.equal(repository.nodeSchema.size, 2);
		assert(repository.nodeSchema.get(id("a")) !== undefined);
		assert.deepEqual(derivedLog, ["a"]);

		// Iteration order matches a repository holding its node schema in a tree: sorted by identifier.
		const clone = repository.clone();
		assert.deepEqual([...clone.nodeSchema.keys()], ["a", "b"]);
		assert.deepEqual(derivedLog, ["a"]);

		const other = new TreeStoredSchemaRepository();
		other.apply(schema);
		assert.equal(other.nodeSchema.get(id("a")), repository.nodeSchema.get(id("a")));
		assert.deepEqual(derivedLog, ["a"]);
	});

	it("derives all node schema when mutated", () => {
		class Mutable extends TreeStoredSchemaRepository {
			public set(identifier: string, node: TreeNodeStoredSchema): void {
				this.nodeSchemaData.set(id(identifier), node);
			}
		}
		const { schema, derivedLog } = lazySchema(["b", "a"]);
		const repository = new Mutable(schema);
		const leaf = new LeafNodeStoredSchema(ValueSchema.String);
		repository.set("c", leaf);
		assert.deepEqual([...derivedLog].sort(), ["a", "b"]);
		assert.deepEqual([...repository.nodeSchema.keys()], ["a", "b", "c"]);
		assert.equal(repository.nodeSchema.get(id("c")), leaf);
		// The lazy schema it was made from is unchanged.
		assert.equal(schema.nodeSchema.size, 2);
	});
});
