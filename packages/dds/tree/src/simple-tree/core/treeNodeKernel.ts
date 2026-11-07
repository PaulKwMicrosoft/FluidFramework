/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { createEmitter } from "@fluid-internal/client-utils";
import type { HasListeners, Listenable, Off } from "@fluidframework/core-interfaces/internal";
import {
	assert,
	fail,
	debugAssert,
	oob,
	unreachableCase,
} from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import {
	anchorSlot,
	type AnchorEvents,
	type AnchorNode,
	type DeltaMark,
	type FieldKey,
	type TreeValue,
} from "../../core/index.js";
import { getOrCreateHydratedFlexTreeNode } from "../../feature-libraries/index.js";
import {
	ContextSlot,
	disposeHydratedFlexTreeNode,
	flexTreeSlot,
	LazyEntity,
	TreeStatus,
	treeStatusFromAnchorCache,
	type FlexTreeNode,
	type HydratedFlexTreeNode,
} from "../../feature-libraries/index.js";

import type { Context, HydratedContext } from "./context.js";
import type { TreeNode } from "./treeNode.js";
import { NodeKind, type TreeNodeSchema } from "./treeNodeSchema.js";
import type { InternalTreeNode, Unhydrated } from "./types.js";
import { UnhydratedFlexTreeNode } from "./unhydratedFlexTree.js";

/**
 * Key of the slot holding a {@link TreeNode}'s {@link TreeNodeKernel}, on the node or, for nodes implemented as proxies, on the proxy's target.
 * @remarks
 * Each kind of node whose node is a proxy forwards reads and definitions of this key to its target, and hides the key from enumeration.
 *
 * The kernel is kept on the node rather than in a module-level `WeakMap` from node to kernel:
 * such a map's backing table keeps the size it reached at its peak number of live nodes, even after those nodes are collected.
 */
export const kernelSlot: unique symbol = Symbol("TreeNodeKernel");

/**
 * The kernel of `candidate` if it is a {@link TreeNode}.
 * @remarks
 * Checks that the kernel is for `candidate` itself, so objects which inherit from a node are not mistaken for it.
 */
function tryGetKernel(candidate: unknown): TreeNodeKernel | undefined {
	if (typeof candidate !== "object" || candidate === null) {
		return undefined;
	}
	const kernel = (candidate as { [kernelSlot]?: unknown })[kernelSlot];
	return kernel instanceof TreeNodeKernel && kernel.node === candidate ? kernel : undefined;
}

export function getKernel(node: TreeNode): TreeNodeKernel {
	const kernel = tryGetKernel(node);
	assert(kernel !== undefined, 0x9b1 /* Expected tree node to have kernel */);
	return kernel;
}

/**
 * Detects if the given 'candidate' is a TreeNode.
 *
 * @remarks
 * Supports both Hydrated and {@link Unhydrated} TreeNodes, both of which return true.
 *
 * Because the common usage is to check if a value being inserted/set is a TreeNode,
 * this function permits calling with primitives as well as objects.
 *
 * Primitives will always return false (as they are copies of data, not references to nodes).
 *
 * @param candidate - Value which may be a TreeNode
 * @returns true if the given 'candidate' is a hydrated TreeNode.
 */
export function isTreeNode(candidate: unknown): candidate is TreeNode | Unhydrated<TreeNode> {
	return tryGetKernel(candidate) !== undefined;
}

/**
 * Returns a schema for a value if the value is a {@link TreeNode}.
 *
 * Returns undefined for other values.
 * @remarks
 * Does not give schema for a {@link TreeLeafValue}.
 */
export function tryGetTreeNodeSchema(value: unknown): undefined | TreeNodeSchema {
	const kernel = tryGetKernel(value);
	return kernel?.schema;
}

/** The {@link HydrationState} of a {@link TreeNodeKernel} before the kernel is hydrated */
interface UnhydratedState {
	readonly innerNode: UnhydratedFlexTreeNode;
}

/** The {@link HydrationState} of a {@link TreeNodeKernel} after the kernel is hydrated */
interface HydratedState {
	/** The flex node for this kernel */
	readonly innerNode: HydratedFlexTreeNode;
	/** All {@link Off | event deregistration functions} that should be run when the kernel is disposed. */
	readonly offAnchorNode: readonly Off[];
}

/**
 * The {@link HydrationState} of a {@link TreeNodeKernel} after {@link TreeNodeKernel.release}.
 * @remarks
 * A released kernel holds nothing from the tree, so it does not keep the tree's objects for its node alive.
 */
