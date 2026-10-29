/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import { FluidClientVersion } from "../../codec/index.js";
import { FormatValidatorBasic } from "../../external-utilities/index.js";
import {
	buildChunkedForest,
	defaultSchemaPolicy,
	makeTreeChunker,
	TextRunChunk,
	type TreeChunk,
} from "../../feature-libraries/index.js";
import {
	createIndependentTreeAlpha,
	ForestTypeOptimized,
	ForestTypeReference,
	TreeAlpha,
	TreeBeta,
	type ForestType,
} from "../../shared-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules -- Building forest types for the test
import { toForestType } from "../../shared-tree/forestType.js";
import {
	KeyEncodingOptions,
	SchemaFactory,
	SchemaFactoryAlpha,
	SchemaFactoryBeta,
	TreeViewConfiguration,
	type TreeNode,
	type VerboseTree,
} from "../../simple-tree/index.js";
import { FormattedText } from "../../text/index.js";
import { configuredSharedTree } from "../../treeFactory.js";
import { TestTreeProviderLite } from "../utils.js";

const sf = new SchemaFactoryBeta("test.formattedTextRuns");

class Color extends sf.object("Color", {
	r: SchemaFactory.number,
	g: SchemaFactory.number,
	b: SchemaFactory.number,
}) {}

class Format extends sf.object("Format", {
	bold: SchemaFactory.optional(SchemaFactory.boolean),
	italic: SchemaFactory.optional(SchemaFactory.boolean),
	size: SchemaFactory.number,
	font: SchemaFactory.string,
	language: SchemaFactory.string,
	kerning: SchemaFactory.number,
	baseline: SchemaFactory.number,
	color: SchemaFactory.optional(Color),
}) {}

class LineBreak extends sf.object("LineBreak", {}) {
	public get content(): string {
		return "\n";
	}
}

const plain = { size: 12, font: "Arial", language: "en-US", kerning: 0, baseline: 0 } as const;

class Text extends FormattedText.createSchema(sf, Format, [LineBreak], { ...plain }) {}

const red = (): Format => new Format({ ...plain, color: new Color({ r: 255, g: 0, b: 0 }) });
const config = new TreeViewConfiguration({ schema: Text });

/**
 * Forests whose results are compared: a reference forest, and chunked forests with and without shared subtrees.
 */
const forests: readonly (readonly [string, ForestType])[] = [
	["reference", ForestTypeReference],
	[
		"chunked, every subtree separate",
		toForestType((breaker, schema, idCompressor, shouldEncodeIncrementally) =>
			buildChunkedForest(
				makeTreeChunker(schema, defaultSchemaPolicy, shouldEncodeIncrementally, false),
				undefined,
				idCompressor,
				breaker,
			),
		),
	],
	[
		"chunked, identical subtrees shared",
		toForestType((breaker, schema, idCompressor, shouldEncodeIncrementally) =>
			buildChunkedForest(
				makeTreeChunker(schema, defaultSchemaPolicy, shouldEncodeIncrementally),
				undefined,
				idCompressor,
				breaker,
			),
		),
	],
];

/**
 * How the initial text is built: atom by atom (fromString and insertAt), or as runs (fromRuns).
 * Both build the same content.
 */
type Build = "atoms" | "runs";

/**
 * The initial text: "Hello world, " and "hello shared text." in red, a line break, and "Bye." in the default format.
 */
function buildInitial(build: Build): Text {
	if (build === "atoms") {
		const text = Text.fromString("Hello world, ", red());
		text.insertAt(text.characterCount(), "hello shared text.", red());
		text.insertAt(text.characterCount(), [new LineBreak({})], { ...plain });
		text.insertAt(text.characterCount(), "Bye.");
		return text;
	}
	return Text.fromRuns([
		{ text: "Hello world, ", format: red() },
		{ text: "hello shared text.", format: red() },
		{ atoms: [new LineBreak({})], format: { ...plain } },
		{ text: "Bye." },
	]);
}

interface ScenarioResult {
	readonly ops: readonly string[];
	readonly content: readonly string[];
	readonly summary: string;
	readonly runs: readonly string[];
	/**
	 * Text run chunks in the first client's forest after loading the initial text.
	 */
	readonly textRunChunks: number;
}

/**
 * Number of {@link TextRunChunk}s in the forest of `tree`.
 */
