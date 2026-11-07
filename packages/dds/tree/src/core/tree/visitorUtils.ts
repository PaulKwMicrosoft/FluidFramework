/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { type Breakable, type IdAllocator, idAllocatorFromMaxId } from "../../util/index.js";
import type { RevisionTag } from "../rebase/index.js";
import type { FieldKey } from "../schema-stored/index.js";

import type { ITreeCursorSynchronous } from "./cursor.js";
import type { DetachedNodeId, Mark, Root } from "./delta.js";
import { DetachedFieldIndex } from "./detachedFieldIndex.js";
import type { ForestRootId } from "./detachedFieldIndexTypes.js";
import type { NodeIndex, PlaceIndex, Range } from "./pathTree.js";
import type { TreeValue } from "./types.js";
import { type DeltaVisitor, visitDelta } from "./visitDelta.js";

export function makeDetachedFieldIndex(prefix: string = "Temp"): DetachedFieldIndex {
	return new DetachedFieldIndex(prefix, idAllocatorFromMaxId() as IdAllocator<ForestRootId>);
}

export function applyDelta(
	delta: Root,
	latestRevision: RevisionTag | undefined,
	deltaProcessor: { acquireVisitor: () => DeltaVisitor },
	detachedFieldIndex: DetachedFieldIndex,
): void {
	const visitor = deltaProcessor.acquireVisitor();
	visitDelta(delta, visitor, detachedFieldIndex, latestRevision);
	visitor.free();
}

export interface CombinedVisitor extends DeltaVisitor {
	readonly type: "Combined";

	readonly visitors: readonly CombinableVisitor[];
}

/**
 * A visitor accepted by {@link combineVisitors}.
 *
 * @remarks
 * Plain {@link DeltaVisitor}s are intersected with `{ readonly type?: never }` so this forms a
 * discriminated union with {@link AnnouncedVisitor} and {@link CombinedVisitor}. The optional
 * `never` property permits visitors without a `type`, while preventing a visitor with an unknown
 * or widened `type` from being treated as plain and losing its specialized composition behavior.
 */
export type CombinableVisitor =
	| (DeltaVisitor & { type?: never })
	| AnnouncedVisitor
	| CombinedVisitor;

/**
 * Wraps a visitor so any error breaks the supplied scope and all subsequent calls fail.
 *
 * @remarks
 * The `{ readonly type?: never }` intersection restricts this helper to plain visitors. Wrapping
 * an {@link AnnouncedVisitor} or {@link CombinedVisitor} as a plain visitor would hide its `type`
 * discriminator and prevent {@link combineVisitors} from preserving announced-event ordering or
 * flattening nested combined visitors.
 */
export function makeBreakingVisitor(
	visitor: DeltaVisitor & { readonly type?: never },
	breaker: Breakable,
): DeltaVisitor & { readonly type?: never } {
	return new BreakingVisitor(visitor, breaker);
}

/**
 * The visitor {@link makeBreakingVisitor} returns.
 * @remarks
 * A class, rather than an object of closures, since visitors are made for every change applied,
 * and its methods run {@link Breakable.run}'s logic inline rather than allocating a callback per call.
 */
class BreakingVisitor implements DeltaVisitor {
	public declare readonly type?: never;

	public constructor(
		private readonly visitor: DeltaVisitor,
		private readonly breaker: Breakable,
	) {}

