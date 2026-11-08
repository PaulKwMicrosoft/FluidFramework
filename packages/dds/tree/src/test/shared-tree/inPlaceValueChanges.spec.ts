/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import type { IChannelFactory } from "@fluidframework/datastore-definitions/internal";
import {
	createIdCompressor,
	SerializationVersion,
} from "@fluidframework/id-compressor/internal";
import { convertSummaryTreeToITree } from "@fluidframework/runtime-utils/internal";
import {
	MockContainerRuntimeFactory,
	MockDeltaConnection,
	MockFluidDataStoreRuntime,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";

import { FormatValidatorBasic } from "../../external-utilities/index.js";
import { ObjectNodeStoredSchema } from "../../core/index.js";
import { isInPlaceValueField, type NodeValueChange } from "../../feature-libraries/index.js";
import {
	createIndependentTreeAlpha,
	type ForestType,
	ForestTypeOptimized,
	ForestTypeReference,
	minimize,
	type SharedTreeOptions,
	type SharedTreeChange,
	SchematizingSimpleTreeView,
	Tree,
	TreeAlpha,
} from "../../shared-tree/index.js";
import {
	type ImplicitFieldSchema,
	type ITree,
	SchemaFactoryAlpha,
	type TreeNode,
	type TreeViewAlpha,
	TreeViewConfiguration,
	createTreeIndex,
	type DirtyTreeStatus,
	trackDirtyNodes,
	type TreeIndexKey,
} from "../../simple-tree/index.js";
import { asAlpha } from "../../api.js";
import { brand } from "../../util/index.js";
import { configuredSharedTree } from "../../treeFactory.js";
import { createTestUndoRedoStacks, TestTreeProviderLite } from "../utils.js";

const sf = new SchemaFactoryAlpha("inPlaceValueChanges");
class Point extends sf.object("Point", {
	x: sf.number,
	label: sf.string,
	visible: sf.boolean,
	maybe: sf.optional(sf.number),
	either: [sf.number, sf.string],
}) {}
class Points extends sf.array("Points", Point) {}
const config = new TreeViewConfiguration({ schema: Points, enableSchemaValidation: true });

function initialPoints(count = 2): Point[] {
	return Array.from(
		{ length: count },
		(_, i) => new Point({ x: i, label: `p${i}`, visible: i % 2 === 0, either: i }),
	);
}

function independentView(
	enableInPlaceValueChanges: boolean,
	options: { forest?: ForestType; maxRevertibles?: number } = {},
	count = 2,
): SchematizingSimpleTreeView<typeof Points> {
	const view = createIndependentTreeAlpha({ enableInPlaceValueChanges, ...options }).viewWith(
		config,
	);
	assert(view instanceof SchematizingSimpleTreeView);
	view.initialize(initialPoints(count));
	return view;
}

/**
 * The data change of the head commit of the view's branch.
 */
function headDataChange(
	view: Pick<SchematizingSimpleTreeView<ImplicitFieldSchema>, "checkout">,
) {
	const change: SharedTreeChange = view.checkout.mainBranch.getHead().change;
	assert.equal(change.changes.length, 1);
	const inner = change.changes[0];
	assert(inner?.type === "data");
	return inner.innerChange;
}

/**
 * The value changes, and the number of builds, of the head commit of the view's branch.
 */
function headEdits(view: Pick<SchematizingSimpleTreeView<ImplicitFieldSchema>, "checkout">): {
	valueChanges: NodeValueChange[];
	builds: number;
} {
	const change = headDataChange(view);
	const valueChanges: NodeValueChange[] = [];
	for (const [, node] of change.nodeChanges.entries()) {
		if (node.valueChange !== undefined) {
			valueChanges.push(node.valueChange);
		}
	}
	return { valueChanges, builds: change.builds?.size ?? 0 };
}

const inPlaceOptions: SharedTreeOptions = {
	jsonValidator: FormatValidatorBasic,
	enableInPlaceValueChanges: true,
};

function inPlaceProvider(
	trees: number,
	options: SharedTreeOptions = {},
): TestTreeProviderLite {
	return new TestTreeProviderLite(
		trees,
		configuredSharedTree({ ...inPlaceOptions, ...options }).getFactory(),
	);
}

function viewOf(tree: ITree): TreeViewAlpha<typeof Points> {
	return asAlpha(tree.viewWith(config));
}

describe("In-place value changes", () => {
	it("change the values of required fields whose only type is a number, string or boolean", () => {
		const view = independentView(true);
		const point = view.root[0] ?? assert.fail();
		point.x = 5;
		assert.deepEqual(headEdits(view), { valueChanges: [{ old: 0, new: 5 }], builds: 0 });
		point.label = "q";
		assert.deepEqual(headEdits(view), { valueChanges: [{ old: "p0", new: "q" }], builds: 0 });
		point.visible = false;
		assert.deepEqual(headEdits(view), {
			valueChanges: [{ old: true, new: false }],
			builds: 0,
		});
		assert.deepEqual([point.x, point.label, point.visible], [5, "q", false]);
	});

	it("are not used for optional fields, fields of several types, or when disabled", () => {
		const view = independentView(true);
		const point = view.root[0] ?? assert.fail();
		point.maybe = 3;
		assert.deepEqual(headEdits(view), { valueChanges: [], builds: 1 });
		point.either = 4;
		assert.deepEqual(headEdits(view), { valueChanges: [], builds: 1 });

		const disabled = independentView(false);
		(disabled.root[0] ?? assert.fail()).x = 5;
		assert.deepEqual(headEdits(disabled), { valueChanges: [], builds: 1 });
	});

	it("are only used for fields whose stored schema allows them", () => {
		class Holder extends sf.object("Holder", { point: Point, points: Points }) {}
		const view = createIndependentTreeAlpha({ enableInPlaceValueChanges: true }).viewWith(
			new TreeViewConfiguration({ schema: Holder }),
		);
		assert(view instanceof SchematizingSimpleTreeView);
		view.initialize(new Holder({ point: initialPoints(1)[0] ?? assert.fail(), points: [] }));
		const schema = view.checkout.storedSchema;
		const fieldSchema = (type: { identifier: string }, key: string) => {
			const node = schema.nodeSchema.get(brand(type.identifier));
			assert(node instanceof ObjectNodeStoredSchema);
			return node.getFieldSchema(brand(key));
		};
		const inPlace = (type: { identifier: string }, key: string) =>
			isInPlaceValueField(fieldSchema(type, key), schema);
		assert.deepEqual(
			["x", "label", "visible", "maybe", "either"].map((key) => inPlace(Point, key)),
			[true, true, true, false, false],
		);
		// Required fields of nodes which are not leaves are replaced.
		assert.deepEqual(
			["point", "points"].map((key) => inPlace(Holder, key)),
			[false, false],
		);
		TreeAlpha.setFields([[view.root, "point", initialPoints(1)[0] ?? assert.fail()]]);
		assert.deepEqual(headEdits(view).valueChanges, []);
	});

	it("are used by setFields", () => {
		const view = independentView(true);
		const [first, second] = [view.root[0] ?? assert.fail(), view.root[1] ?? assert.fail()];
		TreeAlpha.setFields([
			[first, "x", 10],
			[first, "label", "a"],
			[second, "x", 20],
			[second, "maybe", 7],
		]);
		const { valueChanges, builds } = headEdits(view);
		assert.equal(builds, 1);
		assert.deepEqual(
			new Set(valueChanges.map((change) => JSON.stringify(change))),
			new Set([
				JSON.stringify({ old: 0, new: 10 }),
				JSON.stringify({ old: "p0", new: "a" }),
				JSON.stringify({ old: 1, new: 20 }),
			]),
		);
		assert.deepEqual([first.x, first.label, second.x, second.maybe], [10, "a", 20, 7]);
	});

	it("raise the same events as replacing the leaves", () => {
		function eventLog(enable: boolean): string[] {
			const view = independentView(enable);
			const log: string[] = [];
			const [first, second] = [view.root[0] ?? assert.fail(), view.root[1] ?? assert.fail()];
			for (const [name, node] of [
				["first", first],
				["second", second],
			] as const) {
				Tree.on(
					node,
					"nodeChanged",
					({ changedProperties }: { changedProperties?: ReadonlySet<string> }) =>
						log.push(`${name} nodeChanged ${[...(changedProperties ?? [])].join(",")}`),
				);
				Tree.on(node, "treeChanged", () => log.push(`${name} treeChanged`));
			}
			Tree.on(view.root, "nodeChanged", () => log.push("root nodeChanged"));
			Tree.on(view.root, "treeChanged", () => log.push("root treeChanged"));
			view.events.on("changed", () => log.push("changed"));
			first.x = 1;
			first.label = "b";
			view.runTransaction(() => {
				first.x = 2;
				second.visible = true;
				first.x = 3;
			});
			TreeAlpha.setFields([
				[first, "x", 4],
				[second, "label", "c"],
			]);
			log.push(JSON.stringify(view.root));
			return log;
		}
		assert.deepEqual(eventLog(true), eventLog(false));
	});

	for (const forest of [ForestTypeReference, ForestTypeOptimized]) {
		describe(`with the ${forest === ForestTypeOptimized ? "optimized" : "reference"} forest`, () => {
			it("can be undone and redone", () => {
				const view = independentView(true, { forest });
				const { undoStack, redoStack, unsubscribe } = createTestUndoRedoStacks(view.events);
				const point = view.root[0] ?? assert.fail();
				point.x = 5;
				view.runTransaction(() => {
					point.x = 6;
					point.label = "a";
				});
				TreeAlpha.setFields([
					[point, "x", 7],
					[point, "visible", false],
				]);
				assert.deepEqual([point.x, point.label, point.visible], [7, "a", false]);
				undoStack.pop()?.revert();
				assert.deepEqual([point.x, point.label, point.visible], [6, "a", true]);
				undoStack.pop()?.revert();
				assert.deepEqual([point.x, point.label, point.visible], [5, "p0", true]);
				undoStack.pop()?.revert();
				assert.deepEqual([point.x, point.label, point.visible], [0, "p0", true]);
				redoStack.pop()?.revert();
				redoStack.pop()?.revert();
				redoStack.pop()?.revert();
				assert.deepEqual([point.x, point.label, point.visible], [7, "a", false]);
				unsubscribe();
			});

			it("are rolled back with their transaction", () => {
				const view = independentView(true, { forest });
				const point = view.root[0] ?? assert.fail();
				view.runTransaction(() => {
					point.x = 5;
					point.label = "a";
					point.x = 6;
					return { rollback: true };
				});
				assert.deepEqual([point.x, point.label], [0, "p0"]);
				point.x = 7;
				assert.equal(point.x, 7);
			});

			it("retain no removed content", () => {
				for (const enable of [true, false]) {
					const view = independentView(enable, { forest, maxRevertibles: 5 });
					const { unsubscribe } = createTestUndoRedoStacks(view.events);
					const point = view.root[0] ?? assert.fail();
					for (let i = 0; i < 20; i++) {
						point.x = i + 100;
					}
					assert.equal(view.checkout.getRemovedRoots().length === 0, enable);
					unsubscribe();
				}
			});

			it("do not change other trees sharing the content", () => {
				const view = independentView(true, { forest }, 50);
				const fork = view.fork();
				(fork.root[10] ?? assert.fail()).x = -1;
				(view.root[20] ?? assert.fail()).label = "changed";
				assert.deepEqual(
					view.root.map((point) => [point.x, point.label]),
					initialPoints(50).map((point, i) => [i, i === 20 ? "changed" : point.label]),
				);
				assert.deepEqual(
					fork.root.map((point) => [point.x, point.label]),
					initialPoints(50).map((point, i) => [i === 10 ? -1 : i, point.label]),
				);
				view.merge(fork);
				assert.equal(view.root[10]?.x, -1);
				assert.equal(view.root[20]?.label, "changed");
			});
		});
	}

	it("apply to nodes inserted by the same transaction, also when minimized", () => {
		for (const postProcessor of [undefined, minimize]) {
			const view = independentView(true);
			view.runTransaction(
				() => {
					view.root.insertAtEnd(new Point({ x: 1, label: "new", visible: true, either: 1 }));
					const inserted = view.root[2] ?? assert.fail();
					inserted.x = 2;
					inserted.label = "newer";
					(view.root[0] ?? assert.fail()).x = 3;
				},
				{ postProcessor },
			);
			assert.deepEqual(
				view.root.map((point) => [point.x, point.label]),
				[
					[3, "p0"],
					[1, "p1"],
					[2, "newer"],
				],
			);
			if (postProcessor !== undefined) {
				// The changes of the inserted node's values are part of its build.
				assert.deepEqual(headEdits(view), {
					valueChanges: [{ old: 0, new: 3 }],
					builds: 1,
				});
			}
		}
	});

	it("update tree indexes and dirty tracking", () => {
		const view = independentView(true);
		const index = createTreeIndex(
			view,
			(schema) => (schema === Point ? "label" : undefined),
			(nodes) => nodes,
			(key: TreeIndexKey): key is string => typeof key === "string",
		);
		const dirty = new Map<TreeNode, DirtyTreeStatus>();
		const stopTracking = trackDirtyNodes(view, dirty);
		const point = view.root[1] ?? assert.fail();
		point.label = "relabeled";
		assert.equal(index.get("relabeled")?.[0], point);
		assert.equal(index.get("p1"), undefined);
		assert.equal(dirty.get(point), "changed");
		assert.equal(dirty.get(view.root[0] ?? assert.fail()), undefined);
		stopTracking();
		index.dispose();
	});

	describe("collaboration", () => {
		it("the last sequenced value wins", () => {
			for (const firstClient of [0, 1]) {
				const provider = inPlaceProvider(2);
				const views = provider.trees.map(viewOf);
				views[0]?.initialize(initialPoints());
				provider.synchronizeMessages();
				const points = views.map((view) => view.root[0] ?? assert.fail());
				const secondClient = 1 - firstClient;
				(points[firstClient] ?? assert.fail()).x = 10;
				(points[secondClient] ?? assert.fail()).x = 20;
				provider.synchronizeMessages();
				assert.deepEqual(
					points.map((point) => point.x),
					[20, 20],
				);
			}
		});

		it("converge with a concurrent removal of the node, and its undo", () => {
			for (const removeFirst of [false, true]) {
				const provider = inPlaceProvider(2);
				const views = provider.trees.map(viewOf);
				const [view0, view1] = [views[0] ?? assert.fail(), views[1] ?? assert.fail()];
				view0.initialize(initialPoints());
				provider.synchronizeMessages();
				const { undoStack, unsubscribe } = createTestUndoRedoStacks(view1.events);
				const setValue = (): void => {
					(view0.root[0] ?? assert.fail()).x = 10;
				};
				const remove = (): void => view1.root.removeAt(0);
				if (removeFirst) {
					remove();
					setValue();
				} else {
					setValue();
					remove();
				}
				provider.synchronizeMessages();
				assert.deepEqual(JSON.stringify(view0.root), JSON.stringify(view1.root));
				assert.equal(view0.root.length, 1);
				undoStack.pop()?.revert();
				provider.synchronizeMessages();
				assert.deepEqual(JSON.stringify(view0.root), JSON.stringify(view1.root));
				assert.equal(view0.root[0]?.x, 10);
				unsubscribe();
			}
		});

		it("a concurrent replacement of the leaf wins", () => {
			// One client replaces leaves; the other changes them in place.
			for (const replaceFirst of [false, true]) {
				const factories = [
					configuredSharedTree(inPlaceOptions).getFactory(),
					configuredSharedTree({
						...inPlaceOptions,
						enableInPlaceValueChanges: false,
					}).getFactory(),
				];
				let created = 0;
				const alternating: IChannelFactory<ITree> = {
					type: factories[0]?.type ?? assert.fail(),
					attributes: factories[0]?.attributes ?? assert.fail(),
					create: (...args) => (factories[created++ % 2] ?? assert.fail()).create(...args),
					load: async (...args) => (factories[created++ % 2] ?? assert.fail()).load(...args),
				};
				const provider = new TestTreeProviderLite(2, alternating);
				const views = provider.trees.map(viewOf);
				const [inPlaceView, replacingView] = [
					views[0] ?? assert.fail(),
					views[1] ?? assert.fail(),
				];
				inPlaceView.initialize(initialPoints());
				provider.synchronizeMessages();
				const replace = (): void => {
					(replacingView.root[0] ?? assert.fail()).x = 7;
				};
				const changeInPlace = (): void => {
					(inPlaceView.root[0] ?? assert.fail()).x = 5;
				};
				if (replaceFirst) {
					replace();
					changeInPlace();
				} else {
					changeInPlace();
					replace();
				}
				provider.synchronizeMessages();
				assert.equal(inPlaceView.root[0]?.x, 7);
				assert.equal(replacingView.root[0]?.x, 7);
			}
		});

		it("are summarized and loaded", async () => {
			const idCompressor = createIdCompressor(SerializationVersion.V3);
			const runtime = new MockFluidDataStoreRuntime({ idCompressor });
			const containerRuntimeFactory = new MockContainerRuntimeFactory();
			containerRuntimeFactory.createContainerRuntime(runtime);
			const factory = configuredSharedTree({
				...inPlaceOptions,
				retainHistory: true,
			}).getFactory();
			const tree = factory.create(runtime, "tree");
			tree.connect({
				deltaConnection: runtime.createDeltaConnection(),
				objectStorage: new MockStorage(),
			});
			const view = viewOf(tree);
			view.initialize(initialPoints());
			(view.root[0] ?? assert.fail()).x = 42;
			containerRuntimeFactory.processAllMessages();
			const { summary } = tree.getAttachSummary(true);
			const serialized = JSON.stringify(summary);
			assert(serialized.includes("in-place-values|v0.1"));
			assert(serialized.includes("valueChange"));

			const loaded = await factory.load(
				new MockFluidDataStoreRuntime({ idCompressor }),
				"loaded",
				{
					deltaConnection: new MockDeltaConnection(
						() => 0,
						() => {},
					),
					objectStorage: new MockStorage(convertSummaryTreeToITree(summary)),
				},
				factory.attributes,
			);
			assert.equal(viewOf(loaded).root[0]?.x, 42);
		});

		it("cannot be enabled with shared branches", () => {
			assert.throws(() =>
				configuredSharedTree({ enableInPlaceValueChanges: true, enableSharedBranches: true }),
			);
		});
	});
});
