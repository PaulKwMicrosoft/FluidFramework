/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import { TreeStatus } from "../../feature-libraries/index.js";
import {
	createIndependentTreeAlpha,
	createIndependentTreeCheckout,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../shared-tree/independentView.js";
import { Tree, TreeAlpha, type TreeCheckout } from "../../shared-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { SchematizingSimpleTreeView } from "../../shared-tree/schematizingTreeView.js";
import { SchemaFactoryAlpha, TreeViewConfiguration } from "../../simple-tree/index.js";
import { createTestUndoRedoStacks } from "../utils.js";

const sf = new SchemaFactoryAlpha("baseContent");
class Shape extends sf.object("Shape", { fill: sf.string }) {}
class Shapes extends sf.array("Shapes", Shape) {}
class Slide extends sf.object("Slide", { title: sf.string, shapes: Shapes }) {}
class Slides extends sf.array("Slides", Slide) {}
class Theme extends sf.object("Theme", { color: sf.string }) {}
class Notes extends sf.map("Notes", sf.string) {}
class Tags extends sf.record("Tags", sf.string) {}
class Deck extends sf.object("Deck", {
	slides: Slides,
	theme: sf.optional(Theme),
	notes: Notes,
	tags: Tags,
}) {}
const config = new TreeViewConfiguration({ schema: Deck });

function placeholder(title: string): Slide {
	return new Slide({ title, shapes: [] });
}

function loadedSlide(title: string): Slide {
	return new Slide({ title, shapes: [{ fill: `${title} fill` }] });
}

function createDeck(maxRevertibles?: number): {
	checkout: TreeCheckout;
	view: SchematizingSimpleTreeView<typeof Deck>;
} {
	const checkout = createIndependentTreeCheckout({ enableBaseContent: true, maxRevertibles });
	const view = checkout.viewWith(config);
	view.initialize(
		new Deck({
			slides: [placeholder("1"), placeholder("2"), placeholder("3")],
			notes: {},
			tags: {},
		}),
	);
	return { checkout, view };
}

/**
 * Summarizes the slides as their titles and their number of shapes.
 */
function summarize(view: SchematizingSimpleTreeView<typeof Deck>): string[] {
	return view.root.slides.map((slide) => `${slide.title}:${slide.shapes.length}`);
}

describe("TreeAlpha.replaceAsBase", () => {
	it("replaces an array element without a commit", () => {
		function logEvents(deckView: SchematizingSimpleTreeView<typeof Deck>): string[] {
			const events: string[] = [];
			deckView.events.on("changed", () => events.push("changed"));
			deckView.events.on("commitApplied", () => events.push("commitApplied"));
			Tree.on(deckView.root.slides, "nodeChanged", () => events.push("nodeChanged"));
			Tree.on(deckView.root, "treeChanged", () => events.push("treeChanged"));
			return events;
		}

		const { checkout, view } = createDeck();
		const slides = view.root.slides;
		const [first, replaced, third] = slides;
		const commits = checkout.mainBranch.getCommitCount();
		const removedRoots = checkout.getRemovedRoots().length;
		const log = logEvents(view);

		TreeAlpha.replaceAsBase(slides, 1, loadedSlide("2"));

		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0"]);
		assert.equal(checkout.mainBranch.getCommitCount(), commits);
		assert.equal(checkout.getRemovedRoots().length, removedRoots);
		assert.equal(Tree.status(replaced), TreeStatus.Deleted);
		assert.equal(view.root.slides, slides);
		assert.equal(slides[0], first);
		assert.equal(slides[2], third);
		assert.equal(Tree.status(third), TreeStatus.InDocument);

		// Node events are the same as for the equivalent edit, but there are no commit events.
		const { view: editedView } = createDeck();
		const editLog = logEvents(editedView);
		editedView.runTransaction(() => {
			editedView.root.slides.removeAt(1);
			editedView.root.slides.insertAt(1, loadedSlide("2"));
		});
		assert.deepEqual(
			log,
			editLog.filter((event) => event !== "changed" && event !== "commitApplied"),
		);
		assert(editLog.includes("changed"));
		assert(log.includes("nodeChanged"));
	});

	it("sets object, map, and record fields", () => {
		const { view } = createDeck();
		const deck = view.root;

		TreeAlpha.replaceAsBase(deck, "theme", new Theme({ color: "red" }));
		assert.equal(deck.theme?.color, "red");
		TreeAlpha.replaceAsBase(deck, "theme", new Theme({ color: "blue" }));
		assert.equal(deck.theme?.color, "blue");
		TreeAlpha.replaceAsBase(deck, "theme", undefined);
		assert.equal(deck.theme, undefined);

		TreeAlpha.replaceAsBase(deck.notes, "a", "note");
		assert.equal(deck.notes.get("a"), "note");
		TreeAlpha.replaceAsBase(deck.notes, "a", undefined);
		assert.equal(deck.notes.has("a"), false);

		TreeAlpha.replaceAsBase(deck.tags, "a", "tag");
		assert.equal(deck.tags.a, "tag");
		TreeAlpha.replaceAsBase(deck.tags, "a", undefined);
		assert.equal(deck.tags.a, undefined);

		TreeAlpha.replaceAsBase(deck.slides[0], "title", "One");
		assert.deepEqual(summarize(view), ["One:0", "2:0", "3:0"]);
	});

	it("does not affect reverting earlier and later commits", () => {
		const { view } = createDeck();
		const { undoStack, redoStack } = createTestUndoRedoStacks(view.events);
		view.root.slides[0].title = "A";
		TreeAlpha.replaceAsBase(view.root.slides, 1, loadedSlide("2"));
		view.root.slides[2].title = "B";
		TreeAlpha.replaceAsBase(view.root, "theme", new Theme({ color: "red" }));
		assert.equal(undoStack.length, 2);

		undoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["A:0", "2:1", "3:0"]);
		undoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0"]);
		redoStack.pop()?.revert();
		redoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["A:0", "2:1", "B:0"]);
		assert.equal(view.root.theme?.color, "red");
	});

	it("is moved, removed and restored with the node it replaced", () => {
		const { view } = createDeck();
		const { undoStack, redoStack } = createTestUndoRedoStacks(view.events);
		view.root.slides.insertAtEnd(placeholder("4"));
		view.root.slides.moveToStart(1);
		assert.deepEqual(summarize(view), ["2:0", "1:0", "3:0", "4:0"]);
		TreeAlpha.replaceAsBase(view.root.slides, 3, loadedSlide("4"));
		TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("2"));

		undoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0", "4:1"]);
		undoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0"]);
		redoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0", "4:1"]);

		view.root.slides.removeAt(3);
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0"]);
		undoStack.pop()?.revert();
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0", "4:1"]);
	});

	it("applies reverts of commits that set the replaced field to the new content", () => {
		const { view } = createDeck();
		const { undoStack, redoStack } = createTestUndoRedoStacks(view.events);
		view.root.theme = new Theme({ color: "red" });
		TreeAlpha.replaceAsBase(view.root, "theme", new Theme({ color: "blue" }));
		undoStack.pop()?.revert();
		assert.equal(view.root.theme?.color, undefined);
		redoStack.pop()?.revert();
		assert.equal(view.root.theme?.color, "blue");
	});

	it("rejects content changed by a retained commit", () => {
		const { view } = createDeck(1);
		view.root.slides[1].title = "Edited";
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.slides, 1, loadedSlide("2")),
			validateUsageError(/changed by a commit retained in the history/),
		);
		view.root.slides[1].shapes.insertAtEnd(new Shape({ fill: "green" }));
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.slides, 1, loadedSlide("2")),
			validateUsageError(/changed by a commit retained in the history/),
		);
		// Other content can still be replaced.
		TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("1"));
		// Once the commits leave the retained history, the content can be replaced.
		view.root.slides[2].title = "Other";
		TreeAlpha.replaceAsBase(view.root.slides, 1, loadedSlide("2"));
		assert.deepEqual(summarize(view), ["1:1", "2:1", "Other:0"]);
	});

	it("rejects filling or emptying a field changed by a retained commit", () => {
		const { view } = createDeck();
		view.root.theme = new Theme({ color: "red" });
		view.root.theme = undefined;
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root, "theme", new Theme({ color: "blue" })),
			validateUsageError(/changed by a commit retained in the history/),
		);
		view.root.notes.set("a", "note");
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.notes, "a", undefined),
			validateUsageError(/changed by a commit retained in the history/),
		);
		// Replacing content which is neither changed by a retained commit nor in a field it changed is allowed.
		TreeAlpha.replaceAsBase(view.root.notes, "b", "other");
		assert.equal(view.root.notes.get("b"), "other");
	});

	it("ignores the edits of aborted transactions", () => {
		const { view } = createDeck();
		view.runTransaction(() => {
			view.root.slides[1].title = "Aborted";
			return { rollback: true };
		});
		TreeAlpha.replaceAsBase(view.root.slides, 1, loadedSlide("2"));
		assert.deepEqual(summarize(view), ["1:0", "2:1", "3:0"]);
	});

	it("rejects invalid targets", () => {
		const { view } = createDeck();
		const removed = view.root.slides[2];
		view.root.slides.removeAt(2);
		assert.throws(
			() => TreeAlpha.replaceAsBase(removed, "title", "x"),
			validateUsageError(/node in the document/),
		);
		assert.throws(
			() => TreeAlpha.replaceAsBase(placeholder("unhydrated"), "title", "x"),
			validateUsageError(/node in the document/),
		);
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.slides, 2, loadedSlide("3")),
			validateUsageError(/not the index of an element/),
		);
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.slides, 0, undefined),
			validateUsageError(/cannot be replaced with undefined/),
		);
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root, "unknown", "x"),
			validateUsageError(/not a property/),
		);
		assert.throws(() => TreeAlpha.replaceAsBase(view.root.slides[0], "title", undefined));
		assert.deepEqual(summarize(view), ["1:0", "2:0"]);
	});

	it("requires a tree with base content enabled", () => {
		const view = createIndependentTreeAlpha().viewWith(config);
		view.initialize(new Deck({ slides: [placeholder("1")], notes: {}, tags: {} }));
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("1")),
			validateUsageError(/"enableBaseContent"/),
		);
	});

	it("is rejected during transactions, change events, and while the tree has forks", () => {
		const { view } = createDeck();
		view.runTransaction(() => {
			assert.throws(
				() => TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("1")),
				validateUsageError(/during a transaction/),
			);
		});
		const off = view.events.on("changed", () => {
			assert.throws(
				() => TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("1")),
				validateUsageError(/forbidden during a change event/),
			);
		});
		view.root.slides[2].title = "Edited";
		off();
		const fork = view.fork();
		assert.throws(
			() => TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("1")),
			validateUsageError(/while the tree has forks/),
		);
		fork.dispose();
		TreeAlpha.replaceAsBase(view.root.slides, 0, loadedSlide("1"));
		assert.deepEqual(summarize(view), ["1:1", "2:0", "Edited:0"]);
	});

	it("keeps the history and its length unchanged", () => {
		const { checkout, view } = createDeck();
		const history = view.branchHistory;
		view.root.slides[0].title = "A";
		const length = history.length;
		const head = checkout.mainBranch.getHead();
		for (let i = 1; i <= 2; i++) {
			TreeAlpha.replaceAsBase(view.root.slides, i, loadedSlide(`${i + 1}`));
		}
		assert.equal(checkout.mainBranch.getHead(), head);
		assert.equal(history.length, length);
		view.root.slides[0].title = "B";
		assert.equal(history.length, checkout.mainBranch.getCommitCount());
	});
});