	public free(): void {
		this.breaker.use();
		try {
			this.visitor.free();
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public create(content: readonly ITreeCursorSynchronous[], destination: FieldKey): void {
		this.breaker.use();
		try {
			this.visitor.create(content, destination);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public destroy(detachedField: FieldKey, count: number): void {
		this.breaker.use();
		try {
			this.visitor.destroy(detachedField, count);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public attach(source: FieldKey, count: number, destination: PlaceIndex): void {
		this.breaker.use();
		try {
			this.visitor.attach(source, count, destination);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public detach(
		source: Range,
		destination: FieldKey,
		id: DetachedNodeId,
		isReplaced: boolean,
	): void {
		this.breaker.use();
		try {
			this.visitor.detach(source, destination, id, isReplaced);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public setValue(value: TreeValue): void {
		this.breaker.use();
		try {
			this.visitor.setValue(value);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public enterNode(index: NodeIndex): void {
		this.breaker.use();
		try {
			this.visitor.enterNode(index);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public exitNode(index: NodeIndex): void {
		this.breaker.use();
		try {
			this.visitor.exitNode(index);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public enterField(key: FieldKey): void {
		this.breaker.use();
		try {
			this.visitor.enterField(key);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public exitField(key: FieldKey): void {
		this.breaker.use();
		try {
			this.visitor.exitField(key);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}

	public fieldMarks(marks: readonly Mark[]): void {
		this.breaker.use();
		try {
			this.visitor.fieldMarks?.(marks);
		} catch (error: unknown) {
			this.breaker.rethrowCaught(error);
		}
	}
}

/**
 * Combines multiple visitors into a single visitor.
 * @param visitors - The returned visitor invokes the corresponding events for all these visitors, in order.
 * @returns a DeltaVisitor combining all `visitors`.
 */
export function combineVisitors(visitors: readonly CombinableVisitor[]): CombinedVisitor {
	return new CombinedVisitorImplementation(visitors);
}

/**
 * The visitor {@link combineVisitors} returns.
 * @remarks
 * A class, rather than an object of closures, since visitors are combined for every change applied.
 */
class CombinedVisitorImplementation implements CombinedVisitor {
	public readonly type = "Combined";

	/**
	 * The visitors combined, with those of combined visitors flattened.
	 */
	public readonly visitors: readonly CombinableVisitor[];

	/**
	 * The {@link AnnouncedVisitor}s among {@link CombinedVisitorImplementation.visitors}.
	 */
	private readonly announcedVisitors: readonly AnnouncedVisitor[];

	public constructor(
		/**
		 * The visitors as given, which are each freed once.
		 */
		private readonly inputs: readonly CombinableVisitor[],
	) {
		const visitors: CombinableVisitor[] = [];
		const announcedVisitors: AnnouncedVisitor[] = [];
		for (const input of inputs) {
			for (const visitor of input.type === "Combined" ? input.visitors : [input]) {
				visitors.push(visitor);
				if (visitor.type === "Announced") {
					announcedVisitors.push(visitor);
				}
			}
		}
		this.visitors = visitors;
		this.announcedVisitors = announcedVisitors;
	}

	public free(): void {
		for (const v of this.inputs) {
			v.free();
		}
	}

	public create(content: readonly ITreeCursorSynchronous[], destination: FieldKey): void {
		for (const v of this.visitors) {
			v.create(content, destination);
		}
		for (const v of this.announcedVisitors) {
			v.afterCreate(content, destination);
		}
	}

	public destroy(detachedField: FieldKey, count: number): void {
		for (const v of this.announcedVisitors) {
			v.beforeDestroy(detachedField, count);
		}
		for (const v of this.visitors) {
			v.destroy(detachedField, count);
		}
	}

	public attach(source: FieldKey, count: number, destination: PlaceIndex): void {
		for (const v of this.announcedVisitors) {
			v.beforeAttach(source, count, destination);
		}
		for (const v of this.visitors) {
			v.attach(source, count, destination);
		}
		for (const v of this.announcedVisitors) {
			v.afterAttach(source, {
				start: destination,
				end: destination + count,
			});
		}
	}

	public detach(
		source: Range,
		destination: FieldKey,
		id: DetachedNodeId,
		isReplaced: boolean,
	): void {
		for (const v of this.announcedVisitors) {
			v.beforeDetach(source, destination, isReplaced);
		}
		for (const v of this.visitors) {
			v.detach(source, destination, id, isReplaced);
		}
		for (const v of this.announcedVisitors) {
			v.afterDetach(source.start, source.end - source.start, destination, isReplaced);
		}
	}

	public setValue(value: TreeValue): void {
		for (const v of this.visitors) {
			v.setValue(value);
		}
		for (const v of this.announcedVisitors) {
			v.afterSetValue();
		}
	}

	public enterNode(index: NodeIndex): void {
		for (const v of this.visitors) {
			v.enterNode(index);
		}
	}

	public exitNode(index: NodeIndex): void {
		for (const v of this.visitors) {
			v.exitNode(index);
		}
	}

	public enterField(key: FieldKey): void {
		for (const v of this.visitors) {
			v.enterField(key);
		}
	}

	public exitField(key: FieldKey): void {
		for (const v of this.visitors) {
			v.exitField(key);
		}
	}

	public fieldMarks(marks: readonly Mark[]): void {
		for (const v of this.visitors) {
			v.fieldMarks?.(marks);
		}
	}
}
/**
 * Visitor that is notified of changes before, after, and when changes are made.
 * Must be freed after use.
 */
export interface AnnouncedVisitor extends DeltaVisitor {
	readonly type: "Announced";
	/**
	 * A hook that is called after all nodes have been created.
	 */
	afterCreate(content: readonly ITreeCursorSynchronous[], destination: FieldKey): void;
	beforeDestroy(field: FieldKey, count: number): void;
	beforeAttach(source: FieldKey, count: number, destination: PlaceIndex): void;
	afterAttach(source: FieldKey, destination: Range): void;
	beforeDetach(source: Range, destination: FieldKey, isReplaced: boolean): void;
	afterDetach(
		source: PlaceIndex,
		count: number,
		destination: FieldKey,
		isReplaced: boolean,
	): void;
	/**
	 * A hook that is called after the value of the current node has been set by {@link DeltaVisitor.setValue}.
	 */
	afterSetValue(): void;
}

const noOp = (): void => {};

/**
 * Creates an announced visitor with only the provided functions and uses a no op for the rest.
 * This is provided to make some of the delta visitor definitions cleaner.
 */
export function createAnnouncedVisitor(
	visitorFunctions: Partial<AnnouncedVisitor>,
): AnnouncedVisitor {
	return {
		type: "Announced",
		free: visitorFunctions.free ?? noOp,
		create: visitorFunctions.create ?? noOp,
		afterCreate: visitorFunctions.afterCreate ?? noOp,
		beforeDestroy: visitorFunctions.beforeDestroy ?? noOp,
		destroy: visitorFunctions.destroy ?? noOp,
		beforeAttach: visitorFunctions.beforeAttach ?? noOp,
		attach: visitorFunctions.attach ?? noOp,
		afterAttach: visitorFunctions.afterAttach ?? noOp,
		beforeDetach: visitorFunctions.beforeDetach ?? noOp,
		detach: visitorFunctions.detach ?? noOp,
		afterDetach: visitorFunctions.afterDetach ?? noOp,
		setValue: visitorFunctions.setValue ?? noOp,
		afterSetValue: visitorFunctions.afterSetValue ?? noOp,
		enterNode: visitorFunctions.enterNode ?? noOp,
		exitNode: visitorFunctions.exitNode ?? noOp,
		enterField: visitorFunctions.enterField ?? noOp,
		exitField: visitorFunctions.exitField ?? noOp,
	};
}