interface ReleasedState {
	readonly innerNode: undefined;
}

const releasedState: ReleasedState = { innerNode: undefined };

/** State within a {@link TreeNodeKernel} that is related to the hydration process */
type HydrationState = UnhydratedState | HydratedState | ReleasedState;

/** True if and only if the given {@link HydrationState} is post-hydration and not released */
function isHydrated(state: HydrationState): state is HydratedState {
	return state.innerNode?.isHydrated() === true;
}

function releasedNodeError(): UsageError {
	return new UsageError(
		"This node was released by TreeAlpha.release and cannot be used. Read it again from its parent.",
	);
}

/**
 * Contains state and an internal API for managing {@link TreeNode}s.
 * @remarks All {@link TreeNode}s have an associated kernel object.
 * The kernel has the same lifetime as the node and spans both its unhydrated and hydrated states.
 */
export class TreeNodeKernel {
	private disposed = false;

	/**
	 * Generation number which is incremented any time we have an edit on the node.
	 * Used during iteration to make sure there has been no edits that were concurrently made.
	 * @remarks
	 * This is updated monotonically by this class when edits are applied to the children of array nodes (the only nodes which use it).
	 * TODO: update this when applying edits to unhydrated trees.
	 *
	 * If TypeScript supported making this immutable from outside the class without making it readonly from inside, that would be used here,
	 * but they only way to do that is add a separate public accessor and make it private, which was deemed not worth the boilerplate, runtime overhead and bundle size.
	 */
	public generationNumber: number = 0;

	#hydrationState: HydrationState;

	/**
	 * Handler for events listeners registered with the kernel.
	 *
	 * @remarks
	 * Supports event buffering via {@link withBufferedEvents}.
	 *
	 * Allocated lazily on first access to {@link TreeNodeKernel.events}.
	 * We expect the majority of nodes to never have event listeners registered, so
	 * deferring construction avoids per-kernel allocations.
	 */
	#eventBuffer: KernelEventBuffer | undefined;

