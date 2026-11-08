/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

// eslint-disable-next-line import-x/no-internal-modules
import { createIndependentTreeCheckout } from "../../shared-tree/independentView.js";
import {
	ForestTypeOptimized,
	ForestTypeReference,
	Tree,
	TreeAlpha,
	type ForestType,
} from "../../shared-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { SchematizingSimpleTreeView } from "../../shared-tree/schematizingTreeView.js";
import { TreeStatus } from "../../feature-libraries/index.js";
import {
	SchemaFactoryAlpha,
	TreeViewConfiguration,
	type FieldAssignment,
	type VerboseFieldAssignment,
	type VerboseTree,
} from "../../simple-tree/index.js";
import { createTestUndoRedoStacks } from "../utils.js";

const sf = new SchemaFactoryAlpha("setFields");
class Offset extends sf.object("Offset", { x: sf.number, y: sf.number }) {}
class Shape extends sf.object("Shape", {
	name: sf.string,
	offset: Offset,
	fill: sf.optional(sf.string, { key: "f" }),
}) {}
class Shapes extends sf.array("Shapes", Shape) {}
class Tagged extends sf.object("Tagged", { id: sf.identifier }) {}
class Root extends sf.object("Root", {
	shapes: Shapes,
	title: sf.string,
	featured: sf.optional(Shape),
	tagged: sf.optional(Tagged),
	otherTagged: sf.optional(Tagged),
}) {}
const config = new TreeViewConfiguration({ schema: Root });

type View = SchematizingSimpleTreeView<typeof Root>;

function createView(forest: ForestType, shapeCount = 5): View {
	const checkout = createIndependentTreeCheckout({ forest });
	const view = checkout.viewWith(config);
	const shapes: Shape[] = [];
	for (let index = 0; index < shapeCount; index++) {
		shapes.push(
			new Shape({
				name: `shape ${index}`,
				offset: new Offset({ x: index, y: -index }),
				fill: index % 2 === 0 ? `fill ${index}` : undefined,
			}),
		);
	}
	view.initialize(new Root({ shapes, title: "title" }));
	return view;
}

function shapeAt(view: View, index: number): Shape {
	const shape = view.root.shapes[index];
	assert(shape !== undefined);
	return shape;
}

function exportTree(view: View): unknown {
	return TreeAlpha.exportConcise(view.root);
}

function countCommits(view: View): { readonly count: number; readonly off: () => void } {
	const counter = { count: 0, off: () => {} };
	counter.off = view.events.on("changed", (data) => {
		if (data.isLocal) {
			counter.count++;
		}
	});
	return counter;
}

/**
 * Assignments moving each shape, with a value for each built by `makeOffset`.
 */
function moves(view: View, makeOffset: (index: number) => Offset): FieldAssignment[] {
	return view.root.shapes.map((shape, index) => [shape, "offset", makeOffset(index)] as const);
}

/**
 * Checks that the tree is unchanged after a failed call, and that it can still be edited, with new nodes hydrated.
 */
function assertUnchangedAndEditable(view: View, before: unknown): void {
	assert.deepEqual(exportTree(view), before);
	const offset = new Offset({ x: 100, y: 100 });
	shapeAt(view, 0).offset = offset;
	assert.equal(shapeAt(view, 0).offset, offset);
	assert.equal(Tree.status(offset), TreeStatus.InDocument);
}

