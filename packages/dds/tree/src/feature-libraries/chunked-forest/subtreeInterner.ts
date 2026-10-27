/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";

import {
	type FieldKey,
	MapNodeStoredSchema,
	ObjectNodeStoredSchema,
	type TreeChunk,
	type TreeNodeSchemaIdentifier,
	type TreeStoredSchema,
	type TreeValue,
	type Value,
} from "../../core/index.js";

import { BasicChunk } from "./basicChunk.js";
import type { IncrementalEncodingPolicy } from "./codec/index.js";
import { type TreeShape, UniformChunk } from "./uniformChunk.js";

/**
 * Bounds on the subtrees a {@link SubtreeInterner} shares and on the memory it uses.
 */
export interface SubtreeInternerLimits {
	/**
	 * Maximum number of nodes in a shared subtree.
	 *
	 * @remarks
	 * Identical large subtrees are rare, and comparing them costs time proportional to their size.
	 */
	readonly maxSubtreeNodes: number;
	/**
	 * Maximum number of shared chunks the interner holds.
	 *
	 * @remarks
	 * When the table is full, chunks which only the table references are released,
	 * and no chunk is added while it stays full.
	 */
	readonly maxEntries: number;
	/**
	 * Maximum number of subtree hashes remembered as seen once.
	 *
	 * @remarks
	 * A subtree is only shared when an identical one has been chunked before,
	 * so unique content never enters the table.
	 * When this many hashes are remembered, they are forgotten and remembering starts over.
	 */
	readonly maxSeenHashes: number;
	/**
	 * Minimum number of values a subtree stored inline in a {@link UniformChunk} must have to be shared instead.
	 *
	 * @remarks
	 * A shared subtree costs a reference in its parent's field, and separates the chunks of its neighbors,
	 * so sharing a subtree with few values saves little or nothing.
	 */
	readonly minSharedValues: number;
}

/**
 * Default {@link SubtreeInternerLimits}.
 */
export const defaultSubtreeInternerLimits: SubtreeInternerLimits = {
	maxSubtreeNodes: 64,
	maxEntries: 65536,
	maxSeenHashes: 65536,
	minSharedValues: 8,
};

/**
 * A subtree held by a {@link SubtreeInterner}.
 */
interface Entry {
	readonly hash: number;
	readonly nodes: number;
}

/**
 * Shares one immutable chunk between identical small subtrees as content is chunked.
 *
 * @remarks
 * Chunks are reference counted and copy on write: the forest clones any shared chunk on the path to an edit
 * (see `ensureExclusiveBasicChunk`), so a chunk referenced from several places in a forest behaves exactly like
 * separate copies of it.
 * This uses that to store repeated content once. For example, a formatted text stores a format subtree per character,
 * and consecutive characters usually have identical formats.
 *
 * Sharing only changes how content is stored in memory: the content read through cursors, and therefore edits,
 * summaries and ops, is the same, including the order of fields.
 *
 * The interner works bottom up, like hash consing: a chunk is shared when an identical chunk (same type, value,
 * field keys in the same order, and children that are the same chunk objects or identical leaves) has been chunked
 * before. The first occurrence of some content is not shared, so content that never repeats does not enter the table.
 *
 * Subtrees containing a field which is encoded incrementally (see {@link IncrementalEncodingPolicy}) are never shared,
 * nor are the children of such a field: the incremental summary tracks the chunks of those fields by identity.
 *
 * The table holds a reference to each chunk it shares, which keeps it immutable.
 * Chunks which only the table references (because the content using them was removed) are released whenever the
 * table has doubled in size since they were last released, so they never outnumber the chunks in use.
 * The table's size is bounded by {@link SubtreeInternerLimits.maxEntries}.
 * It must be discarded (with {@link SubtreeInterner.dispose}) when the schema changes.
 */
export class SubtreeInterner {
	/**
	 * Shared chunks, by hash.
	 */
	private readonly table: Map<number, TreeChunk[]> = new Map();

	/**
	 * Hash and node count of each chunk in {@link SubtreeInterner.table}.
	 */
	private readonly entries: Map<TreeChunk, Entry> = new Map();

	/**
	 * Hashes of subtrees chunked once which are not in the table.
	 */
	private readonly seen: Set<number> = new Set();

	/**
	 * Hashes of node types and field keys.
	 */
	private readonly keyHashes: Map<string, number> = new Map();

	/**
	 * Ids used to hash shapes, which are compared by identity.
	 */
	private readonly shapeIds: Map<TreeShape, number> = new Map();