	/**
	 * Create a TreeNodeKernel which can be looked up with {@link getKernel}.
	 *
	 * @param initialContext - context from when this node was originally created.
	 * Only used when unhydrated, so a node created hydrated has none.
	 * @param innerNode - When unhydrated the MapTreeNode. Otherwise HydratedFlexTreeNode.
	 * @remarks
	 * Exactly one kernel per TreeNode should be created.
	 */
	public constructor(
		public readonly node: TreeNode,
		public readonly schema: TreeNodeSchema,
		innerNode: InnerNode,
		private readonly initialContext: Context | undefined,
	) {
		splitInnerNodeType(innerNode);

		assert(tryGetKernel(node) === undefined, 0xa1a /* only one kernel per node can be made */);
		const attached = Reflect.defineProperty(node, kernelSlot, {
			value: this,
			enumerable: false,
			writable: false,
			configurable: true,
		});
		assert(attached && tryGetKernel(node) === this, "Node must hold its kernel");

		if (innerNode instanceof UnhydratedFlexTreeNode) {
			// Unhydrated case

			debugAssert(() => innerNode.treeNode === undefined);
			innerNode.treeNode = node;

			this.#hydrationState = {
				innerNode,
			};
		} else {
			// Hydrated case
			this.#hydrationState = this.createHydratedState(innerNode);
		}
	}

	public get context(): Context {
		const state = this.#hydrationState;
		if (isHydrated(state)) {
			// This can't be cached on this.#hydrated during hydration since initial tree is hydrated before the context is cached on the anchorSet.
			return (
				state.innerNode.anchorNode.anchorSet.slots.get(SimpleContextSlot) ??
				fail(0xb40 /* missing simple-tree context */)
			);
		}
		if (state.innerNode === undefined) {
			throw releasedNodeError();
		}
		return this.initialContext ?? fail("An unhydrated node must have its initial context");
	}

	/**
	 * Transition from {@link Unhydrated} to hydrated.
	 * Bi-directionally associates the given hydrated TreeNode to the HydratedFlexTreeNode.
	 * @remarks
	 * Happens at most once for any given node.
	 * Cleans up mappings to {@link UnhydratedFlexTreeNode} - it is assumed that they are no longer needed once this node has an anchor node.
	 */
	public hydrate(inner: HydratedFlexTreeNode): void {
		assert(!this.disposed, 0xa2a /* cannot hydrate a disposed node */);
		assert(!isHydrated(this.#hydrationState), 0xa2b /* hydration should only happen once */);

		this.#hydrationState = this.createHydratedState(inner);

		// Lazily migrate existing event listeners to the anchor node.
		// If no one ever subscribed to this kernel's events, the buffer was never allocated
		// and there is nothing to migrate.
		this.#eventBuffer?.migrateEventSource(inner.anchorNode.events);
	}

	/**
	 * Whether this node was first read in a read scope (see {@link runReadScope}), and is thus released when the scope ends.
	 */
	#inReadScope = false;
	private createHydratedState(innerNode: HydratedFlexTreeNode): HydratedState {
		assert(
			!innerNode.anchorNode.slots.has(simpleTreeNodeSlot),
			0x7f5 /* Cannot associate an flex node with multiple simple-tree nodes */,
		);
		innerNode.anchorNode.slots.set(simpleTreeNodeSlot, this.node);
		if (readScopeKernels !== undefined) {
			this.#inReadScope = true;
			readScopeKernels.push(this);
		}
		const offAnchorNode: Off[] = [
			innerNode.anchorNode.events.on("afterDestroy", () => this.dispose()),
		];
		// Only array nodes read the generation number, so only they need to track it.
		if (this.schema.kind === NodeKind.Array) {
			offAnchorNode.push(
				// TODO: this should be triggered on change even for unhydrated nodes.
				innerNode.anchorNode.events.on("childrenChanging", () => {
					this.generationNumber += 1;
				}),
			);
		}
		return { innerNode, offAnchorNode };
	}

	public getStatus(): TreeStatus {
		if (this.disposed) {
			if (this.#hydrationState === releasedState) {
				throw releasedNodeError();
			}
			return TreeStatus.Deleted;
		}
		if (!isHydrated(this.#hydrationState)) {
			return TreeStatus.New;
		}

		// TODO: Replace this check with the proper check against the cursor state when the cursor becomes part of the kernel
		const flex = this.#hydrationState.innerNode.anchorNode.slots.get(flexTreeSlot);
		if (flex !== undefined) {
			assert(flex instanceof LazyEntity, 0x9b4 /* Unexpected flex node implementation */);
			if (flex.isFreed()) {
				return TreeStatus.Deleted;
			}
		}

		return treeStatusFromAnchorCache(this.#hydrationState.innerNode.anchorNode);
	}

	public get events(): Listenable<KernelEvents> {
		const state = this.#getUnreleasedState();
		if (this.#inReadScope) {
			throw new UsageError(
				"Nodes first read in a read scope cannot be subscribed to: they are released when the scope ends. Read the node outside the scope to subscribe to it.",
			);
		}
		assert(!this.disposed, 0xcfa /* Cannot register events on a disposed node */);
		// Allocate the buffer on first access. See {@link TreeNodeKernel.#eventBuffer} for rationale.
		if (this.#eventBuffer === undefined) {
			const eventSource = isHydrated(state)
				? state.innerNode.anchorNode.events
				: state.innerNode.events;
			this.#eventBuffer = new KernelEventBuffer(eventSource);
		}
		return this.#eventBuffer;
	}

	/**
	 * Whether any listeners are registered on {@link TreeNodeKernel.events}.
	 */
	public hasEventListeners(): boolean {
		return this.#eventBuffer?.hasListeners() === true;
	}

	public dispose(): void {
		debugAssert(() => !this.disposed || "Cannot dispose a disposed node");
		this.disposed = true;
		if (isHydrated(this.#hydrationState)) {
			for (const off of this.#hydrationState.offAnchorNode) {
				off();
			}
		}
		this.#eventBuffer?.dispose();
		// TODO: go to the context and remove myself from withAnchors
	}

	public isHydrated(): this is { anchorNode: AnchorNode; context: HydratedContext } {
		// A released node counts as hydrated, although accessing its anchorNode or context throws.
		return isHydrated(this.#hydrationState) || this.#hydrationState === releasedState;
	}

	/**
	 * Whether {@link TreeNodeKernel.release} was called on this kernel.
	 */
	public isReleased(): boolean {
		return this.#hydrationState === releasedState;
	}

	/**
	 * Detaches this hydrated node from the tree, after which every use of the node throws a usage error.
	 * @remarks
	 * Afterwards, the kernel references none of the tree's objects for this node,
	 * and the node is not cached on its anchor node, so reading the same location again creates a new node.
	 * The node's flex tree node is not disposed: see {@link releaseTreeNode}.
	 */
	public release(): void {
		const state = this.#hydrationState;
		assert(isHydrated(state) && !this.disposed, "Only nodes in a tree can be released");
		assert(!this.hasEventListeners(), "Nodes with event listeners cannot be released");
		for (const off of state.offAnchorNode) {
			off();
		}
		state.innerNode.anchorNode.slots.delete(simpleTreeNodeSlot);
		// Without listeners, the event buffer has no subscriptions to remove and no one to deliver events to.
		// Dropping it releases its reference to the anchor node's events.
		this.#eventBuffer = undefined;
		this.disposed = true;
		this.#hydrationState = releasedState;
	}

	public get anchorNode(): AnchorNode | undefined {
		const state = this.#getUnreleasedState();
		return isHydrated(state) ? state.innerNode.anchorNode : undefined;
	}

	/**
	 * Retrieves the flex node associated with the given target.
	 * @remarks
	 * For {@link Unhydrated} nodes, this returns the MapTreeNode.
	 *
	 * For hydrated nodes it returns a FlexTreeNode backed by the forest.
	 *
	 * @throws A {@link @fluidframework/telemetry-utils#UsageError} if the node has been deleted.
	 */
	public getInnerNode(): InnerNode {
		const state = this.#hydrationState;
		if (!isHydrated(state)) {
			if (state.innerNode === undefined) {
				throw releasedNodeError();
			}
			debugAssert(
				() =>
					state.innerNode.context.isDisposed() === false ||
					"Unhydrated node should never be disposed",
			);
			return state.innerNode; // Unhydrated case
		}

		if (this.disposed) {
			throw new UsageError("Cannot access a deleted node.");
		}

		return state.innerNode;
	}

	/**
	 * Retrieves the {@link UnhydratedFlexTreeNode} if unhydrated. otherwise undefined.
	 */
	public getInnerNodeIfUnhydrated(): UnhydratedFlexTreeNode | undefined {
		const state = this.#getUnreleasedState();
		if (isHydrated(state)) {
			return undefined;
		}
		return state.innerNode;
	}

	/**
	 * Gets {@link TreeNodeKernel.#hydrationState}.
	 * @throws A {@link @fluidframework/telemetry-utils#UsageError} if this node has been released.
	 */
	#getUnreleasedState(): UnhydratedState | HydratedState {
		const state = this.#hydrationState;
		if (state.innerNode === undefined) {
			throw releasedNodeError();
		}
		return state;
	}
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const kernelEvents = ["childrenChangedAfterBatch", "subtreeChangedAfterBatch"] as const;

type KernelEvents = Pick<AnchorEvents, (typeof kernelEvents)[number]>;

// #region TreeNodeEventBuffer

/**
 * Whether or not events from {@link TreeNodeKernel} should be buffered instead of emitted immediately.
 */
let bufferTreeEvents: boolean = false;

/**
 * Call the provided callback with {@link TreeNode}s' events paused until after the callback's completion.
 *
 * Events that would otherwise have been emitted immediately are merged and buffered until after the
 * provided callback has been completed.
 *
 * @remarks
 * Note: this should be used with caution. User application behaviors are implicitly coupled to event timing.
 * Disrupting this timing can lead to unexpected behavior.
 */
export function withBufferedTreeEvents(callback: () => void): void {
	if (bufferTreeEvents) {
		// Already buffering - just run the callback
		callback();
	} else {
		bufferTreeEvents = true;
		const toFlush: KernelEventBuffer[] = [];
		try {
			callback();
		} finally {
			bufferTreeEvents = false;
			// Snapshot-and-clear before flushing to safely handle reentrant `withBufferedTreeEvents`
			// calls made by listeners that fire during `buffer.flush()` below:
			// - Iterating an array means a reentrant call's `clear()` cannot truncate our loop
			//   and cause buffers later in `activeBuffers` to be skipped (and their events dropped).
			// - Clearing up front means the reentrant call starts from an empty set, so its own
			//   finally block only flushes what it buffered - not a re-flush of our remaining buffers.
			toFlush.push(...activeBuffers);
			activeBuffers.clear();
		}

		// Don't flush/emit events in the case of an error
		for (const buffer of toFlush) {
			buffer.flush();
		}
	}
}

/**
 * Set of {@link KernelEventBuffer}s that have accumulated buffered events during the current
 * {@link withBufferedTreeEvents} window and therefore need to be flushed when it ends.
 *
 * @remarks
 * The set should be empty whenever no buffering window is in progress.
 */
const activeBuffers: Set<KernelEventBuffer> = new Set();

/**
 * Test-only accessor for the current size of {@link activeBuffers}.
 * @remarks Only exported for testing purposes. Not intended for any other use.
 */
export function TEST_activeBufferCount(): number {
	return activeBuffers.size;
}

/**
 * Event emitter for {@link TreeNodeKernel}, which optionally buffers events based on {@link bufferTreeEvents}.
 * @remarks When buffering is active, this adds itself to {@link activeBuffers} so that
 * {@link withBufferedTreeEvents} can flush it at the end of the buffering window.
 */
class KernelEventBuffer implements Listenable<KernelEvents> {
	#disposed: boolean = false;

	readonly #events = createEmitter<KernelEvents>();

	#eventSource: Listenable<KernelEvents> & HasListeners<KernelEvents>;
	readonly #disposeSourceListeners: Map<keyof KernelEvents, Off> = new Map();

	/**
	 * Buffer of fields that have changed since events were paused.
	 * When events are flushed, a single {@link AnchorEvents.childrenChangedAfterBatch} event will be emitted
	 * containing the accumulated set of changed fields.
	 */
	readonly #childrenChangedBuffer: Set<FieldKey> = new Set();

	/**
	 * Buffer of field marks accumulated since events were paused.
	 * Emitted alongside the buffered changed-fields set when flushed.
	 */
	readonly #fieldMarksBuffer: Map<FieldKey, readonly DeltaMark[]> = new Map();

	/**
	 * Fields whose marks have been permanently invalidated within the current buffer window due to
	 * two or more separate delta batches touching the same field.
	 * Once a key is in this set it must never be re-added to the marks buffer, even if
	 * a third (or later) batch arrives for that field.
	 */
	readonly #invalidatedFieldMarkKeys: Set<FieldKey> = new Set();

	/**
	 * Whether or not the subtree has changed since events were paused.
	 * When events are flushed, a single {@link AnchorEvents.subTreeChanged} event will be emitted if and only
	 * if the subtree has changed.
	 */
	#subTreeChangedBuffer: boolean = false;

	public constructor(
		/**
		 * Source of the kernel events.
		 * Subscriptions will be created on-demand when listeners are added to this.events,
		 * and those subscriptions will be cleaned up when all corresponding listeners have been removed.
		 */
		eventSource: Listenable<KernelEvents> & HasListeners<KernelEvents>,
	) {
		this.#eventSource = eventSource;
	}

	/**
	 * Migrate this event buffer to a new event source.
	 *
	 * @remarks
	 * Cleans up any existing event subscriptions from the old source.
	 * Binds events to the new source for each event with active listeners.
	 */
	public migrateEventSource(
		newSource: Listenable<KernelEvents> & HasListeners<KernelEvents>,
	): void {
		// Unsubscribe from the old source
		for (const off of this.#disposeSourceListeners.values()) {
			off();
		}
		this.#disposeSourceListeners.clear();

		this.#eventSource = newSource;

		if (this.#events.hasListeners("childrenChangedAfterBatch")) {
			const off = this.#eventSource.on(
				"childrenChangedAfterBatch",
				({ changedFields, fieldMarks }) =>
					this.#emit("childrenChangedAfterBatch", { changedFields, fieldMarks }),
			);
			this.#disposeSourceListeners.set("childrenChangedAfterBatch", off);
		}
		if (this.#events.hasListeners("subtreeChangedAfterBatch")) {
			const off = this.#eventSource.on("subtreeChangedAfterBatch", () =>
				this.#emit("subtreeChangedAfterBatch"),
			);
			this.#disposeSourceListeners.set("subtreeChangedAfterBatch", off);
		}
	}

	public on(eventName: keyof KernelEvents, listener: KernelEvents[typeof eventName]): Off {
		this.#assertNotDisposed();

		// Lazily bind event listeners to the source.
		// If we do not have any existing listeners for this event, then we need to bind to the source.
		if (!this.#events.hasListeners(eventName)) {
			assert(
				!this.#disposeSourceListeners.has(eventName),
				0xc4f /* Should not have a dispose function without listeners */,
			);

			const off: Off =
				eventName === "childrenChangedAfterBatch"
					? this.#eventSource.on(eventName, (args) => this.#emit(eventName, args))
					: this.#eventSource.on(eventName, () => this.#emit(eventName));
			this.#disposeSourceListeners.set(eventName, off);
		}

		this.#events.on(eventName, listener);
		// Return a bound method instead of an arrow closure. A bound function captures
		// (target, thisArg, ...boundArgs) in a fixed shape that V8 can optimize more
		// uniformly than a closure that captures its lexical context.
		return this.off.bind(this, eventName, listener);
	}

	public off(eventName: keyof KernelEvents, listener: KernelEvents[typeof eventName]): void {
		this.#events.off(eventName, listener);

		// If there are no remaining listeners for the event, unbind from the source
		if (!this.#events.hasListeners(eventName)) {
			const off = this.#disposeSourceListeners.get(eventName);
			off?.();
			this.#disposeSourceListeners.delete(eventName);
		}
	}

	public hasListeners(): boolean {
		return this.#events.hasListeners();
	}

	#emit(
		eventName: keyof KernelEvents,
		arg?: {
			changedFields: ReadonlySet<FieldKey>;
			fieldMarks: ReadonlyMap<FieldKey, readonly DeltaMark[]>;
		},
	): void {
		this.#assertNotDisposed();
		switch (eventName) {
			case "childrenChangedAfterBatch": {
				assert(arg !== undefined, 0xcea /* childrenChangedAfterBatch requires arg */);
				return this.#handleChildrenChangedAfterBatch(arg.changedFields, arg.fieldMarks);
			}
			case "subtreeChangedAfterBatch": {
				return this.#handleSubtreeChangedAfterBatch();
			}
			default: {
				unreachableCase(eventName);
			}
		}
	}

	#handleChildrenChangedAfterBatch(
		changedFields: ReadonlySet<FieldKey>,
		fieldMarks: ReadonlyMap<FieldKey, readonly DeltaMark[]>,
	): void {
		if (bufferTreeEvents) {
			activeBuffers.add(this);
			for (const fieldKey of changedFields) {
				this.#childrenChangedBuffer.add(fieldKey);
			}
			for (const [key, marks] of fieldMarks) {
				if (this.#invalidatedFieldMarkKeys.has(key)) {
					// Already permanently invalidated by an earlier collision; ignore this batch too.
					// TODO: Once the eventing stack is rewritten to walk the composed delta at flush
					// time, this collision path will be unreachable and can be removed entirely.
					continue;
				}
				if (this.#fieldMarksBuffer.has(key)) {
					// A second batch of marks arrived for the same field before the buffer was flushed.
					// We have no delta composition logic, so permanently invalidate this field so that
					// any further batches are also discarded rather than incorrectly surfaced.
					this.#fieldMarksBuffer.delete(key);
					this.#invalidatedFieldMarkKeys.add(key);
				} else {
					this.#fieldMarksBuffer.set(key, marks);
				}
			}
		} else {
			this.#events.emit("childrenChangedAfterBatch", { changedFields, fieldMarks });
		}
	}

	#handleSubtreeChangedAfterBatch(): void {
		if (bufferTreeEvents) {
			activeBuffers.add(this);
			this.#subTreeChangedBuffer = true;
		} else {
			this.#events.emit("subtreeChangedAfterBatch");
		}
	}

	/**
	 * Flushes any events buffered due to {@link withBufferedTreeEvents}.
	 */
	public flush(): void {
		this.#assertNotDisposed();

		if (this.#childrenChangedBuffer.size > 0) {
			this.#events.emit("childrenChangedAfterBatch", {
				changedFields: this.#childrenChangedBuffer,
				fieldMarks: this.#fieldMarksBuffer,
			});
			this.#childrenChangedBuffer.clear();
			this.#fieldMarksBuffer.clear();
			this.#invalidatedFieldMarkKeys.clear();
		}

		if (this.#subTreeChangedBuffer) {
			this.#events.emit("subtreeChangedAfterBatch");
			this.#subTreeChangedBuffer = false;
		}
	}

	#assertNotDisposed(): void {
		assert(!this.#disposed, 0xc51 /* Event handler disposed. */);
	}

	public dispose(): void {
		if (this.#disposed) {
			return;
		}

		debugAssert(
			() =>
				(this.#childrenChangedBuffer.size === 0 && !this.#subTreeChangedBuffer) ||
				"Buffered kernel events should have been flushed before disposing.",
		);
		debugAssert(
			() => !activeBuffers.has(this) || "Disposed buffer should not be in activeBuffers.",
		);

		for (const off of this.#disposeSourceListeners.values()) {
			off();
		}
		this.#disposeSourceListeners.clear();

		this.#childrenChangedBuffer.clear();
		this.#fieldMarksBuffer.clear();
		this.#invalidatedFieldMarkKeys.clear();
		this.#subTreeChangedBuffer = false;

		this.#disposed = true;
	}
}