function countTextRunChunks(tree: unknown): number {
	const forest = (tree as { kernel: { checkout: { forest: { roots?: TreeChunk } } } }).kernel
		.checkout.forest;
	let count = 0;
	const visit = (chunk: TreeChunk): void => {
		if (chunk instanceof TextRunChunk) {
			count++;
		}
		const fields = (chunk as { fields?: Map<string, TreeChunk[]> }).fields;
		for (const children of fields?.values() ?? []) {
			children.forEach(visit);
		}
	};
	if (forest.roots !== undefined) {
		visit(forest.roots);
	}
	return count;
}

/**
 * Two clients load the same text (built as `build` says), edit it concurrently with `edit`, and synchronize.
 * Returns every op sequenced (in order), each client's content and runs, and a summary.
 */
async function runScenario(
	forest: ForestType,
	build: Build,
	edit: (first: Text, second: Text) => void,
): Promise<ScenarioResult> {
	const provider = new TestTreeProviderLite(
		2,
		configuredSharedTree({
			jsonValidator: FormatValidatorBasic,
			minVersionForCollab: FluidClientVersion.v2_80,
			forest,
		}).getFactory(),
	);
	const ops: string[] = [];
	const synchronize = (): void => {
		for (
			let message = provider.peekNextMessage();
			message !== undefined;
			message = provider.peekNextMessage()
		) {
			ops.push(JSON.stringify(message.contents));
			provider.synchronizeMessages({ count: 1 });
		}
	};
	const first = provider.trees[0].viewWith(config);
	first.initialize(buildInitial(build));
	synchronize();
	const textRunChunks = countTextRunChunks(provider.trees[0]);
	const second = provider.trees[1].viewWith(config);
	edit(first.root, second.root);
	synchronize();
	const views = [first, second];
	const content = views.map((view) =>
		canonicalJson(JSON.stringify(TreeAlpha.exportVerbose(view.root))),
	);
	const runs = views.map((view) => describeRuns(view.root));
	const { summary } = await (
		provider.trees[0] as unknown as { summarize(): Promise<{ summary: unknown }> }
	).summarize();
	return { ops, content, summary: JSON.stringify(summary), runs, textRunChunks };
}

/**
 * The text's runs as `runs()` reads them, and as reading atom by atom finds them, which must agree.
 */
function describeRuns(text: Text): string {
	const runs = [...text.runs()].map((run) => ({
		start: run.start,
		length: run.length,
		text: run.text,
		format: canonicalJson(JSON.stringify(TreeAlpha.exportVerbose(run.format))),
		atom: run.atom === undefined ? undefined : TreeAlpha.exportVerbose(run.atom),
	}));
	const atoms = text.charactersWithFormatting();
	let index = 0;
	for (const run of runs) {
		assert.equal(run.start, index, "runs are contiguous");
		const first = atoms[index];
		assert(first !== undefined);
		const firstFormat = canonicalJson(JSON.stringify(TreeAlpha.exportVerbose(first.format)));
		assert.equal(run.format, firstFormat, "a run's format is its first atom's");
		for (let i = index; i < index + run.length; i++) {
			const atom = atoms[i];
			assert(atom !== undefined);
			assert.equal(
				canonicalJson(JSON.stringify(TreeAlpha.exportVerbose(atom.format))),
				firstFormat,
				"a run's atoms share its format",
			);
		}
		const next = atoms[index + run.length];
		if (
			next !== undefined &&
			run.atom === undefined &&
			next.content instanceof LineBreak === false
		) {
			assert.notEqual(
				canonicalJson(JSON.stringify(TreeAlpha.exportVerbose(next.format))),
				firstFormat,
				"a run of characters is as long as possible",
			);
		}
		index += run.length;
	}
	assert.equal(index, text.characterCount(), "runs cover the text");
	assert.equal(runs.map((run) => run.text).join(""), text.fullString(), "runs spell the text");
	return JSON.stringify(runs);
}

function canonicalJson(text: string): string {
	return JSON.stringify(JSON.parse(text), (_key, value: unknown) =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			: value,
	);
}

/**
 * Runs `edit` with each forest, with the initial text built atom by atom and as runs, and checks that:
 * both clients converge; ops are identical with every forest and either way of building;
 * content and runs are the same with every forest and either way of building;
 * and summaries are identical for either way of building (with the same forest).
 * @returns The content of the first client with the reference forest.
 */