describe("TreeAlpha.setFields", () => {
	for (const [forestName, forest] of [
		["reference", ForestTypeReference],
		["optimized", ForestTypeOptimized],
	] as const) {
		describe(`${forestName} forest`, () => {
			it("gives the same result as assigning each property", () => {
				const batched = createView(forest);
				const sequential = createView(forest);
				const assignments = (view: View): FieldAssignment[] => [
					...moves(view, (index) => new Offset({ x: index * 10, y: index * 20 })),
					[shapeAt(view, 1), "fill", "red"],
					[shapeAt(view, 2), "fill", undefined],
					[shapeAt(view, 3), "fill", undefined],
					[view.root, "title", "moved"],
					[view.root, "featured", new Shape({ name: "new", offset: { x: 1, y: 2 } })],
					[shapeAt(view, 4), "name", "renamed"],
				];

				TreeAlpha.setFields(assignments(batched));
				for (const [node, key, value] of assignments(sequential)) {
					(node as unknown as Record<string, unknown>)[key] = value;
				}
				assert.deepEqual(exportTree(batched), exportTree(sequential));
				assert.equal(shapeAt(batched, 3).offset.x, 30);
				assert.equal(shapeAt(batched, 1).fill, "red");
				assert.equal(shapeAt(batched, 2).fill, undefined);
				assert.equal(batched.root.featured?.offset.y, 2);
			});

			it("is one edit, undone and redone as a whole", () => {
				const view = createView(forest);
				const { undoStack, redoStack, unsubscribe } = createTestUndoRedoStacks(view.events);
				const commits = countCommits(view);
				const before = exportTree(view);
				TreeAlpha.setFields([
					...moves(view, (index) => new Offset({ x: index + 0.5, y: 0 })),
					[shapeAt(view, 0), "fill", undefined],
					[shapeAt(view, 1), "fill", "blue"],
				]);
				const after = exportTree(view);
				assert.equal(commits.count, 1);
				assert.equal(undoStack.length, 1);

				undoStack.pop()?.revert();
				assert.deepEqual(exportTree(view), before);
				redoStack.pop()?.revert();
				assert.deepEqual(exportTree(view), after);
				commits.off();
				unsubscribe();
			});

			it("rebases over concurrent edits, and concurrent edits rebase over it", () => {
				const main = createView(forest);
				const branch = main.fork();
				TreeAlpha.setFields([
					...moves(branch, (index) => new Offset({ x: index + 100, y: 0 })),
					[shapeAt(branch, 1), "fill", "blue"],
					[branch.root, "title", "branch"],
				]);
				const other = main.fork();
				other.root.shapes.insertAt(
					0,
					new Shape({ name: "inserted", offset: { x: -1, y: -1 } }),
				);
				shapeAt(other, 3).fill = "green";

				main.merge(other, false);
				branch.rebaseOnto(main);
				assert.equal(shapeAt(branch, 0).name, "inserted");
				assert.equal(shapeAt(branch, 0).offset.x, -1);
				for (let index = 1; index <= 5; index++) {
					assert.equal(shapeAt(branch, index).offset.x, index - 1 + 100);
				}
				assert.equal(shapeAt(branch, 2).fill, "blue");
				assert.equal(shapeAt(branch, 3).fill, "green");
				assert.equal(branch.root.title, "branch");

				const late = createView(forest);
				const lateOther = late.fork();
				TreeAlpha.setFields(moves(late, (index) => new Offset({ x: index * 2, y: 1 })));
				lateOther.root.shapes.removeAt(1);
				late.merge(lateOther);
				assert.deepEqual(
					late.root.shapes.map((shape) => shape.offset.x),
					[0, 4, 6, 8],
				);
			});

			it("hydrates the new nodes", () => {
				const view = createView(forest);
				const offsets = view.root.shapes.map((_, index) => new Offset({ x: index, y: 7 }));
				const featuredOffset = new Offset({ x: 3, y: 4 });
				const featured = new Shape({ name: "featured", offset: featuredOffset });
				// Interleave clears, which insert no content, with sets that do.
				TreeAlpha.setFields([
					[shapeAt(view, 0), "fill", undefined],
					[shapeAt(view, 0), "offset", offsets[0]],
					[shapeAt(view, 1), "offset", offsets[1]],
					[shapeAt(view, 2), "fill", undefined],
					[view.root, "featured", featured],
					[shapeAt(view, 2), "offset", offsets[2]],
					[shapeAt(view, 3), "offset", offsets[3]],
					[shapeAt(view, 4), "fill", undefined],
					[shapeAt(view, 4), "offset", offsets[4]],
				]);
				for (const [index, offset] of offsets.entries()) {
					assert.equal(shapeAt(view, index).offset, offset);
					assert.equal(Tree.status(offset), TreeStatus.InDocument);
					assert.equal(Tree.parent(offset), shapeAt(view, index));
				}
				assert.equal(view.root.featured, featured);
				assert.equal(featured.offset, featuredOffset);
				assert.equal(Tree.status(featuredOffset), TreeStatus.InDocument);

				// The hydrated nodes can be edited, including by another call.
				TreeAlpha.setFields([
					[featuredOffset, "x", 30],
					[offsets[1] ?? assert.fail(), "y", 70],
				]);
				assert.equal(view.root.featured?.offset.x, 30);
				assert.equal(shapeAt(view, 1).offset.y, 70);
			});

			it("raises change events once", () => {
				const view = createView(forest);
				const changed: string[] = [];
				const offs = [
					Tree.on(shapeAt(view, 0), "nodeChanged", ({ changedProperties }) =>
						changed.push(`shape 0: ${[...(changedProperties ?? [])].sort().join(",")}`),
					),
					Tree.on(shapeAt(view, 1), "nodeChanged", ({ changedProperties }) =>
						changed.push(`shape 1: ${[...(changedProperties ?? [])].sort().join(",")}`),
					),
					Tree.on(view.root, "treeChanged", () => changed.push("root tree")),
				];
				TreeAlpha.setFields([
					[shapeAt(view, 0), "offset", new Offset({ x: 1, y: 1 })],
					[shapeAt(view, 0), "fill", "green"],
					[shapeAt(view, 1), "offset", new Offset({ x: 2, y: 2 })],
				]);
				assert.deepEqual(changed.sort(), [
					"root tree",
					"shape 0: fill,offset",
					"shape 1: offset",
				]);
				for (const off of offs) {
					off();
				}
			});

			it("does nothing when emptying empty properties", () => {
				const view = createView(forest);
				const commits = countCommits(view);
				TreeAlpha.setFields([
					[shapeAt(view, 1), "fill", undefined],
					[view.root, "featured", undefined],
				]);
				TreeAlpha.setFields([]);
				assert.equal(commits.count, 0);
				commits.off();
			});

			it("works in transactions", () => {
				const view = createView(forest);
				const before = exportTree(view);
				view.runTransaction(() => {
					TreeAlpha.setFields(moves(view, (index) => new Offset({ x: index, y: 1 })));
					return { rollback: true } as const;
				});
				assert.deepEqual(exportTree(view), before);

				const commits = countCommits(view);
				view.runTransaction(() => {
					TreeAlpha.setFields(moves(view, (index) => new Offset({ x: index, y: 1 })));
					assert.equal(shapeAt(view, 2).offset.y, 1);
					TreeAlpha.setFields([[shapeAt(view, 2), "name", "in transaction"]]);
				});
				assert.equal(commits.count, 1);
				assert.equal(shapeAt(view, 3).offset.y, 1);
				assert.equal(shapeAt(view, 2).name, "in transaction");
				commits.off();
			});

			describe("rejects, changing nothing,", () => {
				const cases: [string, (view: View) => FieldAssignment[], RegExp][] = [
					[
						"undefined for a required property",
						(view) => [
							[shapeAt(view, 0), "offset", new Offset({ x: 1, y: 1 })],
							[shapeAt(view, 1), "offset", undefined],
						],
						/undefined for non-optional field/,
					],
					[
						"a value of a type the property does not allow",
						(view) => [
							[shapeAt(view, 0), "offset", new Offset({ x: 1, y: 1 })],
							[shapeAt(view, 1), "offset", "not an offset"],
						],
						/.*/,
					],
					[
						"a property set twice",
						(view) => [
							[shapeAt(view, 0), "offset", new Offset({ x: 1, y: 1 })],
							[shapeAt(view, 0), "offset", new Offset({ x: 2, y: 2 })],
						],
						/more than once/,
					],
					[
						"a node under a property set by the same call",
						(view) => [
							[shapeAt(view, 0).offset, "x", 5],
							[shapeAt(view, 0), "offset", new Offset({ x: 1, y: 1 })],
						],
						/under a property set by the same call/,
					],
					[
						"a node deeper under a property set by the same call",
						(view) => [
							[view.root, "shapes", []],
							[shapeAt(view, 0).offset, "x", 5],
						],
						/under a property set by the same call/,
					],
					[
						"an unknown property",
						(view) => [[shapeAt(view, 0), "colour", "red"]],
						/not a property of/,
					],
					[
						"a property by its stored key",
						(view) => [[shapeAt(view, 0), "f", "red"]],
						/not a property of/,
					],
					[
						"an identifier property",
						(view) => {
							view.root.tagged = new Tagged({});
							return [[view.root.tagged, "id", "x"]];
						},
						/cannot be set/,
					],
					[
						"a node which is not an object node",
						(view) => [
							[view.root.shapes, "0", new Shape({ name: "x", offset: { x: 0, y: 0 } })],
						],
						/object nodes/,
					],
					[
						"an unhydrated node",
						() => [[new Offset({ x: 0, y: 0 }), "x", 1]],
						/in the document/,
					],
					[
						"a removed node",
						(view) => {
							const shape = shapeAt(view, 0);
							view.root.shapes.removeAt(0);
							return [[shape, "name", "removed"]];
						},
						/in the document/,
					],
					[
						"nodes of different trees",
						(view) => [
							[shapeAt(view, 0), "name", "a"],
							[shapeAt(createView(forest), 0), "name", "b"],
						],
						/same tree/,
					],
				];
				for (const [name, makeAssignments, message] of cases) {
					it(name, () => {
						const view = createView(forest);
						const assignments = makeAssignments(view);
						const before = exportTree(view);
						assert.throws(() => TreeAlpha.setFields(assignments), validateUsageError(message));
						assertUnchangedAndEditable(view, before);
					});
				}
			});
		});
	}
});