// #endregion

/**
 * For hydrated nodes this is a HydratedFlexTreeNode thats a projection of forest content.
 * For {@link Unhydrated} nodes this is a UnhydratedFlexTreeNode.
 */
export type InnerNode = FlexTreeNode;

/**
 * Narrows innerNode to either {@link UnhydratedFlexTreeNode} or {@link HydratedFlexTreeNode}.
 */
export function splitInnerNodeType(
	innerNode: InnerNode,
): asserts innerNode is UnhydratedFlexTreeNode | HydratedFlexTreeNode {
	assert(
		innerNode instanceof UnhydratedFlexTreeNode || innerNode.isHydrated(),
		0xbc8 /* Invalid inner node type */,
	);
}

/**
 * An anchor slot which associates an anchor with its corresponding {@link TreeNode}, if there is one.
 * @remarks
 * For this to work, we have to require that there is at most a single view using a given AnchorSet.
 * FlexTree already has this assumption, and we also assume there is a single simple-tree per FlexTree, so this is valid.
 */
export const simpleTreeNodeSlot = anchorSlot<TreeNode>();

/**
 * Dispose a TreeNode (if any) for an existing anchor without disposing the anchor.
 */
export function tryDisposeTreeNode(anchorNode: AnchorNode): void {
	const treeNode = anchorNode.slots.get(simpleTreeNodeSlot);
	if (treeNode !== undefined) {
		const kernel = getKernel(treeNode);
		kernel.dispose();
		anchorNode.slots.delete(simpleTreeNodeSlot);
	}
}