async function checkScenario(edit: (first: Text, second: Text) => void): Promise<string> {
	let reference: ScenarioResult | undefined;
	for (const [forestName, forest] of forests) {
		const atoms = await runScenario(forest, "atoms", edit);
		const runs = await runScenario(forest, "runs", edit);
		reference ??= atoms;
		for (const [name, result] of [
			["atoms", atoms],
			["runs", runs],
		] as const) {
			const label = `${forestName}, built as ${name}`;
			assert.equal(result.content[0], result.content[1], `${label}: clients converge`);
			assert.equal(result.runs[0], result.runs[1], `${label}: clients read the same runs`);
			assert.deepEqual(result.ops, reference.ops, `${label}: ops`);
			assert.deepEqual(result.content, reference.content, `${label}: content`);
			assert.deepEqual(result.runs, reference.runs, `${label}: runs`);
		}
		assert.equal(runs.summary, atoms.summary, `${forestName}: summary built as runs or atoms`);
		assert.equal(atoms.textRunChunks, 0, `${forestName}: no text runs when built as atoms`);
		if (forest !== ForestTypeReference) {
			assert(
				runs.textRunChunks > 0,
				`${forestName}: the forest keeps text built as runs as runs`,
			);
		}
	}
	assert(reference !== undefined);
	return reference.content[0] ?? "";
}

function formats(
	text: string,
): { char: string; bold?: boolean; italic?: boolean; size?: number }[] {
	interface VerboseNode {
		type: string;
		fields: Record<string, VerboseNode | string | boolean | number> | VerboseNode[];
	}
	const root = JSON.parse(text) as VerboseNode;
	const array = (root.fields as Record<string, VerboseNode>).content as VerboseNode;
	return (array.fields as VerboseNode[]).map((atom) => {
		const fields = atom.fields as Record<string, VerboseNode>;
		const content = fields.content;
		const format = fields.format?.fields as Record<string, boolean | number | undefined>;
		const char =
			content?.type === LineBreak.identifier
				? "\n"
				: ((content?.fields as Record<string, string>).content ?? "");
		return {
			char,
			bold: format.bold as boolean | undefined,
			italic: format.italic as boolean | undefined,
			size: format.size as number | undefined,
		};
	});
}

describe("FormattedText built as runs", () => {
	it("builds the same content as building atom by atom", async () => {
		const content = await checkScenario(() => {});
		assert.equal(
			formats(content)
				.map((atom) => atom.char)
				.join(""),
			"Hello world, hello shared text.\nBye.",
		);
	});

	it("overlapping bold and italic ranges merge per character and property", async () => {
		const content = await checkScenario((first, second) => {
			first.formatRange(0, 12, { bold: true });
			second.formatRange(6, 18, { italic: true });
		});
		for (const [index, atom] of formats(content).entries()) {
			assert.equal(atom.bold === true, index < 12, `bold at ${index}`);
			assert.equal(atom.italic === true, index >= 6 && index < 18, `italic at ${index}`);
		}
	});

	it("typing inside a run concurrent with formatting the run", async () => {
		const content = await checkScenario((first, second) => {
			first.insertAt(8, "XYZ", red());
			second.formatRange(4, 14, { bold: true });
		});
		const atoms = formats(content);
		assert.equal(
			atoms.map((atom) => atom.char).join(""),
			"Hello woXYZrld, hello shared text.\nBye.",
		);
		for (const [index, atom] of atoms.entries()) {
			const inserted = index >= 8 && index < 11;
			const formatted = index >= 4 && index < 17 && !inserted;
			assert.equal(atom.bold === true, formatted, `bold at ${index}`);
		}
	});

	it("format edits combined with text edits on both clients", async () => {
		await checkScenario((first, second) => {
			first.removeRange(2, 5);
			first.formatRange(0, 10, { size: 20, color: new Color({ r: 0, g: 0, b: 255 }) });
			second.insertAt(10, "abc", { ...plain, size: 14, font: "Calibri" });
			second.reformat(12, 16, { ...plain, size: 8, bold: true });
		});
	});

	it("removal concurrent with a format edit", async () => {
		const content = await checkScenario((first, second) => {
			first.removeRange(3, 9);
			second.formatRange(0, 15, { italic: true });
		});
		const atoms = formats(content);
		assert.equal(atoms.map((atom) => atom.char).join(""), "Helld, hello shared text.\nBye.");
		for (const [index, atom] of atoms.entries()) {
			assert.equal(atom.italic === true, index < 9, `italic at ${index}`);
		}
	});

	it("an edit in the middle of a run concurrent with reformatting the whole run", async () => {
		// "hello shared text." is the run [13, 31).
		const content = await checkScenario((first, second) => {
			first.insertAt(20, "XY", red());
			first.formatRange(16, 19, { bold: true });
			first.removeRange(25, 27);
			second.reformat(13, 31, { ...plain, size: 30, italic: true });
		});
		const atoms = formats(content);
		const text = atoms.map((atom) => atom.char).join("");
		const inserted = text.indexOf("XY");
		assert.equal(text.slice(inserted - 1, inserted + 3), "sXYh");
		for (const [index, atom] of atoms.entries()) {
			if (index === inserted || index === inserted + 1) {
				assert.equal(atom.size, 12, `inserted atom at ${index} keeps its format`);
			} else if (index >= 13 && atom.char !== "\n" && index < text.indexOf("\n")) {
				assert.equal(atom.size, 30, `reformatted at ${index}`);
				assert.equal(atom.italic, true, `italic at ${index}`);
			}
		}
	});

	it("reformatting part of a run splits it, on both clients", async () => {
		await checkScenario((first, second) => {
			first.reformat(15, 18, { ...plain, bold: true });
			second.formatRange(20, 24, { italic: true });
		});
	});
});

