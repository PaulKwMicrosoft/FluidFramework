/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";
import { disposeSymbol } from "../util/index.js";
import { findCommonAncestor, type GraphCommit } from "../core/index.js";
import type {
	ImplicitFieldSchema,
	ITree,
	TreeView,
	TreeViewConfiguration,
	VerboseTree,
} from "../simple-tree/index.js";
import type { ExternalAuthorityOutcome } from "../shared-tree-core/index.js";
import type { ITreePrivate, SharedTreeKernel } from "./sharedTree.js";
import type { TreeCheckout } from "./treeCheckout.js";
import type { SharedTreeChange } from "./sharedTreeChangeTypes.js";
import { hasSchemaChange } from "./sharedTreeChangeFamily.js";

/**
 * An immutable, internally consistent A and A+P cut. It never includes local unsequenced work.
 * @alpha
 */
export interface SharedTreeAuthorityCapture {
	readonly checkpoint: string;
	readonly editIds: readonly string[];
	exportApproved(): VerboseTree | undefined;
	exportSequenced(): VerboseTree | undefined;
	dispose(): void;
}

/**
 * A private, ordinary editable fork of the capture's approved history.
 * Edits do not submit Fluid operations until published as one authority advance.
 * @alpha
 */
export interface SharedTreeAuthorityDraft {
	viewWith<TRoot extends ImplicitFieldSchema>(
		configuration: TreeViewConfiguration<TRoot>,
	): TreeView<TRoot>;
	dispose(): void;
}

/**
 * Exactly one unchanged prefix approval OR an externally authored draft is supported.
 * Approval and transformed replacement together are deliberately unsupported.
 * @alpha @input
 */
export interface SharedTreeAuthorityPublication {
	readonly batchId: string;
	readonly nextCheckpoint: string;
	readonly capture: SharedTreeAuthorityCapture;
	readonly approvePrefix?: number;
	readonly draft?: SharedTreeAuthorityDraft;
}

/**
 * Restricted v1 authority controller. All clients/writers must be trusted.
 * History is retained without bound; runtime summaries are explicitly unsupported.
 * @alpha
 */
export interface SharedTreeAuthorityController {
	capture(): SharedTreeAuthorityCapture;
	createDraft(capture: SharedTreeAuthorityCapture): SharedTreeAuthorityDraft;
	publishAdvance(
		publication: SharedTreeAuthorityPublication,
	): Promise<"applied" | "duplicate" | "stale">;
	onStateChanged(listener: () => void): () => void;
}

interface CaptureData {
	readonly approved: GraphCommit<SharedTreeChange>;
	readonly commits: readonly GraphCommit<SharedTreeChange>[];
	readonly approvedCheckout: TreeCheckout;
	readonly sequencedCheckout: TreeCheckout;
	disposed: boolean;
}

interface DraftData {
	readonly capture: SharedTreeAuthorityCapture;
	readonly checkout: TreeCheckout;
	disposed: boolean;
	sealed: boolean;
}

class Controller implements SharedTreeAuthorityController {
	private readonly captures = new WeakMap<SharedTreeAuthorityCapture, CaptureData>();
	private readonly drafts = new WeakMap<SharedTreeAuthorityDraft, DraftData>();

	public constructor(private readonly kernel: SharedTreeKernel) {}

	private materialize(head: GraphCommit<SharedTreeChange>): TreeCheckout {
		const checkout = this.kernel.checkout.fork();
		const oldBranch = checkout.mainBranch;
		// This checkout has not been exposed to observers. switchBranch applies a real
		// history diff to its cloned forest, schema and detached-root index.
		checkout.switchBranch(oldBranch.fork(head));
		oldBranch.dispose();
		return checkout;
	}

	public capture(): SharedTreeAuthorityCapture {
		const state = this.kernel.getExternalAuthorityState();
		const data: CaptureData = {
			approved: state.approved,
			commits: state.provisional,
			approvedCheckout: this.materialize(state.approved),
			sequencedCheckout: this.materialize(state.sequenced),
			disposed: false,
		};
		const check = (): void => {
			if (data.disposed) {
				throw new UsageError("Authority capture has been disposed");
			}
		};
		const capture: SharedTreeAuthorityCapture = Object.freeze({
			checkpoint: state.checkpoint,
			editIds: Object.freeze(
				state.provisional.map((commit) => {
					assert(commit.revision !== "root", "A provisional commit must have an identity");
					return this.kernel.getStableRevision(commit.revision);
				}),
			),
			exportApproved: () => {
				check();
				return data.approvedCheckout.exportVerbose();
			},
			exportSequenced: () => {
				check();
				return data.sequencedCheckout.exportVerbose();
			},
			dispose: () => {
				if (!data.disposed) {
					data.disposed = true;
					data.approvedCheckout[disposeSymbol]();
					data.sequencedCheckout[disposeSymbol]();
				}
			},
		});
		this.captures.set(capture, data);
		return capture;
	}