/**
 * Kernels of the nodes first read in the current read scope, if one is running.
 */
let readScopeKernels: TreeNodeKernel[] | undefined;

/**
 * Runs `read` in a read scope: nodes first read during it (whose {@link TreeNode}s are created during it) are released when it ends.
 * @param lockEdits - Runs its argument with edits to the tree forbidden.
 * @remarks
 * Implements {@link (TreeAlpha:interface).readScope}.
 * Nodes which existed before the scope are not affected, including those under nodes first read in it.
 * @throws A usage error if called inside another read scope.
 */
export function runReadScope<T>(
	lockEdits: <TResult>(fn: () => TResult) => TResult,
	read: () => T,
): T {
	if (readScopeKernels !== undefined) {
		throw new UsageError("Read scopes cannot be nested.");
	}
	const kernels: TreeNodeKernel[] = [];
	readScopeKernels = kernels;
	try {
		return lockEdits(read);
	} finally {
		readScopeKernels = undefined;
		// Release children (read after their parents) first.
		for (let index = kernels.length - 1; index >= 0; index--) {
			const kernel = kernels[index] ?? oob();
			if (kernel.isReleased() || kernel.getStatus() === TreeStatus.Deleted) {
				continue;
			}
			const anchorNode = kernel.anchorNode ?? fail("A hydrated node has an anchor node");
			kernel.release();
			disposeHydratedFlexTreeNode(anchorNode);
		}
	}
}
/**
 * Releases the objects created for reading a hydrated `node` and every node under it which has been read:
 * their {@link TreeNode}s and kernels, their flex tree nodes and fields, and the anchors holding them.
 * @remarks
 * The tree's content is not changed.
 * Afterwards, every use of the released {@link TreeNode}s throws a usage error, and reading the same locations again creates new nodes.
 * See {@link (TreeAlpha:interface).release} for details.
 */
