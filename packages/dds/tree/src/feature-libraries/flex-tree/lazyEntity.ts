/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";

import {
	type ITreeCursorSynchronous,
	type ITreeSubscriptionCursor,
	ITreeSubscriptionCursorState,
	TreeNavigationResult,
} from "../../core/index.js";
import { type IDisposable, disposeSymbol } from "../../util/index.js";

import type { Context } from "./context.js";
import {
	type FlexTreeEntity,
	type FlexTreeEntityKind,
	flexTreeMarker,
} from "./flexTreeTypes.js";

/**
 * Assert `entity` is not deleted.
 * @privateRemarks
 * This can be faster than getting the tree status and checking that since that can require computing removed vs deleted.
 * TODO: provide a non implementation dependent way to leverage this optimization.
 */
export function assertFlexTreeEntityNotFreed(entity: FlexTreeEntity): void {
	assert(entity instanceof LazyEntity, 0x8c9 /* unexpected implementation */);
	assert(!entity.isFreed(), 0x8ca /* Use after free */);
}

/**
 * This is a base class for lazy (cursor based) UntypedEntity implementations, which uniformly handles cursors and anchors.
 */
export abstract class LazyEntity<TAnchor = unknown> implements FlexTreeEntity, IDisposable {
	/**
	 * A cursor at this entity, or undefined if it has none.
	 * @remarks
	 * The cursor is only kept while it is current (see {@link Context.releaseCursors}):
	 * before an edit it is returned to the context (which keeps a few for reuse and frees the rest),
	 * and {@link LazyEntity.cursor} gets one again when next needed.
	 */
	#lazyCursor: ITreeSubscriptionCursor | undefined;
	/**
	 * Whether this entity is in its context's list of cursor holders, which it must be while it holds a cursor.
	 */
	#listed = false;
	#freed = false;
	public readonly anchor: TAnchor;

	protected constructor(
		public readonly context: Context,
		cursor: ITreeSubscriptionCursor,
		anchor: TAnchor,
	) {
		this.anchor = anchor;
		this.#lazyCursor = cursor.fork("LazyEntity Fork");
		this.#addAsCursorHolder();
		this.context.withAnchors.add(this);
	}

	public borrowCursor(): ITreeCursorSynchronous {
		return this.cursor as ITreeCursorSynchronous;
	}

	public abstract get [flexTreeMarker](): FlexTreeEntityKind;

	public [disposeSymbol](): void {
		this.#freed = true;
		const cursor = this.#lazyCursor;
		if (cursor !== undefined) {
			this.#lazyCursor = undefined;
			cursor.free();
			this.context.removeCursorHolder();
		}
		this.forgetAnchor();
		this.context.withAnchors.delete(this);
	}

	/**
	 * Releases this entity's cursor to the context (see {@link Context.releaseCursor}), if it has one.
	 * @remarks
	 * The cursor is obtained again the next time it is needed.
	 */
	public prepareForEdit(): void {
		const cursor = this.#lazyCursor;
		if (cursor !== undefined) {
			this.#lazyCursor = undefined;
			this.context.removeCursorHolder();
			this.context.releaseCursor(cursor);
		}
	}

	/**
	 * Whether this entity holds a cursor.
	 */
	public get holdsCursor(): boolean {
		return this.#lazyCursor !== undefined;
	}

	/**
	 * Gives up this entity's cursor, if any, for {@link Context.releaseCursors}, which also removes it from its list
	 * of cursor holders.
	 */
	public takeCursorForEdit(): ITreeSubscriptionCursor | undefined {
		this.#listed = false;
		const cursor = this.#lazyCursor;
		this.#lazyCursor = undefined;
		return cursor;
	}

	/**
	 * Records that the context removed this entity, which holds no cursor, from its list of cursor holders.
	 */
	public markUnlisted(): void {
		this.#listed = false;
	}

	#addAsCursorHolder(): void {
		this.context.addCursorHolder(this, this.#listed);
		this.#listed = true;
	}

	public isFreed(): boolean {
		return this.#freed;
	}

	/**
	 * Validates this entity's derived state and external references can be safely used.
	 * {@link LazyEntity.cursor} does sufficient validation on its own, so only cases which don't use the cursor must call this.
	 * @remarks
	 * Call this before accessing cached or anchor-derived data that bypasses the cursor getter's lifetime and broken-forest checks.
	 * This check is redundant when the access uses {@link LazyEntity.cursor}.
	 *
	 * @throws If this entity has been freed.
	 * @throws A usage error if the cursor is not current and the forest is broken.
	 */
	protected ensureValidForAccess(): void {
		assert(!this.isFreed(), 0xd93 /* Cannot access a freed FlexTree entity */);
		if (this.#lazyCursor?.state !== ITreeSubscriptionCursorState.Current) {
			this.context.checkout.forest.breaker.use();
		}
	}

	/**
	 * Gets the current cursor for this entity, moving it to the anchor if necessary.
	 * @remarks
	 * Includes validation that it is legal to access this entity via its cursor.
	 * @privateRemarks
	 * This method implicitly relies on the forest to break, clear or continue to support its cursors if the forest becomes broken.
	 */
	public get cursor(): ITreeSubscriptionCursor {
		const held = this.#lazyCursor;
		if (held !== undefined) {
			if (held.state === ITreeSubscriptionCursorState.Current) {
				return held;
			}
			assert(
				held.state === ITreeSubscriptionCursorState.Cleared,
				"Unset cursor should be in cleared state",
			);
			this.#lazyCursor = undefined;
			this.context.removeCursorHolder();
			this.context.releaseCursor(held);
		}
		assert(!this.#freed, 0x778 /* Unset cursor should be in cleared state */);
		assert(
			this.anchor !== undefined,
			0x779 /* FlexTree should have an anchor if it does not have a cursor */,
		);
		const cursor = this.cursorFromParent() ?? this.cursorFromAnchor();
		this.#lazyCursor = cursor;
		this.#addAsCursorHolder();
		return cursor;
	}

	/**
	 * A cursor at this entity, moved there from the root using the anchor.
	 */
	private cursorFromAnchor(): ITreeSubscriptionCursor {
		const cursor = this.context.takeCursor();
		const result = this.tryMoveCursorToAnchor(cursor);
		if (result !== TreeNavigationResult.Ok) {
			this.context.releaseCursor(cursor);
			assert(
				false,
				0x77a /* It is invalid to access a FlexTree node which no longer exists */,
			);
		}
		return cursor;
	}

	/**
	 * A current cursor at this entity derived from the cursor of an entity containing it, if that is cheaper than moving one from the root.
	 */
	protected cursorFromParent(): ITreeSubscriptionCursor | undefined {
		return undefined;
	}

	protected abstract tryMoveCursorToAnchor(
		cursor: ITreeSubscriptionCursor,
	): TreeNavigationResult;

	/**
	 * Called when disposing of this target, iff it has an anchor.
	 */
	protected abstract forgetAnchor(): void;
}
