/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { FluidClientVersion } from "../../codec/index.js";
import { FormatValidatorBasic } from "../../external-utilities/index.js";
import {
	buildChunkedForest,
	defaultSchemaPolicy,
	makeTreeChunker,
	type TreeChunk,
} from "../../feature-libraries/index.js";
import { ForestTypeReference, TreeAlpha, type ForestType } from "../../shared-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules -- Building forest types for the test
import { toForestType } from "../../shared-tree/forestType.js";
import {
	SchemaFactory,
	SchemaFactoryBeta,
	TreeViewConfiguration,
} from "../../simple-tree/index.js";
import { FormattedText } from "../../text/index.js";
import { configuredSharedTree } from "../../treeFactory.js";
import { TestTreeProviderLite } from "../utils.js";

const sf = new SchemaFactoryBeta("test.formattedTextSharing");

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

const plain = { size: 12, font: "Arial", language: "en-US", kerning: 0, baseline: 0 } as const;

class Text extends FormattedText.createSchema(sf, Format, [], { ...plain }) {}

const red = (): Format =>
	new Format({ ...plain, color: new Color({ r: 255, g: 0, b: 0 }) });
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

interface ScenarioResult {
	readonly ops: readonly string[];
	readonly content: readonly string[];
	readonly summary: string;
	readonly repeatedReferences: number;
}

/**
 * Number of references in the forest of `tree` to chunks referenced from more than one place in it.
 */
function countRepeatedReferences(tree: unknown): number {
	const forest = (tree as { kernel: { checkout: { forest: { roots?: TreeChunk } } } }).kernel
		.checkout.forest;
	const seen = new Set<TreeChunk>();
	let repeated = 0;
	const visit = (chunk: TreeChunk): void => {
		if (seen.has(chunk)) {
			repeated++;
			return;
		}
		seen.add(chunk);
		const fields = (chunk as { fields?: Map<string, TreeChunk[]> }).fields;
		for (const children of fields?.values() ?? []) {
			children.forEach(visit);
		}
	};
	if (forest.roots !== undefined) {
		visit(forest.roots);
	}
	return repeated;
}

/**
 * Two clients load the same text, edit it concurrently with `edit`, and synchronize.
 * Returns every op sequenced (in order), each client's content, and a summary.
 */
async function runScenario(
	forest: ForestType,
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
	const initial = Text.fromString("Hello world, ", red());
	initial.insertAt(initial.characterCount(), "hello shared text.", red());
	first.initialize(initial);
	synchronize();
	const repeatedReferences = countRepeatedReferences(provider.trees[0]);
	const second = provider.trees[1].viewWith(config);
	edit(first.root, second.root);
	synchronize();
	const content = [first, second].map((view) =>
		JSON.stringify(TreeAlpha.exportVerbose(view.root)),
	);
	const { summary } = await (
		provider.trees[0] as unknown as { summarize(): Promise<{ summary: unknown }> }
	).summarize();
	return { ops, content, summary: JSON.stringify(summary), repeatedReferences };
}

/**
 * Runs `edit` with each forest and checks that both clients converge, that ops are identical with every forest,
 * that content is the same with every forest, that summaries are identical with and without sharing,
 * and that the sharing forest did share chunks.
 * @returns The results with each forest, in the order of `forests`.
 */
async function checkScenario(
	edit: (first: Text, second: Text) => void,
): Promise<readonly ScenarioResult[]> {
	const results: ScenarioResult[] = [];
	for (const [, forest] of forests) {
		results.push(await runScenario(forest, edit));
	}
	const [reference, separate, shared] = results;
	assert(reference !== undefined && separate !== undefined && shared !== undefined);
	// The order of an object's fields read from a chunked forest depends on how its content was chunked,
	// so compare content with sorted keys.
	const canonical = (result: ScenarioResult): string[] =>
		result.content.map((content) => canonicalJson(content));
	assert.equal(canonical(reference)[0], canonical(reference)[1], "clients converge");
	for (const result of [separate, shared]) {
		assert.deepEqual(result.ops, reference.ops, "ops");
		assert.deepEqual(canonical(result), canonical(reference), "content");
	}
	assert.deepEqual(canonical(shared), canonical(separate), "content with and without sharing");
	assert.equal(shared.summary, separate.summary, "summary with and without sharing");
	assert(
		shared.repeatedReferences > separate.repeatedReferences,
		`identical subtrees are shared: ${results.map((r) => r.repeatedReferences).join(",")}`,
	);
	return results;
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

function formats(text: string): { char: string; bold?: boolean; italic?: boolean }[] {
	interface VerboseNode {
		fields: Record<string, VerboseNode | string | boolean | number> | VerboseNode[];
	}
	const root = JSON.parse(text) as VerboseNode;
	const array = (root.fields as Record<string, VerboseNode>).content as VerboseNode;
	return (array.fields as VerboseNode[]).map((atom) => {
		const fields = atom.fields as Record<string, VerboseNode>;
		const content = fields.content?.fields as Record<string, string>;
		const format = fields.format?.fields as Record<string, boolean | undefined>;
		return { char: content.content ?? "", bold: format.bold, italic: format.italic };
	});
}

describe("FormattedText with shared format subtrees", () => {
	it("overlapping bold and italic ranges merge per character and property", async () => {
		const [reference] = await checkScenario((first, second) => {
			first.formatRange(0, 12, { bold: true });
			second.formatRange(6, 18, { italic: true });
		});
		const atoms = formats(reference?.content[0] ?? "");
		for (const [index, atom] of atoms.entries()) {
			assert.equal(atom.bold === true, index < 12, `bold at ${index}`);
			assert.equal(atom.italic === true, index >= 6 && index < 18, `italic at ${index}`);
		}
	});

	it("typing inside a run concurrent with formatting the run", async () => {
		const [reference] = await checkScenario((first, second) => {
			first.insertAt(8, "XYZ", red());
			second.formatRange(4, 14, { bold: true });
		});
		const atoms = formats(reference?.content[0] ?? "");
		assert.equal(atoms.map((atom) => atom.char).join(""), "Hello woXYZrld, hello shared text.");
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
		const [reference] = await checkScenario((first, second) => {
			first.removeRange(3, 9);
			second.formatRange(0, 15, { italic: true });
		});
		const atoms = formats(reference?.content[0] ?? "");
		assert.equal(atoms.map((atom) => atom.char).join(""), "Helld, hello shared text.");
		for (const [index, atom] of atoms.entries()) {
			assert.equal(atom.italic === true, index < 9, `italic at ${index}`);
		}
	});
});