export function releaseTreeNode(node: TreeNode): void {
	const kernel = getKernel(node);
	if (kernel.isReleased()) {
		return;
	}
	const status = kernel.getStatus();
	if (status === TreeStatus.New) {
		throw new UsageError(
			"Only nodes in a tree can be released. Unhydrated nodes hold nothing from a tree: drop references to them instead.",
		);
	}
	if (status === TreeStatus.Deleted) {
		return;
	}
	assert(kernel.isHydrated(), "Nodes which are not new must be hydrated");
	const root = kernel.anchorNode;
	if (root.anchorSet.isUpdating()) {
		throw new UsageError("Nodes cannot be released while the tree is being changed.");
	}

	// Each anchor node precedes its descendants.
	const anchorNodes: AnchorNode[] = [root];
	for (const anchorNode of anchorNodes) {
		const treeNode = anchorNode.slots.get(simpleTreeNodeSlot);
		if (treeNode !== undefined && getKernel(treeNode).hasEventListeners()) {
			throw new UsageError(
				"Nodes cannot be released while they, or nodes under them, have event listeners. Remove the listeners first.",
			);
		}
		anchorNodes.push(...anchorNode.anchoredChildren());
	}

	// Release descendants first: an anchor node is disposed once it has no children and nothing references it.
	for (const anchorNode of anchorNodes.reverse()) {
		const treeNode = anchorNode.slots.get(simpleTreeNodeSlot);
		if (treeNode !== undefined) {
			getKernel(treeNode).release();
		}
		disposeHydratedFlexTreeNode(anchorNode);
	}
}