/**
 * Content in the verbose format, with stored keys, for an offset.
 */
function verboseOffset(x: number, y: number): VerboseTree {
	return { type: Offset.identifier, fields: { x, y } };
}

describe("TreeAlpha.setFieldsVerbose", () => {
	for (const [forestName, forest] of [
		["reference", ForestTypeReference],
		["optimized", ForestTypeOptimized],
	] as const) {
		describe(`${forestName} forest`, () => {
			it("gives the same result as setFields with the same content", () => {
				const verbose = createView(forest);
				const nodes = createView(forest);
				const shared = verboseOffset(7, 8);
				TreeAlpha.setFieldsVerbose([
					...verbose.root.shapes.map(
						(shape) => [shape, "offset", shared] as VerboseFieldAssignment,
					),
					[shapeAt(verbose, 1), "fill", "red"],
					[shapeAt(verbose, 2), "fill", undefined],
					[verbose.root, "title", "moved"],
				]);
				TreeAlpha.setFields([
					...moves(nodes, () => new Offset({ x: 7, y: 8 })),
					[shapeAt(nodes, 1), "fill", "red"],
					[shapeAt(nodes, 2), "fill", undefined],
					[nodes.root, "title", "moved"],
				]);
				assert.deepEqual(exportTree(verbose), exportTree(nodes));
				assert.equal(Tree.status(shapeAt(verbose, 3).offset), TreeStatus.InDocument);
			});

			it("gives each property its own copy of content given for several properties", () => {
				const view = createView(forest);
				const shared = verboseOffset(1, 2);
				TreeAlpha.setFieldsVerbose(
					view.root.shapes.map((shape) => [shape, "offset", shared] as VerboseFieldAssignment),
				);
				shapeAt(view, 0).offset.x = 10;
				TreeAlpha.setFields([[shapeAt(view, 2).offset, "y", 20]]);
				assert.deepEqual(
					view.root.shapes.map(({ offset }) => [offset.x, offset.y]),
					[
						[10, 2],
						[1, 2],
						[1, 20],
						[1, 2],
						[1, 2],
					],
				);
				assert.deepEqual(shared, verboseOffset(1, 2));
			});

			it("is one edit, undone and redone as a whole", () => {
				const view = createView(forest);
				const { undoStack, redoStack, unsubscribe } = createTestUndoRedoStacks(view.events);
				const commits = countCommits(view);
				const before = exportTree(view);
				const shared = verboseOffset(3, 4);
				TreeAlpha.setFieldsVerbose([
					...view.root.shapes.map(
						(shape) => [shape, "offset", shared] as VerboseFieldAssignment,
					),
					[shapeAt(view, 0), "fill", undefined],
				]);
				const after = exportTree(view);
				assert.equal(commits.count, 1);
				undoStack.pop()?.revert();
				assert.deepEqual(exportTree(view), before);
				redoStack.pop()?.revert();
				assert.deepEqual(exportTree(view), after);
				commits.off();
				unsubscribe();
			});

			it("gives each property new identifiers", () => {
				const view = createView(forest);
				const tagged: VerboseTree = { type: Tagged.identifier, fields: {} };
				TreeAlpha.setFieldsVerbose([
					[view.root, "tagged", tagged],
					[view.root, "otherTagged", tagged],
				]);
				const first = view.root.tagged?.id;
				const second = view.root.otherTagged?.id;
				assert(first !== undefined && second !== undefined);
				assert.notEqual(first, second);
			});

			describe("rejects, changing nothing,", () => {
				const cases: [string, (view: View) => VerboseFieldAssignment[], RegExp][] = [
					[
						"undefined for a required property",
						(view) => [
							[shapeAt(view, 0), "offset", verboseOffset(1, 1)],
							[shapeAt(view, 1), "offset", undefined],
						],
						/.*/,
					],
					[
						"content of a type the property does not allow",
						(view) => [
							[shapeAt(view, 0), "offset", verboseOffset(1, 1)],
							[shapeAt(view, 1), "offset", "not an offset"],
						],
						/.*/,
					],
					[
						"shared content out of schema for a later property",
						(view) => {
							const shared = verboseOffset(1, 1);
							return [
								[shapeAt(view, 0), "offset", shared],
								[view.root, "featured", shared],
							];
						},
						/.*/,
					],
					[
						"a property set twice",
						(view) => [
							[shapeAt(view, 0), "offset", verboseOffset(1, 1)],
							[shapeAt(view, 0), "offset", verboseOffset(2, 2)],
						],
						/more than once/,
					],
					[
						"an identifier property",
						(view) => {
							view.root.tagged = new Tagged({});
							return [[view.root.tagged, "id", "x"]];
						},
						/cannot be set/,
					],
				];
				for (const [name, makeAssignments, message] of cases) {
					it(name, () => {
						const view = createView(forest);
						const assignments = makeAssignments(view);
						const before = exportTree(view);
						assert.throws(
							() => TreeAlpha.setFieldsVerbose(assignments),
							validateUsageError(message),
						);
						assertUnchangedAndEditable(view, before);
					});
				}
			});
		});
	}
});