	/**
	 * Whether each field (by node type, then key) can not hold shared subtrees.
	 */
	private readonly incrementalFields: Map<TreeNodeSchemaIdentifier, Map<FieldKey, boolean>> =
		new Map();

	/**
	 * Table size at which chunks only the table references are next released.
	 */
	private releaseAt = minReleaseSize;

	/**
	 * Nodes counted by the hash being computed.
	 */
	private hashedNodes = 0;

	public constructor(
		/**
		 * The stored schema of the content, used to interpret {@link SubtreeInterner.shouldEncodeIncrementally}.
		 */
		private readonly schema: TreeStoredSchema,
		/**
		 * Policy for which fields are encoded incrementally.
		 */
		private readonly shouldEncodeIncrementally: IncrementalEncodingPolicy,
		public readonly limits: SubtreeInternerLimits,
	) {}

	/**
	 * Replaces each chunk of one node in `chunks`, the content of field `key` of a node of type `parentType`,
	 * with an identical shared chunk where possible.
	 *
	 * @remarks
	 * Takes ownership of the references `chunks` holds, and leaves owned references in it.
	 */
	public internField(
		parentType: TreeNodeSchemaIdentifier,
		key: FieldKey,
		chunks: TreeChunk[],
	): void {
		if (this.isIncremental(parentType, key)) {
			return;
		}
		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index];
			if (chunk !== undefined) {
				chunks[index] = this.intern(chunk);
			}
		}
	}

	/**
	 * Returns a chunk identical to `chunk`, shared with identical chunks interned before where possible.
	 *
	 * @remarks
	 * Takes ownership of a reference to `chunk` and returns an owned reference.
	 * Only chunks of one node which are {@link BasicChunk}s, or {@link UniformChunk}s with more than one node, are shared.
	 * The caller must ensure `chunk` is not in a field which is encoded incrementally.
	 */
	public intern(chunk: TreeChunk): TreeChunk {
		if (chunk.topLevelLength !== 1) {
			return chunk;
		}
		if (chunk instanceof UniformChunk) {
			if (chunk.shape.treeShape.positions.length === 1) {
				return chunk;
			}
		} else if (!(chunk instanceof BasicChunk)) {
			return chunk;
		}
		this.hashedNodes = 0;
		const hash = this.hashChunk(chunk);
		if (hash === undefined) {
			return chunk;
		}
		const existing = this.find(hash, (candidate) => chunksEqual(candidate, chunk));
		if (existing !== undefined) {
			existing.referenceAdded();
			chunk.referenceRemoved();
			return existing;
		}
		if (this.markSeen(hash)) {
			this.add(chunk, { hash, nodes: this.hashedNodes });
		}
		return chunk;
	}

	/**
	 * Returns a shared {@link UniformChunk} holding one tree of shape `shape` with the values
	 * `values[start .. start + shape.valuesPerTopLevelNode]`, or `undefined` if the tree should be stored inline.
	 *
	 * @remarks
	 * Used for trees with a content-derived shape, whose values are collected before a chunk is created for them.
	 * The returned reference is owned by the caller.
	 * The caller must ensure the tree is not in a field which is encoded incrementally.
	 */
	public internValues(
		shape: TreeShape,
		values: readonly TreeValue[],
		start: number,
		idCompressor: IIdCompressor | undefined,
	): UniformChunk | undefined {
		const end = start + shape.valuesPerTopLevelNode;
		if (
			shape.valuesPerTopLevelNode < this.limits.minSharedValues ||
			shape.positions.length > this.limits.maxSubtreeNodes
		) {
			return undefined;
		}
		const hash = this.hashUniform(shape, 1, values, start, end);
		if (hash === undefined) {
			return undefined;
		}
		const existing = this.find(
			hash,
			(candidate) =>
				candidate instanceof UniformChunk &&
				candidate.topLevelLength === 1 &&
				candidate.shape.treeShape === shape &&
				candidate.idCompressor === (shape.mayContainCompressedIds ? idCompressor : undefined) &&
				valuesEqual(candidate.values, 0, values, start, shape.valuesPerTopLevelNode),
		);
		if (existing !== undefined) {
			existing.referenceAdded();
			return existing as UniformChunk;
		}
		if (!this.markSeen(hash)) {
			return undefined;
		}
		const chunk = new UniformChunk(
			shape.withTopLevelLength(1),
			values.slice(start, end),
			idCompressor,
		);
		return this.add(chunk, { hash, nodes: shape.positions.length }) ? chunk : undefined;
	}

	/**
	 * Whether field `key` of nodes of type `type` can not hold shared subtrees,
	 * because it is encoded incrementally or because the schema does not describe it.
	 */
	public isIncremental(type: TreeNodeSchemaIdentifier, key: FieldKey): boolean {
		let fields = this.incrementalFields.get(type);
		if (fields === undefined) {
			fields = new Map();
			this.incrementalFields.set(type, fields);
		}
		let result = fields.get(key);
		if (result === undefined) {
			const nodeSchema = this.schema.nodeSchema.get(type);
			result =
				nodeSchema instanceof ObjectNodeStoredSchema
					? this.shouldEncodeIncrementally(type, key)
					: nodeSchema instanceof MapNodeStoredSchema
						? this.shouldEncodeIncrementally(type)
						: true;
			fields.set(key, result);
		}
		return result;
	}

	/**
	 * Releases the references the table holds.
	 */
	public dispose(): void {
		for (const chunk of this.entries.keys()) {
			chunk.referenceRemoved();
		}
		this.table.clear();
		this.entries.clear();
		this.seen.clear();
		this.releaseAt = minReleaseSize;
	}

	/**
	 * Number of chunks in the table.
	 */
	public get size(): number {
		return this.entries.size;
	}

	private find(
		hash: number,
		matches: (candidate: TreeChunk) => boolean,
	): TreeChunk | undefined {
		const candidates = this.table.get(hash);
		if (candidates !== undefined) {
			for (const candidate of candidates) {
				if (matches(candidate)) {
					return candidate;
				}
			}
		}
		return undefined;
	}

	/**
	 * Records that a subtree with `hash` was chunked.
	 * @returns true if one was recorded before.
	 */
	private markSeen(hash: number): boolean {
		if (this.seen.has(hash)) {
			this.seen.delete(hash);
			return true;
		}
		if (this.seen.size >= this.limits.maxSeenHashes) {
			this.seen.clear();
		}
		this.seen.add(hash);
		return false;
	}

	/**
	 * Adds `chunk` to the table, with a reference held by the table.
	 * @returns false if the table is full.
	 */
	private add(chunk: TreeChunk, entry: Entry): boolean {
		if (this.entries.size >= this.releaseAt || this.entries.size >= this.limits.maxEntries) {
			this.releaseUnused();
			this.releaseAt = Math.max(minReleaseSize, 2 * this.entries.size);
			if (this.entries.size >= this.limits.maxEntries) {
				return false;
			}
		}
		chunk.referenceAdded();
		const candidates = this.table.get(entry.hash);
		if (candidates === undefined) {
			this.table.set(entry.hash, [chunk]);
		} else {
			candidates.push(chunk);
		}
		this.entries.set(chunk, entry);
		return true;
	}

	/**
	 * Removes from the table the chunks which only the table references.
	 */
	private releaseUnused(): void {
		for (const [chunk, { hash }] of this.entries) {
			if (!chunk.isShared()) {
				this.entries.delete(chunk);
				const candidates = this.table.get(hash);
				assert(candidates !== undefined, "interned chunk must be in the table");
				const remaining = candidates.filter((candidate) => candidate !== chunk);
				if (remaining.length === 0) {
					this.table.delete(hash);
				} else {
					this.table.set(hash, remaining);
				}
				chunk.referenceRemoved();
			}
		}
	}

	/**
	 * Hash of the content of `chunk`, adding its node count to {@link SubtreeInterner.hashedNodes}.
	 * @returns `undefined` if the subtree can not be shared.
	 */
	private hashChunk(chunk: TreeChunk): number | undefined {
		const entry = this.entries.get(chunk);
		if (entry !== undefined) {
			this.hashedNodes += entry.nodes;
			return this.hashedNodes > this.limits.maxSubtreeNodes ? undefined : entry.hash;
		}
		if (chunk instanceof UniformChunk) {
			const treeShape = chunk.shape.treeShape;
			this.hashedNodes += treeShape.positions.length * chunk.topLevelLength;
			if (this.hashedNodes > this.limits.maxSubtreeNodes) {
				return undefined;
			}
			return this.hashUniform(
				treeShape,
				chunk.topLevelLength,
				chunk.values,
				0,
				chunk.values.length,
			);
		}
		if (!(chunk instanceof BasicChunk)) {
			return undefined;
		}
		this.hashedNodes++;
		if (this.hashedNodes > this.limits.maxSubtreeNodes) {
			return undefined;
		}
		let hash = hashValue(mix(basicSeed, this.keyHash(chunk.type)), chunk.value);
		if (hash === undefined) {
			return undefined;
		}
		for (const [key, children] of chunk.fields) {
			if (this.isIncremental(chunk.type, key)) {
				return undefined;
			}
			hash = mix(mix(hash, this.keyHash(key)), children.length);
			for (const child of children) {
				const childHash = this.hashChunk(child);
				if (childHash === undefined) {
					return undefined;
				}
				hash = mix(hash, childHash);
			}
		}
		return hash;
	}

	private hashUniform(
		shape: TreeShape,
		topLevelLength: number,
		values: readonly Value[],
		start: number,
		end: number,
	): number | undefined {
		let shapeId = this.shapeIds.get(shape);
		if (shapeId === undefined) {
			shapeId = this.shapeIds.size;
			this.shapeIds.set(shape, shapeId);
		}
		let hash: number | undefined = mix(mix(uniformSeed, shapeId), topLevelLength);
		for (let index = start; index < end && hash !== undefined; index++) {
			hash = hashValue(hash, values[index]);
		}
		return hash;
	}

	private keyHash(key: string): number {
		let hash = this.keyHashes.get(key);
		if (hash === undefined) {
			hash = hashString(keySeed, key);
			this.keyHashes.set(key, hash);
		}
		return hash;
	}
}

