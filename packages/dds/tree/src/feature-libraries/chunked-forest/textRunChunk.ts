/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, debugAssert, oob } from "@fluidframework/core-utils/internal";

import {
	CursorLocationType,
	type ChunkedCursor,
	type FieldKey,
	type FieldUpPath,
	type PathRootPrefix,
	type TreeChunk,
	type TreeNodeSchemaIdentifier,
	type TreeType,
	type UpPath,
	type Value,
	cursorChunk,
	dummyRoot,
} from "../../core/index.js";
import { ReferenceCountedBase } from "../../util/index.js";
import { SynchronousCursor, prefixFieldPath, prefixPath } from "../treeCursorUtils.js";

import { BasicChunk } from "./basicChunk.js";

/**
 * The node types and field keys of the nodes a {@link TextRunChunk} holds.
 *
 * @remarks
 * Each top-level node of the chunk is an atom of type {@link TextRunLayout.atomType} with two fields, in this order:
 * {@link TextRunLayout.contentKey}, holding a character node of type {@link TextRunLayout.characterType}
 * (whose {@link TextRunLayout.characterKey} field holds a {@link TextRunLayout.leafType} leaf with the character as its value),
 * and {@link TextRunLayout.formatKey}, holding the format subtree shared by every atom of the chunk.
 */
export interface TextRunLayout {
	readonly atomType: TreeNodeSchemaIdentifier;
	readonly contentKey: FieldKey;
	readonly characterType: TreeNodeSchemaIdentifier;
	readonly characterKey: FieldKey;
	readonly leafType: TreeNodeSchemaIdentifier;
	readonly formatKey: FieldKey;
}

/**
 * Creates a chunk holding one formatted text atom, laid out as {@link TextRunLayout} describes,
 * with `content` (a chunk holding the atom's content node) and `format`.
 * @remarks
 * Takes ownership of one reference to each of `content` and `format`. The returned chunk has ref count 1.
 */
export function formattedAtomChunk(
	layout: TextRunLayout,
	content: TreeChunk,
	format: TreeChunk,
): BasicChunk {
	return new BasicChunk(
		layout.atomType,
		new Map<FieldKey, TreeChunk[]>([
			[layout.contentKey, [content]],
			[layout.formatKey, [format]],
		]),
	);
}

/**
 * A chunk holding a run of text atoms which all have the same format: one atom per Unicode code point of {@link TextRunChunk.text},
 * each laid out as described by {@link TextRunLayout}.
 *
 * @remarks
 * Stores the run as one string and one format subtree, instead of a format subtree per atom.
 * Cursors over this chunk read the same nodes as cursors over the equivalent per-atom content,
 * so how text is stored does not affect anything read through cursors, such as encoded content.
 *
 * Like other chunks, this is immutable while shared: editing an atom of the run splits it
 * (see {@link TextRunChunk.slice} and {@link TextRunChunk.atomChunk}).
 */
export class TextRunChunk extends ReferenceCountedBase implements TreeChunk {
	public readonly topLevelLength: number;

	/**
	 * The offset in {@link TextRunChunk.text} of the start of each atom, followed by the length of the text.
	 * Undefined when every atom is a single UTF-16 code unit, in which case atom `i` starts at offset `i`.
	 */
	private readonly offsets: Uint32Array | undefined;

	/**
	 * Create a chunk with ref count 1.
	 *
	 * @param layout - The node types and keys of the atoms.
	 * @param text - The text of the run: must not be empty.
	 * @param format - The format subtree of every atom: a chunk with a top level length of one.
	 * This chunk takes ownership of one reference to it.
	 */
	public constructor(
		public readonly layout: TextRunLayout,
		public readonly text: string,
		public readonly format: TreeChunk,
	) {
		super();
		assert(text.length > 0, "A text run must not be empty");
		assert(format.topLevelLength === 1, "A text run's format must be a single node");
		if (/[\uD800-\uDFFF]/.test(text)) {
			const offsets: number[] = [];
			let offset = 0;
			for (const character of text) {
				offsets.push(offset);
				offset += character.length;
			}
			offsets.push(offset);
			this.offsets = Uint32Array.from(offsets);
			this.topLevelLength = offsets.length - 1;
		} else {
			this.offsets = undefined;
			this.topLevelLength = text.length;
		}
	}

	/**
	 * The offset in {@link TextRunChunk.text} at which atom `index` starts.
	 * `index` may be {@link TextRunChunk.topLevelLength}, for the end of the text.
	 */
	public textOffset(index: number): number {
		return this.offsets === undefined ? index : (this.offsets[index] ?? oob());
	}

