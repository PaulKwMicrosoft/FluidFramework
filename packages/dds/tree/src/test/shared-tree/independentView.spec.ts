/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	createIdCompressor,
	createSessionId,
	isFinalId,
	deserializeIdCompressor,
	SerializationVersion,
	serializeIdCompressor,
	toIdCompressorWithCore,
} from "@fluidframework/id-compressor/internal";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import { FluidClientVersion } from "../../codec/index.js";
import { CommitKind, type RevertibleAlpha, RevertibleStatus } from "../../core/index.js";
import {
	independentInitializedView,
	createIndependentTreeAlpha,
	createIndependentTreeBeta,
	createIndependentTreeCheckout,
	createIndependentTreeView,
	createIndependentTreeViewAlpha,
	independentView,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../shared-tree/independentView.js";
import {
	ForestTypeExpensiveDebug,
	TreeAlpha,
	type TreeCheckout,
} from "../../shared-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { SchematizingSimpleTreeView } from "../../shared-tree/schematizingTreeView.js";
import {
	extractPersistedSchema,
	FieldKind,
	SchemaFactory,
	SchemaFactoryAlpha,
	type TreeViewBeta,
	TreeViewConfiguration,
	TreeViewConfigurationAlpha,
} from "../../simple-tree/index.js";
import { ajvValidator } from "../codec/index.js";
import { createTestUndoRedoStacks, testIdCompressor } from "../utils.js";

describe("independentView", () => {
	it("createIndependentTreeViewAlpha", () => {
		const config = new TreeViewConfiguration({ schema: SchemaFactory.number });
		// Keep this deprecated call to verify compatibility with the previous API name.
		const view = independentView(config);
		view.initialize(42);
		assert.equal(view.root, 42);
		view.dispose();

		const renamedView = createIndependentTreeViewAlpha(config);
		assert(renamedView.compatibility.canInitialize);
		renamedView.dispose();
	});

	describe("independentInitializedView", () => {
		// Regression test for debug forest erroring during initialization due to being out of schema.
		it("debug forest", () => {
			const config = new TreeViewConfigurationAlpha({ schema: SchemaFactory.number });
			const view = independentInitializedView(
				config,
				{
					forest: ForestTypeExpensiveDebug,
					jsonValidator: ajvValidator,
				},
				{
					schema: extractPersistedSchema(config.schema, FluidClientVersion.v2_0, () => true),
					tree: TreeAlpha.exportCompressed(1, {
						minVersionForCollab: FluidClientVersion.v2_0,
					}),
					idCompressor: testIdCompressor,
				},
			);
			assert.equal(view.root, 1);
		});
	});

	describe("createIndependentTreeAlpha", () => {
		it("uninitialized: minimal", () => {
			const tree = createIndependentTreeAlpha({
				forest: ForestTypeExpensiveDebug,
				idCompressor: testIdCompressor,
			});
			const config = new TreeViewConfigurationAlpha({ schema: SchemaFactory.number });
			const view = tree.viewWith(config);
			assert(view.compatibility.canInitialize);
			view.initialize(1);
			assert.equal(view.root, 1);

			assert.equal(tree.exportVerbose(), 1);
			const filledSchema = tree.exportSimpleSchema();
			assert.equal(filledSchema.root.kind, FieldKind.Required);
			assert.deepEqual(
				filledSchema.root.simpleAllowedTypes,
				new Map([[SchemaFactory.number.identifier, { isStaged: undefined }]]),
			);

			view.dispose();
		});

		it("uninitialized: staged schema upgrade", () => {
			const tree = createIndependentTreeAlpha({
				forest: ForestTypeExpensiveDebug,
				idCompressor: testIdCompressor,
			});

			const beforeConfig = new TreeViewConfigurationAlpha({ schema: SchemaFactory.number });
			const stagedConfig = new TreeViewConfigurationAlpha({
				schema: SchemaFactoryAlpha.types([
					SchemaFactory.number,
					SchemaFactoryAlpha.staged(SchemaFactory.string),
				]),
			});
			const afterConfig = new TreeViewConfigurationAlpha({
				schema: [SchemaFactory.number, SchemaFactory.string],
			});

			// Initialize tree
			{
				const view = tree.viewWith(beforeConfig);
				assert(view.compatibility.canInitialize);
				view.initialize(1);
				assert.equal(tree.exportVerbose(), 1);
				const filledSchema = tree.exportSimpleSchema();
				assert.equal(filledSchema.root.kind, FieldKind.Required);
				assert.deepEqual(
					filledSchema.root.simpleAllowedTypes,
					new Map([[SchemaFactory.number.identifier, { isStaged: undefined }]]),
				);

				view.dispose();
			}

			// Open with schema that has change staged
			{
				const view = tree.viewWith(stagedConfig);
				assert.equal(view.root, 1);
				assert.throws(() => {
					view.root = "x";
				}, /does not conform to schema/);
				view.dispose();

				const filledSchema = tree.exportSimpleSchema();
				assert.deepEqual(
					filledSchema.root.simpleAllowedTypes,
					// This is stored schema, so it does not include the staged type.
					new Map([[SchemaFactory.number.identifier, { isStaged: undefined }]]),
				);
			}

			// Do schema upgrade
			{
				const view = tree.viewWith(afterConfig);
				assert.equal(view.compatibility.canView, false);
				assert(view.compatibility.canUpgrade);
				view.upgradeSchema();
				view.root = "y";

				assert.equal(tree.exportVerbose(), "y");
				const filledSchema = tree.exportSimpleSchema();
				assert.deepEqual(
					filledSchema.root.simpleAllowedTypes,
					new Map([
						[SchemaFactory.number.identifier, { isStaged: undefined }],
						[SchemaFactory.string.identifier, { isStaged: undefined }],
					]),
				);

				view.dispose();
			}

			// Confirm tree is still readable with version that had staged schema.
			{
				const view = tree.viewWith(stagedConfig);
				assert.equal(view.root, "y");
				view.dispose();
			}

			// Tree cannot be read with original version.
			{
				const view = tree.viewWith(beforeConfig);
				assert.equal(view.compatibility.canView, false);
				assert.equal(view.compatibility.canUpgrade, false);
				view.dispose();
			}
		});

		it("initialized", () => {
			const minVersionForCollab = FluidClientVersion.v2_0;
			const config = new TreeViewConfigurationAlpha({ schema: SchemaFactory.number });
			const tree = createIndependentTreeAlpha({
				forest: ForestTypeExpensiveDebug,
				jsonValidator: ajvValidator,
				content: {
					schema: extractPersistedSchema(config.schema, minVersionForCollab, () => true),
					tree: TreeAlpha.exportCompressed(1, {
						minVersionForCollab,
					}),
					idCompressor: testIdCompressor,
				},
			});

			const view = tree.viewWith(config);
			assert.equal(view.root, 1);
		});

		for (const finalize of [true, false]) {
			it(`initialized with compressed identifiers from another compressor ${finalize ? "with finalize" : "without finalize"}`, () => {
				const minVersionForCollab = FluidClientVersion.v2_0;
				const schemaFactory = new SchemaFactory("test");
				class HasIdentifier extends schemaFactory.object("HasIdentifier", {
					id: schemaFactory.identifier,
				}) {}

				const sourceCompressor = createIdCompressor(
					createSessionId(),
					SerializationVersion.V3,
				);
				const localId = sourceCompressor.generateCompressedId();
				const identifier = sourceCompressor.decompress(localId);
				const sourceTree = TreeAlpha.create(HasIdentifier, { id: identifier });

				if (finalize) {
					const sourceCore = toIdCompressorWithCore(sourceCompressor);
					const range = sourceCore.takeNextCreationRange();
					if (range.ids !== undefined) {
						sourceCore.finalizeCreationRange(range);
					}
				}

				// Session space id should be stable over time, and not change after they become final.
				assert.equal(sourceCompressor.tryRecompress(identifier), localId);

				const opSpace = sourceCompressor.normalizeToOpSpace(localId);
				assert.equal(isFinalId(opSpace), finalize);

				const compressed = TreeAlpha.exportCompressed(sourceTree, {
					minVersionForCollab,
					idCompressor: sourceCompressor,
				});

				const found = JSON.stringify(compressed).includes(identifier);
				assert.equal(found, !finalize);

				// Rehydrate a separate compressor from summary-style state (no local session data)
				// so this mirrors cross-client/import behavior. A different session id ensures
				// the target compressor is not acting as the source session.
				const targetCompressor = deserializeIdCompressor(
					serializeIdCompressor(sourceCompressor, false),
					createSessionId(),
					SerializationVersion.V3,
				);
				assert(targetCompressor.localSessionId !== sourceCompressor.localSessionId);

				const decoded = targetCompressor.tryNormalizeToSessionSpaceWithoutSession(opSpace);
				assert.equal(
					decoded,
					finalize ? (targetCompressor.tryRecompress(identifier) ?? assert.fail()) : undefined,
				);

				const config = new TreeViewConfigurationAlpha({ schema: HasIdentifier });
				const tree = createIndependentTreeAlpha({
					forest: ForestTypeExpensiveDebug,
					jsonValidator: ajvValidator,
					content: {
						schema: extractPersistedSchema(config.schema, minVersionForCollab, () => true),
						tree: compressed,
						idCompressor: targetCompressor,
					},
				});

				const view = tree.viewWith(config);
				assert.equal(view.root.id, identifier);
			});
		}

		it("oddly allowed jsonValidator", () => {
			const config = new TreeViewConfigurationAlpha({ schema: SchemaFactory.number });
			const tree = createIndependentTreeAlpha({
				forest: ForestTypeExpensiveDebug,
				// This does nothing, and is not part of the allowed input type.
				// Usually this would fail with "Object literal may only specify known properties"
				// but in this case there is no error.
				// This is fine as it works, and the jsonValidator is simply unnecessary and unused when not providing content, but seems odd.
				jsonValidator: ajvValidator,
			});

			const view = tree.viewWith(config);
			assert.equal(view.compatibility.canInitialize, true);
		});
	});

	it("createIndependentTreeBeta", () => {
		const tree = createIndependentTreeBeta();
		const view = tree.viewWith(
			new TreeViewConfigurationAlpha({ schema: SchemaFactory.number }),
		);
		view.initialize(42);
		assert.equal(view.root, 42);
		view.dispose();
	});

	it("createIndependentTreeView", () => {
		const view: TreeViewBeta<typeof SchemaFactory.number> = createIndependentTreeView(
			new TreeViewConfiguration({ schema: SchemaFactory.number }),
		);
		assert(view.compatibility.canInitialize);
		view.initialize(42);
		assert.equal(view.root, 42);
		view.dispose();
	});

	it("staged schema example", () => {
		const tree = createIndependentTreeBeta();

		const stagedConfig = new TreeViewConfiguration({
			schema: SchemaFactoryAlpha.types([
				SchemaFactory.number,
				SchemaFactoryAlpha.staged(SchemaFactory.string),
			]),
		});
		const afterConfig = new TreeViewConfigurationAlpha({
			schema: [SchemaFactory.number, SchemaFactory.string],
		});

		// Initialize tree
		{
			const view = tree.viewWith(stagedConfig);
			view.initialize(1);
			view.dispose();
		}

		// Do schema upgrade
		{
			const view = tree.viewWith(afterConfig);
			view.upgradeSchema();
			view.root = "A";
			view.dispose();
		}

		// Can still view tree with staged schema
		{
			const view = tree.viewWith(stagedConfig);
			assert.equal(view.root, "A");
			view.dispose();
		}
	});

	describe("maxRevertibles", () => {
		const sf = new SchemaFactory("maxRevertibles");
		class Strings extends sf.array("Strings", sf.string) {}
		const config = new TreeViewConfiguration({ schema: Strings });

		function createView(
			maxRevertibles: number | undefined,
			initialContent: readonly string[] = [],
		): {
			checkout: TreeCheckout;
			view: SchematizingSimpleTreeView<typeof Strings>;
		} {
			const checkout = createIndependentTreeCheckout({ maxRevertibles });
			const view = checkout.viewWith(config);
			view.initialize(new Strings(initialContent));
			return { checkout, view };
		}

		/**
		 * Collects a revertible for each commit except those made by transactions labeled `"load"`.
		 */
		function collectRevertibles(view: SchematizingSimpleTreeView<typeof Strings>): {
			revertibles: RevertibleAlpha[];
			disposed: RevertibleAlpha[];
		} {
			const revertibles: RevertibleAlpha[] = [];
			const disposed: RevertibleAlpha[] = [];
			view.events.on("changed", (data, getRevertible) => {
				if (getRevertible !== undefined && !data.labels.has("load")) {
					revertibles.push(getRevertible((revertible) => disposed.push(revertible)));
				}
			});
			return { revertibles, disposed };
		}

		function load(view: SchematizingSimpleTreeView<typeof Strings>, value: string): void {
			view.runTransaction(() => view.root.insertAtEnd(value), { label: "load" });
		}

		for (const invalid of [0, -1, 1.5, Number.NaN]) {
			it(`rejects ${invalid}`, () => {
				assert.throws(
					() => createIndependentTreeAlpha({ maxRevertibles: invalid }),
					validateUsageError(/"maxRevertibles" must be a positive integer/),
				);
			});
		}

		it("disposes the oldest revertible beyond the limit", () => {
			const { view } = createView(2);
			const { revertibles, disposed } = collectRevertibles(view);
			view.root.insertAtEnd("A");
			view.root.insertAtEnd("B");
			assert.deepEqual(disposed, []);
			view.root.insertAtEnd("C");
			assert.deepEqual(disposed, [revertibles[0]]);
			assert.equal(revertibles[0].status, RevertibleStatus.Disposed);
			assert.equal(revertibles[1].status, RevertibleStatus.Valid);
			assert.equal(revertibles[2].status, RevertibleStatus.Valid);
			assert.throws(
				() => revertibles[0].revert(),
				validateUsageError(/disposed because more than 2 revertibles were valid/),
			);
			revertibles[2].revert();
			revertibles[1].revert();
			assert.deepEqual([...view.root], ["A"]);
		});

		it("does not count a revertible being reverted toward the limit", () => {
			const { view } = createView(2);
			const { undoStack, redoStack } = createTestUndoRedoStacks(view.events);
			view.root.insertAtEnd("A");
			view.root.insertAtEnd("B");
			undoStack.pop()?.revert();
			undoStack.pop()?.revert();
			assert.deepEqual([...view.root], []);
			assert.equal(undoStack.length, 0);
			assert.equal(redoStack.length, 2);
			redoStack.pop()?.revert();
			redoStack.pop()?.revert();
			assert.deepEqual([...view.root], ["A", "B"]);
			assert.equal(undoStack.length, 2);
			assert.equal(redoStack.length, 0);
			undoStack.pop()?.revert();
			assert.deepEqual([...view.root], ["A"]);
		});

		it("does not limit revertibles or trim history by default", () => {
			const { checkout, view } = createView(undefined, ["a", "b", "c", "d"]);
			const { revertibles } = collectRevertibles(view);
			const commitsBefore = checkout.mainBranch.getCommitCount();
			for (let i = 0; i < 4; i++) {
				view.root.removeAt(0);
			}
			assert.equal(checkout.mainBranch.getCommitCount(), commitsBefore + 4);
			assert.equal(checkout.getRemovedRoots().length, 4);
			assert(revertibles.every((r) => r.status === RevertibleStatus.Valid));
		});

		it("retains only the latest commit when there are no revertibles", () => {
			const { checkout, view } = createView(3, ["a", "b", "c", "d"]);
			assert.equal(checkout.mainBranch.getCommitCount(), 1);
			for (let i = 0; i < 4; i++) {
				view.root.removeAt(0);
				assert.equal(checkout.mainBranch.getCommitCount(), 1);
				// Only the content removed by the latest commit is retained.
				assert.equal(checkout.getRemovedRoots().length, 1);
			}
			assert.deepEqual([...view.root], []);
		});

		it("retains the commits needed by valid revertibles", () => {
			const { checkout, view } = createView(2, ["a", "b", "c", "d", "e"]);
			const history = checkout.branchHistory;
			const { revertibles } = collectRevertibles(view);
			for (let i = 0; i < 4; i++) {
				view.root.removeAt(0);
				const expectedCommits = Math.min(i + 1, 2);
				assert.equal(checkout.mainBranch.getCommitCount(), expectedCommits);
				assert.equal(history.length, expectedCommits);
				assert.equal(checkout.getRemovedRoots().length, expectedCommits);
			}
			assert.equal(revertibles.length, 4);
			revertibles[3].revert();
			assert.deepEqual([...view.root], ["d", "e"]);
			revertibles[2].revert();
			assert.deepEqual([...view.root], ["c", "d", "e"]);
		});

		it("discards history once revertibles are disposed", () => {
			const { checkout, view } = createView(5);
			const { revertibles } = collectRevertibles(view);
			view.root.insertAtEnd("A");
			view.root.insertAtEnd("B");
			assert.equal(checkout.mainBranch.getCommitCount(), 2);
			for (const revertible of revertibles) {
				revertible.dispose();
			}
			// History is trimmed when the next commit is applied.
			assert.equal(checkout.mainBranch.getCommitCount(), 2);
			view.runTransaction(() => {
				view.root.insertAtEnd("C");
				view.root.insertAtEnd("D");
				assert.equal(checkout.mainBranch.getCommitCount(), 2);
			});
			assert.equal(revertibles.length, 3);
			assert.equal(checkout.mainBranch.getCommitCount(), 1);
			revertibles[2].revert();
			assert.deepEqual([...view.root], ["A", "B"]);
		});

		it("does not trim history while the view has forks", () => {
			const { checkout, view } = createView(1);
			view.root.insertAtEnd("A");
			assert.equal(checkout.mainBranch.getCommitCount(), 1);
			const fork = view.fork();
			view.root.insertAtEnd("B");
			view.root.insertAtEnd("C");
			assert.equal(checkout.mainBranch.getCommitCount(), 3);
			fork.root.insertAtEnd("F");
			view.merge(fork);
			assert.deepEqual([...view.root], ["A", "F", "B", "C"]);
			view.root.insertAtEnd("D");
			assert.equal(checkout.mainBranch.getCommitCount(), 1);
			assert.deepEqual([...view.root], ["A", "F", "B", "C", "D"]);
		});

		it("undo and redo produce the same trees as without trimming", () => {
			function run(maxRevertibles: number | undefined): string[][] {
				const { view } = createView(maxRevertibles);
				const undoStack: RevertibleAlpha[] = [];
				const redoStack: RevertibleAlpha[] = [];
				view.events.on("changed", (data, getRevertible) => {
					if (getRevertible !== undefined && !data.labels.has("load")) {
						const stack = data.kind === CommitKind.Undo ? redoStack : undoStack;
						stack.push(getRevertible());
					}
				});
				const snapshots: string[][] = [];
				const snapshot = (): void => {
					snapshots.push([...view.root]);
				};
				view.root.insertAtEnd("e1");
				load(view, "l1");
				view.root.insertAtEnd("e2");
				load(view, "l2");
				view.root.removeAt(0);
				load(view, "l3");
				view.root.insertAtEnd("e3");
				snapshot();
				for (let i = 0; i < 3; i++) {
					undoStack.pop()?.revert();
					snapshot();
				}
				redoStack.pop()?.revert();
				snapshot();
				load(view, "l4");
				redoStack.pop()?.revert();
				snapshot();
				undoStack.pop()?.revert();
				snapshot();
				return snapshots;
			}

			const expected = run(undefined);
			assert.deepEqual(expected.at(-1), ["e1", "l1", "e2", "l2", "l3", "l4"]);
			assert.deepEqual(run(3), expected);
			assert.deepEqual(run(Number.POSITIVE_INFINITY), expected);
		});
	});
});
