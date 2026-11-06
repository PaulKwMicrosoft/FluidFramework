/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

// eslint-disable-next-line import-x/no-internal-modules
import { createIndependentTreeAlpha } from "../../shared-tree/independentView.js";
import { ForestTypeOptimized, TreeAlpha } from "../../shared-tree/index.js";
import {
	SchemaFactory,
	SchemaFactoryBeta,
	TreeViewConfiguration,
} from "../../simple-tree/index.js";
import { FormattedText } from "../../text/index.js";

const sf = new SchemaFactoryBeta("test.formattedTextRunEdits");

class Format extends sf.object("Format", {
	bold: SchemaFactory.optional(SchemaFactory.boolean),
	size: SchemaFactory.number,
	font: SchemaFactory.string,
}) {}

class LineBreak extends sf.object("LineBreak", {}) {
	public get content(): string {
		return "\n";
	}
}

const plain = { size: 12, font: "Arial" } as const;

class Text extends FormattedText.createSchema(sf, Format, [LineBreak], { ...plain }) {}

const config = new TreeViewConfiguration({ schema: Text });

function build(): Text {
	return Text.fromRuns([
		{ text: "Hello world, ", format: { ...plain, bold: true } },
		{ text: "plain text here", format: { ...plain } },
		{ text: "big", format: { ...plain, size: 20 } },
	]);
}

/**
 * A view of text built from runs, in a tree with base content enabled (where formats are edited as runs) or not.
 */
function view(enableBaseContent: boolean, initial: Text = build()): Text {
	const tree = createIndependentTreeAlpha({ forest: ForestTypeOptimized, enableBaseContent });
	const v = tree.viewWith(config);
	v.initialize(initial);
	return v.root;
}

/**
 * The content of `text`, with object fields in a canonical order (editing a field can change the order fields are stored in).
 */
function describe2(text: Text): string {
	return JSON.stringify(TreeAlpha.exportVerbose(text), (key, value: unknown) =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			: value,
	);
}

function runs(text: Text): string[] {
	return [...text.runs()].map(
		(run) =>
			`${JSON.stringify(run.text)}:${JSON.stringify(Object.entries(run.format).sort())}`,
	);
}

describe("FormattedText run edits", () => {
	const edits: readonly (readonly [string, (text: Text) => void])[] = [
		["formatRange inside a run", (text) => text.formatRange(2, 8, { bold: false })],
		["formatRange across runs", (text) => text.formatRange(5, 30, { size: 30 })],
		[
			"formatRange whole text",
			(text) => text.formatRange(undefined, undefined, { bold: true }),
		],
		[
			"formatRange clearing a property",
			(text) => text.formatRange(0, 20, { bold: undefined }),
		],
		["reformat across runs", (text) => text.reformat(3, 29, { ...plain, size: 9 })],
		["reformat to default", (text) => text.reformat(0, 31)],
		["formatRange of one atom", (text) => text.formatRange(4, 5, { bold: false })],
		["empty range", (text) => text.formatRange(4, 4, { bold: false })],
	];
	for (const [name, edit] of edits) {
		it(`${name} gives the same content as editing each atom`, () => {
			const perAtom = view(false);
			const asRuns = view(true);
			edit(perAtom);
			edit(asRuns);
			assert.equal(describe2(asRuns), describe2(perAtom));
			assert.deepEqual(runs(asRuns), runs(perAtom));
			assert.equal(asRuns.fullString(), perAtom.fullString());
			for (let index = 0; index < asRuns.characterCount(); index++) {
				assert.equal(asRuns.getUniformRun(index), perAtom.getUniformRun(index));
			}
		});
	}

	it("keeps editing as runs over many edits", () => {
		const text = view(true, Text.fromRuns([{ text: "x".repeat(3000), format: { ...plain } }]));
		for (let index = 0; index < 50; index++) {
			text.formatRange(index * 50, index * 50 + 25, { bold: true });
		}
		assert.equal(text.characterCount(), 3000);
		assert.equal([...text.runs()].length, 100);
		assert.equal(text.getUniformRun(0), 25);
		assert.equal(text.getUniformRun(25), 25);
	});

	it("text with non-character atoms is edited per atom", () => {
		const initial = Text.fromRuns([
			{ text: "ab", format: { ...plain } },
			{ atoms: [new LineBreak({})], format: { ...plain } },
			{ text: "cd", format: { ...plain } },
		]);
		const perAtom = view(
			false,
			Text.fromRuns([
				{ text: "ab", format: { ...plain } },
				{ atoms: [new LineBreak({})], format: { ...plain } },
				{ text: "cd", format: { ...plain } },
			]),
		);
		const asRuns = view(true, initial);
		perAtom.formatRange(0, 5, { bold: true });
		asRuns.formatRange(0, 5, { bold: true });
		assert.equal(describe2(asRuns), describe2(perAtom));
	});

	it("rejects unknown format keys", () => {
		const text = view(true);
		assert.throws(() => text.formatRange(0, 5, { unknown: 1 } as never));
		assert.equal(text.fullString(), "Hello world, plain text herebig");
	});
});