	/**
	 * The character of atom `index`.
	 */
	public characterAt(index: number): string {
		return this.text.slice(this.textOffset(index), this.textOffset(index + 1));
	}

	/**
	 * The text of atoms `[start, end)`.
	 */
	public textOf(start: number, end: number): string {
		return this.text.slice(this.textOffset(start), this.textOffset(end));
	}

	/**
	 * A new chunk, with ref count 1, holding atoms `[start, end)` of this chunk (which must not be empty) and sharing its format.
	 */
	public slice(start: number, end: number): TextRunChunk {
		assert(0 <= start && start < end && end <= this.topLevelLength, "Invalid text run slice");
		this.format.referenceAdded();
		return new TextRunChunk(this.layout, this.textOf(start, end), this.format);
	}

	/**
	 * A new {@link BasicChunk}, with ref count 1, holding atom `index` of this chunk and sharing its format.
	 */
	public atomChunk(index: number): BasicChunk {
		this.format.referenceAdded();
		return this.atomChunkBorrowingFormat(index);
	}

	/**
	 * A {@link BasicChunk} holding atom `index` of this chunk, which refers to this chunk's format without owning a reference to it.
	 * @remarks
	 * Only for reading while this chunk is referenced: see {@link TextRunChunk.atomChunk} for a chunk which can be kept.
	 */
	public atomChunkBorrowingFormat(index: number): BasicChunk {
		const { characterType, characterKey, leafType } = this.layout;
		const leaf = new BasicChunk(leafType, new Map(), this.characterAt(index));
		const character = new BasicChunk(characterType, new Map([[characterKey, [leaf]]]));
		return formattedAtomChunk(this.layout, character, this.format);
	}

	public cursor(): ChunkedCursor {
		return new TextRunCursor(this, -1, undefined);
	}

	protected onUnreferenced(): void {
		this.format.referenceRemoved();
	}
}

/**
 * Cursor over a {@link TextRunChunk}.
 *
 * @remarks
 * Handles the root field and the top-level atoms itself.
 * Below an atom, it delegates to a cursor over a {@link BasicChunk} holding just that atom,
 * which is created when the cursor enters the atom's fields.
 */
class TextRunCursor extends SynchronousCursor implements ChunkedCursor {
	/**
	 * @param chunk - The chunk this cursor reads.
	 * @param index - The index of the current atom, or -1 when in the root field.
	 * @param nested - When below an atom, a cursor over that atom (see {@link TextRunChunk.atomChunkBorrowingFormat})
	 * which this cursor delegates to.
	 */
	public constructor(
		private readonly chunk: TextRunChunk,
		private index: number,
		private nested: ChunkedCursor | undefined,
	) {
		super();
	}

	public get [cursorChunk](): TreeChunk | undefined {
		if (this.nested !== undefined) {
			return this.nested[cursorChunk];
		}
		assert(this.index >= 0, "cursorChunk is only available in nodes mode");
		return this.chunk;
	}

	public atChunkRoot(): boolean {
		return this.nested === undefined;
	}

	public fork(): ChunkedCursor {
		return new TextRunCursor(this.chunk, this.index, this.nested?.fork());
	}

	public get mode(): CursorLocationType {
		if (this.nested !== undefined) {
			return this.nested.mode;
		}
		return this.index < 0 ? CursorLocationType.Fields : CursorLocationType.Nodes;
	}

	/**
	 * Creates {@link TextRunCursor.nested} at the current atom.
	 */
	private enterAtom(): ChunkedCursor {
		assert(this.nested === undefined && this.index >= 0, "Must be at an atom");
		const nested = this.chunk.atomChunkBorrowingFormat(this.index).cursor();
		nested.enterNode(0);
		this.nested = nested;
		return nested;
	}

	/**
	 * Drops {@link TextRunCursor.nested} if it has returned to the atom it was created at.
	 */
	private leaveAtomIfAtRoot(): void {
		if (this.nested?.atChunkRoot() === true) {
			debugAssert(
				() =>
					this.nested?.mode === CursorLocationType.Nodes ||
					"nested cursor should be at its atom",
			);
			this.nested = undefined;
		}
	}

	/**
	 * The prefix to give the nested cursor, whose atom is at index 0 of its root field, for paths to match this cursor's.
	 */
	private nestedPrefix(prefix: PathRootPrefix | undefined): PathRootPrefix {
		return {
			parent: prefix?.parent,
			rootFieldOverride: prefix?.rootFieldOverride,
			indexOffset: (prefix?.indexOffset ?? 0) + this.index,
		};
	}