	private getCapture(capture: SharedTreeAuthorityCapture): CaptureData {
		const data = this.captures.get(capture);
		if (data === undefined || data.disposed) {
			throw new UsageError("Expected a live capture from this controller");
		}
		return data;
	}

	public createDraft(capture: SharedTreeAuthorityCapture): SharedTreeAuthorityDraft {
		const captured = this.getCapture(capture);
		const data: DraftData = {
			capture,
			checkout: captured.approvedCheckout.fork(),
			disposed: false,
			sealed: false,
		};
		const draft: SharedTreeAuthorityDraft = {
			viewWith: <TRoot extends ImplicitFieldSchema>(
				config: TreeViewConfiguration<TRoot>,
			): TreeView<TRoot> => {
				if (data.disposed || data.sealed) {
					throw new UsageError("Authority draft has been disposed or published");
				}
				return data.checkout.viewWith(config) as TreeView<TRoot>;
			},
			dispose: () => {
				if (!data.disposed) {
					data.disposed = true;
					data.checkout[disposeSymbol]();
				}
			},
		};
		this.drafts.set(draft, data);
		return draft;
	}

	public async publishAdvance(
		publication: SharedTreeAuthorityPublication,
	): Promise<ExternalAuthorityOutcome> {
		const captured = this.getCapture(publication.capture);
		const count = publication.approvePrefix ?? 0;
		if (!Number.isInteger(count) || count < 0 || count > captured.commits.length) {
			throw new UsageError("Approval must be a prefix of the captured sequenced edits");
		}
		if (count > 0 && publication.draft !== undefined) {
			throw new UsageError("Transformed settlement is not supported");
		}
		if (
			publication.batchId.length === 0 ||
			publication.nextCheckpoint.length === 0 ||
			publication.nextCheckpoint === publication.capture.checkpoint
		) {
			throw new UsageError("An authority advance requires distinct nonempty identifiers");
		}
		let commits: GraphCommit<SharedTreeChange>[] = [];
		if (publication.draft !== undefined) {
			const draft = this.drafts.get(publication.draft);
			if (
				draft === undefined ||
				draft.disposed ||
				draft.sealed ||
				draft.capture !== publication.capture
			) {
				throw new UsageError("Expected an unpublished draft from this capture");
			}
			if (draft.checkout.transaction.size > 0) {
				throw new UsageError("Finish the draft transaction before publishing");
			}
			const ancestor = findCommonAncestor(captured.approved, [
				draft.checkout.mainBranch.getHead(),
				commits,
			]);
			assert(ancestor === captured.approved, "Authority draft changed its authoring base");
			if (commits.some((commit) => hasSchemaChange(commit.change))) {
				throw new UsageError("Authority drafts cannot change schema");
			}
			const enriched = draft.checkout.enrich(captured.approved, commits);
			commits = commits.map((commit, index) => ({
				...commit,
				change: enriched[index] ?? commit.change,
			}));
			draft.sealed = true;
		}
		return this.kernel.publishExternalAuthority({
			batchId: publication.batchId,
			expected: publication.capture.checkpoint,
			next: publication.nextCheckpoint,
			approvedPrefix: captured.commits.slice(0, count).map((commit) => commit.revision),
			commits,
		});
	}

	public onStateChanged(listener: () => void): () => void {
		return this.kernel.onExternalAuthorityChanged(listener);
	}
}

const controllers = new WeakMap<ITree, SharedTreeAuthorityController>();

/**
 * Gets the restricted experimental controller of an explicitly opted-in tree.
 * This is not an authorization boundary: every Fluid writer is trusted.
 * @alpha
 */
export function getSharedTreeAuthority(tree: ITree): SharedTreeAuthorityController {
	let controller = controllers.get(tree);
	if (controller === undefined) {
		const kernel = (tree as ITreePrivate).kernel;
		if (kernel?.externalAuthorityEnabled !== true) {
			throw new UsageError("External authority mode is not enabled");
		}
		controller = new Controller(kernel);
		controllers.set(tree, controller);
	}
	return controller;
}
