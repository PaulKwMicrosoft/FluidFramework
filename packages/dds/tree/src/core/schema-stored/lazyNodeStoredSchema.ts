/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { UsageError } from "@fluidframework/telemetry-utils/internal";

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
 *
 * What the schema are derived from is held in private fields, so it is not reached by `JSON.stringify`, `util.inspect` or deep equality checks:
 * those see the collection as a `Map` of its node schema.
 * As a `Map` subclass, deep equality checks compare its entries (through its iterator), deriving all of them.
 */
export class LazyNodeStoredSchemaMap
	extends Map<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>
	implements ReadonlyMap<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>
{
	readonly #state: LazyNodeStoredSchemaState;
	readonly #sorted: boolean;

	private constructor(state: LazyNodeStoredSchemaState, sorted: boolean) {
		super();
		this.#state = state;
		this.#sorted = sorted;
	}

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
		return this.#sorted ? this : new LazyNodeStoredSchemaMap(this.#state, true);
	}

	/**
	 * The number of node schema which have been derived so far.
	 */
	public get derivedCount(): number {
		return this.#state.derived.size;
	}

	public override get size(): number {
		return this.#state.identifiers.size;
	}

	public override has(identifier: TreeNodeSchemaIdentifier): boolean {
		return this.#state.identifiers.has(identifier);
	}

	public override get(identifier: TreeNodeSchemaIdentifier): TreeNodeStoredSchema | undefined {
		const { identifiers, derive, derived } = this.#state;
		let schema = derived.get(identifier);
		if (schema === undefined && identifiers.has(identifier)) {
			schema = derive(identifier);
			derived.set(identifier, schema);
		}
		return schema;
	}

	public override set(): never {
		throw new UsageError("LazyNodeStoredSchemaMap is immutable");
	}

	public override delete(): never {
		throw new UsageError("LazyNodeStoredSchemaMap is immutable");
	}

	public override clear(): never {
		throw new UsageError("LazyNodeStoredSchemaMap is immutable");
	}

	public override keys(): MapIterator<TreeNodeSchemaIdentifier> {
		return this.#orderedIdentifiers()[Symbol.iterator]();
	}

	public override *values(): MapIterator<TreeNodeStoredSchema> {
		for (const identifier of this.#orderedIdentifiers()) {
			yield this.#getExisting(identifier);
		}
	}

	public override *entries(): MapIterator<[TreeNodeSchemaIdentifier, TreeNodeStoredSchema]> {
		for (const identifier of this.#orderedIdentifiers()) {
			yield [identifier, this.#getExisting(identifier)];
		}
	}

	public override [Symbol.iterator](): MapIterator<
		[TreeNodeSchemaIdentifier, TreeNodeStoredSchema]
	> {
		return this.entries();
	}

	public override forEach(
		callbackfn: (
			value: TreeNodeStoredSchema,
			key: TreeNodeSchemaIdentifier,
			map: Map<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>,
		) => void,
		thisArg?: unknown,
	): void {
		for (const [identifier, schema] of this.entries()) {
			callbackfn.call(thisArg, schema, identifier, this);
		}
	}

	/**
	 * The node schema derived so far, encoded, by identifier, so serializing the collection doesn't derive the rest.
	 */
	public toJSON(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [identifier, schema] of this.#state.derived) {
			result[identifier] = schema.encodeV2();
		}
		return result;
	}

	/**
	 * Shows the node schema derived so far when inspected in NodeJS, without deriving the rest.
	 */
	public [Symbol.for("nodejs.util.inspect.custom")](): unknown {
		return {
			size: this.size,
			derived: new Map(this.#state.derived),
		};
	}

	#getExisting(identifier: TreeNodeSchemaIdentifier): TreeNodeStoredSchema {
		// Every identifier iterated is in the collection, so `get` always returns a schema for it.
		return this.get(identifier) as TreeNodeStoredSchema;
	}

	#orderedIdentifiers(): readonly TreeNodeSchemaIdentifier[] {
		const keys = this.#state.identifiers.keys() as Iterable<TreeNodeSchemaIdentifier>;
		if (!this.#sorted) {
			return [...keys];
		}
		this.#state.sortedIdentifiers ??= [...keys].sort(compareStrings);
		return this.#state.sortedIdentifiers;
	}
}