/**
 * Gets the {@link TreeNodeSchema} for the {@link InnerNode}.
 */
export function getSimpleNodeSchemaFromInnerNode(innerNode: InnerNode): TreeNodeSchema {
	const context: Context = getSimpleContextFromInnerNode(innerNode);
	return context.schema.get(innerNode.type) ?? fail(0xb3f /* missing schema from context */);
}

/**
 * Gets the {@link Context} for the {@link InnerNode}.
 */
export function getSimpleContextFromInnerNode(innerNode: InnerNode): Context {
	splitInnerNodeType(innerNode);
	if (innerNode instanceof UnhydratedFlexTreeNode) {
		return innerNode.simpleContext;
	}

	const context = innerNode.anchorNode.anchorSet.slots.get(SimpleContextSlot);
	assert(context !== undefined, 0xa55 /* missing simple tree context */);

	return context;
}

/**
 * Retrieves the flex node associated with the given target.
 * @remarks
 * For {@link Unhydrated} nodes, this returns the MapTreeNode.
 *
 * For hydrated nodes it returns a FlexTreeNode backed by the forest.
 *
 * @throws A {@link @fluidframework/telemetry-utils#UsageError} if the node has been deleted.
 */
export function getInnerNode(treeNode: TreeNode): InnerNode {
	const kernel = getKernel(treeNode);
	return kernel.getInnerNode();
}