	public getFieldKey(): FieldKey {
		if (this.nested !== undefined) {
			return this.nested.getFieldKey();
		}
		assert(this.index < 0, "Must be in fields mode");
		return dummyRoot;
	}

	public getFieldLength(): number {
		if (this.nested !== undefined) {
			return this.nested.getFieldLength();
		}
		assert(this.index < 0, "Must be in fields mode");
		return this.chunk.topLevelLength;
	}

	public enterNode(childIndex: number): void {
		if (this.nested !== undefined) {
			this.nested.enterNode(childIndex);
			return;
		}
		assert(this.index < 0, "Must be in fields mode");
		assert(
			childIndex >= 0 && childIndex < this.chunk.topLevelLength,
			"Index must be within the run",
		);
		this.index = childIndex;
	}

	public getPath(prefix?: PathRootPrefix): UpPath | undefined {
		if (this.nested !== undefined) {
			return this.nested.getPath(this.nestedPrefix(prefix));
		}
		assert(this.index >= 0, "Must be in nodes mode");
		return prefixPath(prefix, {
			parent: undefined,
			parentField: dummyRoot,
			parentIndex: this.index,
		});
	}

	public getFieldPath(prefix?: PathRootPrefix): FieldUpPath {
		if (this.nested !== undefined) {
			return this.nested.getFieldPath(this.nestedPrefix(prefix));
		}
		assert(this.index < 0, "Must be in fields mode");
		return prefixFieldPath(prefix, { parent: undefined, field: dummyRoot });
	}

	public enterField(key: FieldKey): void {
		(this.nested ?? this.enterAtom()).enterField(key);
	}

	public firstField(): boolean {
		if (this.nested !== undefined) {
			return this.nested.firstField();
		}
		const entered = this.enterAtom().firstField();
		debugAssert(() => entered || "atoms have fields");
		return entered;
	}

	public nextField(): boolean {
		assert(this.nested !== undefined, "Must be in a field of an atom");
		const moved = this.nested.nextField();
		if (!moved) {
			this.leaveAtomIfAtRoot();
		}
		return moved;
	}

	public exitField(): void {
		assert(this.nested !== undefined, "Cannot exit the root field");
		this.nested.exitField();
		this.leaveAtomIfAtRoot();
	}

	public firstNode(): boolean {
		if (this.nested !== undefined) {
			return this.nested.firstNode();
		}
		assert(this.index < 0, "Must be in fields mode");
		this.index = 0;
		return true;
	}

	public nextNode(): boolean {
		if (this.nested !== undefined) {
			return this.nested.nextNode();
		}
		return this.seekNodes(1);
	}

	public seekNodes(offset: number): boolean {
		if (this.nested !== undefined) {
			return this.nested.seekNodes(offset);
		}
		assert(this.index >= 0, "Must be in nodes mode");
		const index = this.index + offset;
		if (index >= 0 && index < this.chunk.topLevelLength) {
			this.index = index;
			return true;
		}
		this.index = -1;
		return false;
	}

	public exitNode(): void {
		if (this.nested !== undefined) {
			this.nested.exitNode();
			return;
		}
		assert(this.index >= 0, "Must be in nodes mode");
		this.index = -1;
	}

	public get type(): TreeType {
		if (this.nested !== undefined) {
			return this.nested.type;
		}
		assert(this.index >= 0, "Must be in nodes mode");
		return this.chunk.layout.atomType;
	}

	public get value(): Value {
		if (this.nested !== undefined) {
			return this.nested.value;
		}
		assert(this.index >= 0, "Must be in nodes mode");
		return undefined;
	}

	public get fieldIndex(): number {
		if (this.nested !== undefined) {
			return this.nested.fieldIndex;
		}
		assert(this.index >= 0, "Must be in nodes mode");
		return this.index;
	}

	public get chunkStart(): number {
		return this.nested === undefined ? 0 : this.nested.chunkStart;
	}

	public get chunkLength(): number {
		return this.nested === undefined ? this.chunk.topLevelLength : this.nested.chunkLength;
	}
}

/**
 * Key of the property marking a node of plain (verbose) content as a text run: see {@link VerboseTextRun}.
 */
export const verboseTextRun: unique symbol = Symbol("verboseTextRun");

/**
 * What a node of plain content marked with {@link verboseTextRun} stands for: one atom per Unicode code point of
 * `text`, laid out as `layout` describes, each with the node's {@link TextRunLayout.formatKey} field as its format.
 * @remarks
 * Chunking such content gives a {@link TextRunChunk}.
 */
export interface VerboseTextRun {
	readonly text: string;
	readonly layout: TextRunLayout;
}