/**
 * Smallest table size at which chunks only the table references are released.
 */
const minReleaseSize = 1024;

const basicSeed = 0x2f6b1c3d;
const uniformSeed = 0x5a17e00f;
const keySeed = 0x1b873593;

function mix(hash: number, value: number): number {
	const mixed = Math.imul(hash ^ value, 0x5bd1e995);
	return mixed ^ (mixed >>> 13);
}

function hashString(hash: number, value: string): number {
	let result = mix(hash, value.length);
	for (let index = 0; index < value.length; index++) {
		result = mix(result, value.charCodeAt(index));
	}
	return result;
}

const float64 = new Float64Array(1);
const float64Words = new Int32Array(float64.buffer);

/**
 * Mixes `value` into `hash`, consistently with {@link Object.is} equality.
 * @returns `undefined` for values which are not shared, such as handles.
 */
function hashValue(hash: number, value: Value): number | undefined {
	switch (typeof value) {
		case "undefined": {
			return mix(hash, 1);
		}
		case "boolean": {
			return mix(hash, value ? 2 : 3);
		}
		case "number": {
			if ((value | 0) === value && !Object.is(value, -0)) {
				return mix(mix(hash, 4), value);
			}
			float64[0] = value;
			return mix(mix(mix(hash, 5), float64Words[0] ?? 0), float64Words[1] ?? 0);
		}
		case "string": {
			return hashString(mix(hash, 6), value);
		}
		default: {
			return value === null ? mix(hash, 7) : undefined;
		}
	}
}