/**
 * {@link getInnerNode} for a node implemented as a proxy, called from one of the proxy's traps.
 * @remarks
 * Reads the kernel from the proxy's target, which holds it, so the proxy's traps do not run again.
 * @param target - The proxy's target.
 * @param node - The node (the proxy) the trap was called for.
 */
export function getInnerNodeFromTarget(target: object, node: TreeNode): InnerNode {
	const kernel = (target as { [kernelSlot]?: unknown })[kernelSlot];
	return kernel instanceof TreeNodeKernel && kernel.node === node
		? kernel.getInnerNode()
		: getInnerNode(node);
}

/**
 * Gets a flex node from an anchor node
 */
function flexNodeFromAnchor(anchorNode: AnchorNode): HydratedFlexTreeNode {
	const flexNode = anchorNode.slots.get(flexTreeSlot);
	if (flexNode !== undefined) {
		return flexNode; // If it does have a flex node, return it...
	} // ...otherwise, the flex node must be created
	const context =
		anchorNode.anchorSet.slots.get(ContextSlot) ?? fail(0xb45 /* missing context */);
	const cursor = context.checkout.forest.allocateCursor("getFlexNode");
	context.checkout.forest.moveCursorToPath(anchorNode, cursor);
	const newFlexNode = getOrCreateHydratedFlexTreeNode(context, cursor);
	cursor.free();
	return newFlexNode;
}

/**
 * Gets a tree node from an anchor node
 */
export function treeNodeFromAnchor(anchorNode: AnchorNode): TreeNode | TreeValue {
	const cached = anchorNode.slots.get(simpleTreeNodeSlot);
	if (cached !== undefined) {
		return cached;
	}

	const flexNode = flexNodeFromAnchor(anchorNode);
	return createTreeNodeFromInner(flexNode);
}

/**
 * Constructs a TreeNode from an InnerNode.
 * @remarks
 * This does not do caching or validation: caller must ensure duplicate nodes for a given inner node are not created, and that the inner node is valid.
 */
export function createTreeNodeFromInner(innerNode: InnerNode): TreeNode | TreeValue {
	const classSchema = getSimpleNodeSchemaFromInnerNode(innerNode);
	const internal = innerNode as unknown as InternalTreeNode;
	return typeof classSchema === "function"
		? new classSchema(internal)
		: (classSchema as { create(data: InternalTreeNode): TreeNode | TreeValue }).create(
				internal,
			);
}

/**
 * Creating multiple simple tree contexts for the same branch, and thus with the same underlying AnchorSet does not work due to how TreeNode caching works.
 * This slot is used to detect if one already exists and error if creating a second.
 * @remarks
 * See also {@link ContextSlot} in which the flex-tree context is stored.
 */
export const SimpleContextSlot = anchorSlot<HydratedContext>();
