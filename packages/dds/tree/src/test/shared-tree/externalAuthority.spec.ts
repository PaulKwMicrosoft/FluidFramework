/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import { FlushMode } from "@fluidframework/runtime-definitions/internal";
import {
	MockFluidDataStoreRuntime,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";
import {
	createIdCompressor,
	deserializeIdCompressor,
	createSessionId,
	toIdCompressorWithCore,
} from "@fluidframework/id-compressor/internal";
import { SchemaFactory, TreeViewConfiguration } from "../../simple-tree/index.js";
import { configuredSharedTree } from "../../treeFactory.js";
import { getSharedTreeAuthority } from "../../shared-tree/index.js";
import { TestTreeProviderLite, createTestUndoRedoStacks } from "../utils.js";

const sf = new SchemaFactory("external-authority-test");
class Item extends sf.object("Item", { name: sf.string, value: sf.number }) {}
class Items extends sf.array("Items", Item) {}
class Root extends sf.object("Root", {
	value: sf.number,
	other: sf.number,
	items: Items,
	link: sf.optional(sf.handle),
}) {}
const configuration = new TreeViewConfiguration({ schema: Root });

async function setup(count = 2) {
	const factory = configuredSharedTree({
		minVersionForCollab: "2.80.0",
		externalAuthority: {
			documentEpoch: "document-1",
			authorityId: "trusted-bridge",
			authorityEpoch: "epoch-1",
		},
	});
	const provider = new TestTreeProviderLite(
		count,
		factory.getFactory(),
		true,
		FlushMode.TurnBased,
	);
	const trees = provider.trees;
	const views = trees.map((tree) => tree.viewWith(configuration));
	views[0]?.initialize({
		value: 0,
		other: 0,
		items: [
			{ name: "a", value: 0 },
			{ name: "b", value: 0 },
		],
	});
	provider.synchronizeMessages();
	const controllers = trees.map(getSharedTreeAuthority);
	const controller = controllers[0];
	assert(controller !== undefined);
	const capture = controller.capture();
	const receipt = controller.publishAdvance({
		batchId: "bootstrap",
		nextCheckpoint: "ready",
		capture,
		approvePrefix: capture.editIds.length,
	});
	provider.synchronizeMessages();
	assert.equal(await receipt, "applied");
	capture.dispose();
	return { provider, trees, views, controllers };
}

describe("external authority", () => {
	it("treats pre-attach initialization as approved and can create its attach summary", () => {
		const factory = configuredSharedTree({
			minVersionForCollab: "2.80.0",
			externalAuthority: {
				documentEpoch: "document",
				authorityId: "bridge",
				authorityEpoch: "epoch",
			},
		});
		const runtime = new MockFluidDataStoreRuntime({ idCompressor: createIdCompressor() });
		const tree = factory.getFactory().create(runtime, "bootstrap");
		tree.viewWith(configuration).initialize({ value: 4, other: 5, items: [] });
		const capture = getSharedTreeAuthority(tree).capture();
		assert.equal(capture.editIds.length, 0);
		assert.deepEqual(capture.exportApproved(), capture.exportSequenced());
		tree.getAttachSummary();
		capture.dispose();
	});

	it("reloads the bootstrap with matching labels and rejects mismatches or ordinary reinterpretation", async () => {
		const labels = {
			documentEpoch: "document",
			authorityId: "bridge",
			authorityEpoch: "epoch",
		};
		const factory = configuredSharedTree({
			minVersionForCollab: "2.80.0",
			externalAuthority: labels,
		}).getFactory();
		const compressor = toIdCompressorWithCore(createIdCompressor());
		const runtime = new MockFluidDataStoreRuntime({ idCompressor: compressor });
		const tree = factory.create(runtime, "seed");
		tree.viewWith(configuration).initialize({ value: 4, other: 5, items: [] });
		compressor.finalizeCreationRange(compressor.takeNextCreationRange());
		const summary = tree.getAttachSummary().summary;
		const savedCompressor = compressor.serialize(false);

		const load = async (loadFactory = factory, savedSummary = summary) => {
			const loadingRuntime = new MockFluidDataStoreRuntime({
				idCompressor: deserializeIdCompressor(savedCompressor, createSessionId()),
			});
			return loadFactory.load(
				loadingRuntime,
				"loaded",
				{
					deltaConnection: loadingRuntime.createDeltaConnection(),
					objectStorage: MockStorage.createFromSummary(savedSummary),
				},
				loadFactory.attributes,
			);
		};

		const loaded = await load();
		const view = loaded.viewWith(configuration);
		assert.deepEqual([view.root.value, view.root.other], [4, 5]);
		const capture = getSharedTreeAuthority(loaded).capture();
		assert.equal(capture.checkpoint, "initial");
		assert.equal(capture.editIds.length, 0);
		assert.deepEqual(capture.exportApproved(), capture.exportSequenced());
		capture.dispose();

		for (const key of ["documentEpoch", "authorityId", "authorityEpoch"] as const) {
			const wrongFactory = configuredSharedTree({
				minVersionForCollab: "2.80.0",
				externalAuthority: { ...labels, [key]: "wrong" },
			}).getFactory();
			await assert.rejects(load(wrongFactory), /Wrong authority/);
		}
		const ordinaryFactory = configuredSharedTree({
			minVersionForCollab: "2.80.0",
		}).getFactory();
		await assert.rejects(
			load(ordinaryFactory),
			/cannot be loaded by an ordinary SharedTree factory/,
		);
		const missingMetadata = structuredClone(summary);
		delete missingMetadata.tree[".externalAuthority"];
		await assert.rejects(load(factory, missingMetadata), /bootstrap metadata is missing/);
	});

	it("leaves ordinary mode unchanged", () => {
		const provider = new TestTreeProviderLite(2);
		const views = provider.trees.map((tree) => tree.viewWith(configuration));
		views[0]?.initialize({ value: 0, other: 0, items: [] });
		provider.synchronizeMessages();
		views[0].root.value = 3;
		views[1].root.other = 4;
		provider.synchronizeMessages();
		assert.deepEqual(
			views.map((view) => [view.root.value, view.root.other]),
			[
				[3, 4],
				[3, 4],
			],
		);
	});

	it("approves a sequenced prefix without double-applying it", async () => {
		const { provider, views, controllers } = await setup();
		const view = views[0];
		const controller = controllers[0];
		assert(view !== undefined && controller !== undefined);
		view.root.value = 4;
		provider.synchronizeMessages();
		const capture = controller.capture();
		assert.equal(capture.editIds.length, 1);
		const snapshot = capture.exportSequenced();
		const receipt = controller.publishAdvance({
			batchId: "approval",
			nextCheckpoint: "approved-1",
			capture,
			approvePrefix: 1,
		});
		assert.equal(controller.capture().checkpoint, "ready", "No private authority fast path");
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		assert.deepEqual(
			capture.exportSequenced(),
			snapshot,
			"Captured materialization is immutable",
		);
		assert.deepEqual(
			views.map((v) => v.root.value),
			[4, 4],
		);
		assert.equal(controller.capture().editIds.length, 0);
		view.root.value = 9;
		provider.synchronizeMessages();
		assert.deepEqual(
			capture.exportSequenced(),
			snapshot,
			"Capture must not follow subsequent ordinary edits",
		);
		assert.notDeepEqual(controller.capture().exportSequenced(), snapshot);
		capture.dispose();
	});

	it("inserts external history before P while preserving unsequenced L", async () => {
		const { provider, trees, views, controllers } = await setup();
		const [a, b] = views;
		const [ca] = controllers;
		assert(a !== undefined && b !== undefined && ca !== undefined);
		b.root.value = 1;
		provider.synchronizeMessages();
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		const external = draft.viewWith(configuration);
		assert.equal(external.root.value, 0, "Authority draft must start at A, not A+P");
		external.root.value = 2;
		const receipt = ca.publishAdvance({
			batchId: "external",
			nextCheckpoint: "external-1",
			capture,
			draft,
		});
		trees[0]?.containerRuntime.flush();
		b.root.other = 7;
		assert.equal(b.root.other, 7);
		const cutWithLocalWork = controllers[1].capture();
		const peerCut = ca.capture();
		assert.deepEqual(
			cutWithLocalWork.exportSequenced(),
			peerCut.exportSequenced(),
			"Capture excludes L",
		);
		cutWithLocalWork.dispose();
		peerCut.dispose();
		provider.synchronizeMessages({ flush: false });
		assert.equal(await receipt, "applied");
		assert.deepEqual(
			views.map((v) => v.root.value),
			[1, 1],
			"P rebased AFTER the external change wins",
		);
		assert.deepEqual(
			views.map((v) => v.root.other),
			[0, 7],
			"L remains local at authority delivery",
		);
		provider.synchronizeMessages();
		assert.deepEqual(
			views.map((v) => v.root.other),
			[7, 7],
		);
		assert.equal(ca.capture().editIds.length, 2);
		capture.dispose();
		draft.dispose();
	});

	it("preserves old authoring references and sender pending predecessors", async () => {
		const { provider, trees, views, controllers } = await setup(3);
		const [a, b, c] = views;
		const [ca] = controllers;
		assert(a !== undefined && b !== undefined && c !== undefined && ca !== undefined);
		b.root.value = 10;
		provider.synchronizeMessages();
		trees[2]?.containerRuntime.pauseInboundProcessing();
		c.root.items.removeAt(0);
		c.root.items[0].value = 9;
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.items.insertAtStart({ name: "external", value: 3 });
		const receipt = ca.publishAdvance({
			batchId: "insert",
			nextCheckpoint: "insert-1",
			capture,
			draft,
		});
		trees[0]?.containerRuntime.flush();
		provider.synchronizeMessages({ flush: false });
		assert.equal(await receipt, "applied");
		trees[2]?.containerRuntime.flush();
		provider.synchronizeMessages({ flush: false });
		trees[2]?.containerRuntime.resumeInboundProcessing();
		provider.synchronizeMessages();
		for (const view of views) {
			assert.deepEqual(
				[...view.root.items].map((item) => [item.name, item.value]),
				[
					["external", 3],
					["b", 9],
				],
			);
		}
		capture.dispose();
		draft.dispose();
	});

	it("deduplicates approval and rejects a concurrently stale checkpoint", async () => {
		const { provider, views, controllers } = await setup();
		const [ca, cb] = controllers;
		assert(ca !== undefined && cb !== undefined);
		views[0].root.value = 5;
		provider.synchronizeMessages();
		const capture = ca.capture();
		const staleCapture = cb.capture();
		const publication = {
			batchId: "approve",
			nextCheckpoint: "approved",
			capture,
			approvePrefix: 1,
		};
		const first = ca.publishAdvance(publication);
		const stale = cb.publishAdvance({
			batchId: "stale",
			nextCheckpoint: "stale-checkpoint",
			capture: staleCapture,
			approvePrefix: 1,
		});
		provider.synchronizeMessages();
		assert.equal(await first, "applied");
		assert.equal(await stale, "stale");
		const duplicate = ca.publishAdvance(publication);
		provider.synchronizeMessages();
		assert.equal(await duplicate, "duplicate");
		assert.deepEqual(
			views.map((view) => view.root.value),
			[5, 5],
		);
		assert.equal(ca.capture().checkpoint, "approved");
		assert.equal(cb.capture().editIds.length, 0);
		capture.dispose();
		staleCapture.dispose();
	});

	it("preserves node identity and undo across an authority rebase", async () => {
		const { provider, trees, views, controllers } = await setup();
		const b = views[1];
		const ca = controllers[0];
		const original = b.root.items[0];
		const { undoStack, unsubscribe } = createTestUndoRedoStacks(
			trees[1].kernel.checkout.events,
		);
		b.root.items.moveToEnd(0);
		provider.synchronizeMessages();
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.items[0].value = 8;
		const receipt = ca.publishAdvance({
			batchId: "edit-moved",
			nextCheckpoint: "move-1",
			capture,
			draft,
		});
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		assert.equal(
			b.root.items[1],
			original,
			"Hydrated node identity survives authority history rewrite",
		);
		assert.equal(original.value, 8);
		assert(undoStack.length > 0);
		const undo = undoStack.pop();
		assert(undo !== undefined);
		undo.revert();
		provider.synchronizeMessages();
		for (const view of views) {
			assert.deepEqual(
				[...view.root.items].map((item) => [item.name, item.value]),
				[
					["a", 8],
					["b", 0],
				],
			);
		}
		assert.equal(b.root.items[0], original);
		unsubscribe();
		capture.dispose();
		draft.dispose();
	});

	it("retains real removal identity for undo after external history changes", async () => {
		const { provider, trees, views, controllers } = await setup();
		const b = views[1];
		const original = b.root.items[0];
		const ca = controllers[0];
		const { undoStack, unsubscribe } = createTestUndoRedoStacks(
			trees[1].kernel.checkout.events,
		);
		b.root.items.removeAt(0);
		provider.synchronizeMessages();
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.items[0].value = 6;
		const receipt = ca.publishAdvance({
			batchId: "edit-removed",
			nextCheckpoint: "removed-1",
			capture,
			draft,
		});
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		const undo = undoStack.pop();
		assert(undo !== undefined);
		undo.revert();
		provider.synchronizeMessages();
		assert.equal(b.root.items[0], original);
		for (const view of views) {
			assert.deepEqual(
				[...view.root.items].map((item) => [item.name, item.value]),
				[
					["a", 6],
					["b", 0],
				],
			);
		}
		unsubscribe();
		capture.dispose();
		draft.dispose();
	});

	it("reconnects pending ordinary work authored before an authority advance", async () => {
		const { provider, trees, views, controllers } = await setup();
		const ca = controllers[0];
		trees[1].containerRuntime.connected = false;
		views[1].root.items.removeAt(0);
		views[1].root.items[0].value = 12;
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.items.insertAtStart({ name: "external", value: 3 });
		const receipt = ca.publishAdvance({
			batchId: "offline",
			nextCheckpoint: "offline-1",
			capture,
			draft,
		});
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		trees[1].containerRuntime.connected = true;
		provider.synchronizeMessages();
		for (const view of views) {
			assert.deepEqual(
				[...view.root.items].map((item) => [item.name, item.value]),
				[
					["external", 3],
					["b", 12],
				],
			);
		}
		capture.dispose();
		draft.dispose();
	});

	it("handles ordinary-authority-ordinary messages in one runtime batch", async () => {
		const { provider, views, controllers } = await setup();
		const ca = controllers[0];
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.value = 2;
		views[0].root.value = 1;
		const receipt = ca.publishAdvance({
			batchId: "mixed",
			nextCheckpoint: "mixed-1",
			capture,
			draft,
		});
		views[0].root.other = 9;
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		views[1].root.items[0].value = 5;
		provider.synchronizeMessages();
		assert.deepEqual(
			views.map((view) => [view.root.value, view.root.other, view.root.items[0].value]),
			[
				[1, 9, 5],
				[1, 9, 5],
			],
		);
		assert.deepEqual(
			controllers.map((controller) => controller.capture().editIds.length),
			[3, 3],
		);
		assert.deepEqual(
			controllers[0].capture().editIds,
			controllers[1].capture().editIds,
			"Stable IDs agree across independent compressors",
		);
		capture.dispose();
		draft.dispose();
	});

	it("rejects transformed settlement rather than approximating it", async () => {
		const { provider, views, controllers } = await setup();
		const ca = controllers[0];
		views[0].root.value = 1;
		provider.synchronizeMessages();
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.value = 2;
		await assert.rejects(
			async () =>
				ca.publishAdvance({
					batchId: "unsupported",
					nextCheckpoint: "unsupported-1",
					capture,
					draft,
					approvePrefix: 1,
				}),
			/Transformed settlement/,
		);
		assert.deepEqual(
			views.map((view) => view.root.value),
			[1, 1],
		);
		capture.dispose();
		draft.dispose();
	});

	it("delivers a multi-edit draft as one coherent checkout change", async () => {
		const { provider, trees, views, controllers } = await setup();
		const ca = controllers[0];
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		const external = draft.viewWith(configuration);
		external.root.value = 11;
		external.root.other = 12;
		const observed: number[][] = [];
		const off = trees[1].kernel.checkout.events.on("afterBatch", () => {
			observed.push([views[1].root.value, views[1].root.other]);
		});
		const receipt = ca.publishAdvance({
			batchId: "atomic",
			nextCheckpoint: "atomic-1",
			capture,
			draft,
		});
		assert.deepEqual(observed, []);
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		assert.deepEqual(
			observed,
			[[11, 12]],
			"Observers must not see an intermediate draft commit",
		);
		off();
		capture.dispose();
		draft.dispose();
	});

	it("resubmits an authority publication without a private optimistic apply", async () => {
		const { provider, trees, views, controllers } = await setup();
		const ca = controllers[0];
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.value = 15;
		trees[0].containerRuntime.connected = false;
		const receipt = ca.publishAdvance({
			batchId: "resubmit-authority",
			nextCheckpoint: "resubmit-1",
			capture,
			draft,
		});
		assert.deepEqual(
			views.map((view) => view.root.value),
			[0, 0],
		);
		trees[0].containerRuntime.connected = true;
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		assert.deepEqual(
			views.map((view) => view.root.value),
			[15, 15],
		);
		capture.dispose();
		draft.dispose();
	});

	it("refuses lossy runtime summaries even with no remaining provisional edits", async () => {
		const { trees, controllers } = await setup();
		assert.equal(controllers[0].capture().editIds.length, 0);
		await assert.rejects(
			trees[0].summarize(),
			/External authority runtime summaries are not implemented/,
		);
	});

	it("does not silently support same-node detach/reinsert or required vacancy on 2.111", async () => {
		const { views } = await setup();
		const root = views[0].root;
		const removed = root.items[0];
		root.items.removeAt(0);
		assert.throws(() => root.items.insertAtEnd(removed));
		assert.throws(() => {
			(root as unknown as { value: undefined }).value = undefined;
		});
		assert.equal(root.value, 0);
	});

	it("preserves Fluid handles in an externally authored draft", async () => {
		const { provider, trees, views, controllers } = await setup();
		const ca = controllers[0];
		const capture = ca.capture();
		const draft = ca.createDraft(capture);
		draft.viewWith(configuration).root.link = trees[0].handle;
		const receipt = ca.publishAdvance({
			batchId: "handle",
			nextCheckpoint: "handle-1",
			capture,
			draft,
		});
		provider.synchronizeMessages();
		assert.equal(await receipt, "applied");
		for (const view of views) {
			assert(view.root.link !== undefined);
			assert.equal(typeof view.root.link.get, "function");
		}
		capture.dispose();
		draft.dispose();
	});

	it("undoes and redoes a conflicting write after several authority advances", async () => {
		const { provider, trees, views, controllers } = await setup();
		const ca = controllers[0];
		const { undoStack, redoStack, unsubscribe } = createTestUndoRedoStacks(
			trees[1].kernel.checkout.events,
		);
		views[1].root.value = 1;
		provider.synchronizeMessages();
		for (let value = 2; value <= 5; value++) {
			const capture = ca.capture();
			const draft = ca.createDraft(capture);
			draft.viewWith(configuration).root.value = value;
			const receipt = ca.publishAdvance({
				batchId: `conflicting-undo-${value}`,
				nextCheckpoint: `undo-${value}`,
				capture,
				draft,
			});
			provider.synchronizeMessages();
			assert.equal(await receipt, "applied");
			assert.deepEqual(
				views.map((view) => view.root.value),
				[1, 1],
			);
			capture.dispose();
			draft.dispose();
		}
		const undo = undoStack.pop();
		assert(undo !== undefined);
		undo.revert();
		provider.synchronizeMessages();
		assert.deepEqual(
			views.map((view) => view.root.value),
			[5, 5],
		);
		const redo = redoStack.pop();
		assert(redo !== undefined);
		redo.revert();
		provider.synchronizeMessages();
		assert.deepEqual(
			views.map((view) => view.root.value),
			[1, 1],
		);
		unsubscribe();
	});
});