function valuesEqual(
	a: readonly Value[],
	aStart: number,
	b: readonly Value[],
	bStart: number,
	length: number,
): boolean {
	for (let index = 0; index < length; index++) {
		if (!Object.is(a[aStart + index], b[bStart + index])) {
			return false;
		}
	}
	return true;
}

/**
 * Whether `a` and `b` hold the same content in the same layout, comparing child chunks of {@link BasicChunk}s
 * by content. Only {@link BasicChunk}s and {@link UniformChunk}s are compared.
 */
function chunksEqual(a: TreeChunk, b: TreeChunk): boolean {
	if (a === b) {
		return true;
	}
	if (a instanceof UniformChunk) {
		return (
			b instanceof UniformChunk &&
			a.shape.treeShape === b.shape.treeShape &&
			a.topLevelLength === b.topLevelLength &&
			a.idCompressor === b.idCompressor &&
			valuesEqual(a.values, 0, b.values, 0, a.values.length)
		);
	}
	if (!(a instanceof BasicChunk) || !(b instanceof BasicChunk)) {
		return false;
	}
	if (a.type !== b.type || !Object.is(a.value, b.value) || a.fields.size !== b.fields.size) {
		return false;
	}
	const otherFields = b.fields.entries();
	for (const [key, children] of a.fields) {
		const next = otherFields.next();
		if (next.done === true) {
			return false;
		}
		const [otherKey, otherChildren] = next.value;
		if (key !== otherKey || children.length !== otherChildren.length) {
			return false;
		}
		for (let index = 0; index < children.length; index++) {
			const child = children[index];
			const otherChild = otherChildren[index];
			if (child === undefined || otherChild === undefined || !chunksEqual(child, otherChild)) {
				return false;
			}
		}
	}
	return true;
}