class Paragraphs extends sf.array("Paragraphs", Text) {}
const paragraphsConfig = new TreeViewConfiguration({ schema: Paragraphs });

/**
 * The initial text of {@link buildInitial} as plain content for insertVerbose, with its text runs as runs.
 */
function verboseInitial(): VerboseTree {
	const verbose = (node: TreeNode): VerboseTree =>
		TreeAlpha.exportVerbose(node, { keys: KeyEncodingOptions.allStoredKeys });
	return Text.verboseFromRuns([
		{ text: "Hello world, ", format: verbose(red()) },
		{ text: "hello shared text.", format: verbose(red()) },
		{ atoms: [verbose(new LineBreak({}))], format: verbose(new Format({ ...plain })) },
		{ text: "Bye." },
	]);
}

describe("FormattedText runs in plain content", () => {
	/**
	 * One client inserts the initial text into an empty list of paragraphs (as a node built atom by atom, or as plain
	 * content with runs), then the other edits it while the first one does, and both synchronize.
	 */
	async function run(
		forest: ForestType,
		insert: "atoms" | "verbose",
	): Promise<{ ops: string[]; content: string[]; summary: string; textRunChunks: number }> {
		const provider = new TestTreeProviderLite(
			2,
			configuredSharedTree({
				jsonValidator: FormatValidatorBasic,
				minVersionForCollab: FluidClientVersion.v2_80,
				forest,
			}).getFactory(),
		);
		const ops: string[] = [];
		const synchronize = (): void => {
			for (
				let message = provider.peekNextMessage();
				message !== undefined;
				message = provider.peekNextMessage()
			) {
				ops.push(JSON.stringify(message.contents));
				provider.synchronizeMessages({ count: 1 });
			}
		};
		const first = provider.trees[0].viewWith(paragraphsConfig);
		first.initialize(new Paragraphs([]));
		synchronize();
		if (insert === "atoms") {
			first.root.insertAt(0, buildInitial("atoms"));
		} else {
			TreeAlpha.insertVerbose(first.root, 0, [verboseInitial()]);
		}
		synchronize();
		const textRunChunks = countTextRunChunks(provider.trees[0]);
		const second = provider.trees[1].viewWith(paragraphsConfig);
		const [firstText] = first.root;
		const [secondText] = second.root;
		assert(firstText !== undefined && secondText !== undefined);
		firstText.insertAt(20, "XY", red());
		secondText.reformat(13, 31, { ...plain, size: 30, italic: true });
		synchronize();
		const content = [first, second].map((view) =>
			canonicalJson(JSON.stringify(TreeAlpha.exportVerbose(view.root))),
		);
		const { summary } = await (
			provider.trees[0] as unknown as { summarize(): Promise<{ summary: unknown }> }
		).summarize();
		return { ops, content, summary: JSON.stringify(summary), textRunChunks };
	}

	it("inserting plain content with runs matches inserting nodes built atom by atom", async () => {
		let reference: { ops: string[]; content: string[] } | undefined;
		for (const [forestName, forest] of forests) {
			const atoms = await run(forest, "atoms");
			const verbose = await run(forest, "verbose");
			reference ??= atoms;
			assert.equal(verbose.content[0], verbose.content[1], `${forestName}: clients converge`);
			assert.deepEqual(verbose.ops, reference.ops, `${forestName}: ops`);
			assert.deepEqual(atoms.ops, reference.ops, `${forestName}: ops built as atoms`);
			assert.deepEqual(verbose.content, reference.content, `${forestName}: content`);
			assert.equal(verbose.summary, atoms.summary, `${forestName}: summary`);
			if (forest !== ForestTypeReference) {
				assert(verbose.textRunChunks > 0, `${forestName}: plain content keeps its runs`);
			}
		}
	});
});

