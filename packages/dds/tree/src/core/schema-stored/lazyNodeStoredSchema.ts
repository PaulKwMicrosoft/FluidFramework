/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { compareStrings } from "../../util/index.js";

import type { TreeNodeSchemaIdentifier } from "./formatV1.js";
import type { TreeNodeStoredSchema } from "./schema.js";

/**
 * The identifiers a {@link LazyNodeStoredSchemaMap} holds schema for, in iteration order.
 */
export interface NodeSchemaIdentifiers {
	readonly size: number;
	has(identifier: string): boolean;
	keys(): Iterable<string>;
}

/**
 * State shared by a {@link LazyNodeStoredSchemaMap} and the variants made from it with {@link LazyNodeStoredSchemaMap.withSortedIteration}.
 */
interface LazyNodeStoredSchemaState {
	readonly identifiers: NodeSchemaIdentifiers;
	readonly derive: (identifier: TreeNodeSchemaIdentifier) => TreeNodeStoredSchema;
	readonly derived: Map<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>;
	sortedIdentifiers?: readonly TreeNodeSchemaIdentifier[];
}

/**
 * An immutable collection of node stored schema which derives the schema for each identifier the first time it is looked up.
 * @remarks
 * The set of identifiers is fixed when the collection is created.
 * Lookups ({@link LazyNodeStoredSchemaMap.get}) only derive the schema they return,
 * so a document which uses a few of a large schema's node types only pays for those.
 * Iterating the collection derives the schema for every identifier.
 *
 * Each identifier's schema is derived at most once, so lookups always return the same object.
 */
export class LazyNodeStoredSchemaMap
	implements ReadonlyMap<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>
{
	private constructor(
		private readonly state: LazyNodeStoredSchemaState,
		private readonly sorted: boolean,
	) {}

	/**
	 * @param identifiers - The identifiers the collection holds schema for, in the order to iterate them in.
	 * @param derive - Returns the schema for an identifier in `identifiers`.
	 * Called at most once per identifier.
	 */
	public static create(
		identifiers: NodeSchemaIdentifiers,
		derive: (identifier: TreeNodeSchemaIdentifier) => TreeNodeStoredSchema,
	): LazyNodeStoredSchemaMap {
		return new LazyNodeStoredSchemaMap({ identifiers, derive, derived: new Map() }, false);
	}

	/**
	 * Returns a collection with the same schema (sharing what has been derived) which iterates in identifier order,
	 * as {@link TreeStoredSchemaRepository} does.
	 */
	public withSortedIteration(): LazyNodeStoredSchemaMap {
		return this.sorted ? this : new LazyNodeStoredSchemaMap(this.state, true);
	}

	/**
	 * The number of node schema which have been derived so far.
	 */
	public get derivedCount(): number {
		return this.state.derived.size;
	}

	public get size(): number {
		return this.state.identifiers.size;
	}

	public has(identifier: TreeNodeSchemaIdentifier): boolean {
		return this.state.identifiers.has(identifier);
	}

	public get(identifier: TreeNodeSchemaIdentifier): TreeNodeStoredSchema | undefined {
		const { identifiers, derive, derived } = this.state;
		let schema = derived.get(identifier);
		if (schema === undefined && identifiers.has(identifier)) {
			schema = derive(identifier);
			derived.set(identifier, schema);
		}
		return schema;
	}

	public keys(): MapIterator<TreeNodeSchemaIdentifier> {
		return this.orderedIdentifiers()[Symbol.iterator]();
	}

	public *values(): MapIterator<TreeNodeStoredSchema> {
		for (const identifier of this.orderedIdentifiers()) {
			yield this.getExisting(identifier);
		}
	}

	public *entries(): MapIterator<[TreeNodeSchemaIdentifier, TreeNodeStoredSchema]> {
		for (const identifier of this.orderedIdentifiers()) {
			yield [identifier, this.getExisting(identifier)];
		}
	}

	public [Symbol.iterator](): MapIterator<[TreeNodeSchemaIdentifier, TreeNodeStoredSchema]> {
		return this.entries();
	}

	/**
	 * Shows the collection as a `Map` of its node schema (deriving all of them) when inspected in NodeJS,
	 * rather than its internals, which reference the view schema it derives them from.
	 */
	public [Symbol.for("nodejs.util.inspect.custom")](): unknown {
		return new Map(this.entries());
	}

	public forEach(
		callbackfn: (
			value: TreeNodeStoredSchema,
			key: TreeNodeSchemaIdentifier,
			map: ReadonlyMap<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>,
		) => void,
		thisArg?: unknown,
	): void {
		for (const [identifier, schema] of this.entries()) {
			callbackfn.call(thisArg, schema, identifier, this);
		}
	}

	private getExisting(identifier: TreeNodeSchemaIdentifier): TreeNodeStoredSchema {
		// Every identifier iterated is in the collection, so `get` always returns a schema for it.
		return this.get(identifier) as TreeNodeStoredSchema;
	}

	private orderedIdentifiers(): readonly TreeNodeSchemaIdentifier[] {
		const keys = this.state.identifiers.keys() as Iterable<TreeNodeSchemaIdentifier>;
		if (!this.sorted) {
			return [...keys];
		}
		this.state.sortedIdentifiers ??= [...keys].sort(compareStrings);
		return this.state.sortedIdentifiers;
	}
}