describe("FormattedText runs out of schema", () => {
	const verbose = (node: TreeNode): VerboseTree =>
		TreeAlpha.exportVerbose(node, { keys: KeyEncodingOptions.allStoredKeys });

	it("rejects plain content with a run whose format is out of schema", () => {
		const view = createIndependentTreeAlpha({ forest: ForestTypeOptimized }).viewWith(
			paragraphsConfig,
		);
		view.initialize(new Paragraphs([]));
		const badFormat = verbose(new Format({ ...plain })) as { fields: Record<string, unknown> };
		badFormat.fields.size = "large";
		const content = Text.verboseFromRuns([
			{ text: "Hello ", format: verbose(red()) },
			{ text: "world", format: badFormat as VerboseTree },
		]);
		assert.throws(
			() => TreeAlpha.insertVerbose(view.root, 0, [content]),
			validateUsageError(/schema/i),
		);
		assert.equal(view.root.length, 0);
	});

	describe("held as chunks", () => {
		const oldFactory = new SchemaFactoryAlpha("test.formattedTextRuns.outOfSchema");
		class OldFormat extends oldFactory.object("Format", {
			size: SchemaFactory.number,
			note: SchemaFactory.optional(SchemaFactory.string),
		}) {}
		class OldText extends FormattedText.createSchema(oldFactory, OldFormat, [], {
			size: 12,
		}) {}
		class OldTexts extends oldFactory.array("Texts", OldText) {}

		const newFactory = new SchemaFactoryAlpha("test.formattedTextRuns.outOfSchema");
		class NewFormat extends newFactory.objectAlpha(
			"Format",
			{ size: SchemaFactory.number },
			{ allowUnknownOptionalFields: true },
		) {}
		class NewText extends FormattedText.createSchema(newFactory, NewFormat, [], {
			size: 12,
		}) {}
		class NewTexts extends newFactory.array("Texts", NewText) {}

		/**
		 * A view with schema `NewTexts` of a tree whose stored schema is `OldTexts`, holding one text inserted as runs
		 * whose formats have a field `NewFormat` does not know.
		 */
		function viewOfOldTexts(content: readonly VerboseTree[]) {
			const tree = createIndependentTreeAlpha({ forest: ForestTypeOptimized });
			const oldView = tree.viewWith(new TreeViewConfiguration({ schema: OldTexts }));
			oldView.initialize(new OldTexts([]));
			TreeAlpha.insertVerbose(oldView.root, 0, content);
			oldView.dispose();
			const view = tree.viewWith(new TreeViewConfiguration({ schema: NewTexts }));
			assert.equal(view.compatibility.canView, true);
			return view;
		}

		const textWithNotes = (): VerboseTree =>
			OldText.verboseFromRuns([
				{ text: "noted ", format: verbose(new OldFormat({ size: 12, note: "a" })) },
				{ text: "text", format: verbose(new OldFormat({ size: 14, note: "b" })) },
			]);

		it("rejects copies of runs whose format is out of the destination's stored schema", () => {
			const source = viewOfOldTexts([textWithNotes()]);
			const text = source.root[0] ?? assert.fail();
			const destination = createIndependentTreeAlpha({ forest: ForestTypeOptimized }).viewWith(
				new TreeViewConfiguration({ schema: NewTexts }),
			);
			destination.initialize(new NewTexts([]));
			assert.throws(
				() => destination.root.insertAtEnd(TreeBeta.clone<typeof NewText>(text)),
				validateUsageError(/schema/i),
			);
			assert.throws(
				() => destination.root.insertAtEnd(TreeAlpha.copier(text)()),
				validateUsageError(/schema/i),
			);
			assert.equal(destination.root.length, 0);

			const accepting = viewOfOldTexts([]);
			accepting.root.insertAtEnd(TreeBeta.clone<typeof NewText>(text));
			accepting.root.insertAtEnd(TreeAlpha.copier(text)());
			assert.equal(accepting.root.length, 2);
		});
	});
});
