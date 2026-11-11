const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");

async function main() {
	const lane = process.argv[2];
	const forest = process.argv[3];
	assert(["CJS", "ESM"].includes(lane));
	assert(["Reference", "Optimized"].includes(forest));
	const direct = lane === "CJS"
		? require("@fluidframework/tree/alpha")
		: await import("@fluidframework/tree/alpha");
	const wrapper = lane === "CJS"
		? require("fluid-framework/alpha")
		: await import("fluid-framework/alpha");
	for (const name of [
		"Tree", "SchemaFactory", "configuredSharedTreeAlpha",
		"getSharedTreeAuthority", "TextAsTree",
	]) {
		assert.notEqual(direct[name], undefined, name);
		assert.equal(direct[name], wrapper[name], `${name}: single packed Tree identity`);
	}
	const { SchemaFactory, TreeViewConfiguration, Tree, TreeStatus } = wrapper;
	const base = path.dirname(__dirname);
	const sourceRequire = createRequire(path.join(
		base, "r7-source", "packages", "dds", "tree", "package.json",
	));
	// Generic transport mocks only: never import a source-worktree Tree or Tree test helper.
	const {
		MockContainerRuntimeFactory, MockFluidDataStoreRuntime, MockStorage,
	} = sourceRequire("@fluidframework/test-runtime-utils/internal");
	const { createIdCompressor } = require("@fluidframework/id-compressor/internal");
	const kind = wrapper.configuredSharedTreeAlpha({
		forest: direct[`ForestType${forest}`],
		minVersionForCollab: "2.80.0",
		enableDetachedRootEditing: true,
		externalAuthority: {
			documentEpoch: `r7-packed-${lane}-${forest}`,
			authorityId: "trusted-normalizer",
			authorityEpoch: "epoch",
		},
	});
	assert.equal(typeof kind.getFactory, "function", "Guard the opaque public factory kind");
	const factory = kind.getFactory();
	assert.equal(
		factory.type,
		"https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2",
	);
	const transport = new MockContainerRuntimeFactory();
	const trees = Array.from({ length: 3 }, (_, i) => {
		const runtime = new MockFluidDataStoreRuntime({
			clientId: `packed-${lane}-${i}`,
			id: "test",
			idCompressor: createIdCompressor(),
		});
		const tree = factory.create(runtime, `tree-${i}`);
		transport.createContainerRuntime(runtime);
		tree.connect({
			deltaConnection: runtime.createDeltaConnection(),
			objectStorage: new MockStorage(),
		});
		return tree;
	});
	const sf = new SchemaFactory(`r7-packed-${lane}-${forest}`);
	class Item extends sf.object("Item", { value: sf.number }) {}
	class Items extends sf.array("Items", Item) {}
	class Root extends sf.object("Root", {
		value: sf.number, other: sf.number, items: Items, slot: sf.optional(Item),
	}) {}
	const configuration = new TreeViewConfiguration({ schema: Root });
	const views = trees.map((tree) => tree.viewWith(configuration));
	views[0].initialize({ value: 0, other: 0, items: [{ value: 0 }] });
	transport.processAllMessages();
	const controllers = trees.map(wrapper.getSharedTreeAuthority);
	const controller = controllers[0];
	const initial = controller.capture();
	const bootstrap = controller.publishAdvance({
		batchId: "bootstrap", nextCheckpoint: "ready",
		capture: initial, approvePrefix: initial.editIds.length,
	});
	transport.processAllMessages();
	assert.equal(await bootstrap, "applied");
	initial.dispose();
	const originals = views.map((view) => view.root.items[0]);

	views[0].root.value = 1;
	transport.processAllMessages();
	views[0].root.items.removeAt(0);
	transport.processAllMessages();
	views[1].root.other = 7;
	transport.processAllMessages();
	const cut = controller.capture();
	assert.equal(cut.editIds.length, 3);
	const draft = controller.createDraft(cut, { afterPrefix: 2 });
	const correction = draft.viewWith(configuration);
	assert.deepEqual([correction.root.value, correction.root.other], [1, 0]);
	assert.equal(correction.root.items.length, 0);
	correction.root.value = 2;
	correction.root.other = 8;
	const observed = [];
	const off = controllers[2].onStateChanged(() => {
		observed.push([views[2].root.value, views[2].root.other]);
	});
	const receipt = controller.publishAdvance({
		batchId: "normalize-prefix", nextCheckpoint: "normalized",
		capture: cut, approvePrefix: 2, draft,
	});
	const before = controller.capture();
	assert.equal(before.checkpoint, "ready", "No private early-apply path");
	before.dispose();
	// The runtime may queue an ID-allocation message before the authority operation.
	const authorityMessageCount = transport.outstandingMessageCount;
	assert(authorityMessageCount > 0);
	originals[1].value = 11;
	views[1].root.slot = originals[1];
	transport.processSomeMessages(authorityMessageCount);
	assert.equal(await receipt, "applied");
	assert.deepEqual(observed, [[2, 7]], "One coherent corrected A plus later P");
	off();
	const after = controller.capture();
	assert.deepEqual(after.editIds, cut.editIds.slice(2));
	const approved = controller.createDraft(after);
	const approvedView = approved.viewWith(configuration);
	assert.deepEqual([approvedView.root.value, approvedView.root.other], [2, 8]);
	assert.equal(approvedView.root.items.length, 0);
	assert.equal(approvedView.root.slot, undefined);
	assert.equal(views[1].root.slot, originals[1], "Local unsequenced attachment survives");
	assert.equal(originals[1].value, 11);
	assert.equal(Tree.status(originals[0]), TreeStatus.Removed);
	approved.dispose();
	after.dispose();
	draft.dispose();
	cut.dispose();
	transport.processAllMessages();
	for (const [i, view] of views.entries()) {
		assert.equal(view.root.slot, originals[i]);
		assert.equal(originals[i].value, 11);
		assert.deepEqual([view.root.value, view.root.other], [2, 7]);
	}

	const finalCut = controller.capture();
	assert.equal(finalCut.editIds.length, 3, "Later P and acknowledged L remain obligations");
	const finalDraft = controller.createDraft(finalCut, {
		afterPrefix: finalCut.editIds.length,
	});
	const finalView = finalDraft.viewWith(configuration);
	const detached = finalView.root.slot;
	assert(detached !== undefined);
	finalView.root.slot = undefined;
	detached.value = 12;
	finalView.root.items.insertAtEnd(detached);
	const finalReceipt = controller.publishAdvance({
		batchId: "normalize-detached", nextCheckpoint: "final",
		capture: finalCut, approvePrefix: finalCut.editIds.length, draft: finalDraft,
	});
	transport.processAllMessages();
	assert.equal(await finalReceipt, "applied");
	for (const [i, view] of views.entries()) {
		assert.equal(view.root.items[0], originals[i]);
		assert.equal(view.root.slot, undefined);
		assert.equal(originals[i].value, 12);
		assert.equal(Tree.status(originals[i]), TreeStatus.InDocument);
		const state = controllers[i].capture();
		assert.equal(state.checkpoint, "final");
		assert.equal(state.editIds.length, 0);
		assert.deepEqual(state.exportApproved(), state.exportSequenced());
		state.dispose();
	}
	finalDraft.dispose();
	finalCut.dispose();
	const sourceTreeLoads = Object.keys(require.cache).filter((file) =>
		file.includes(`${path.sep}r7-source${path.sep}packages${path.sep}dds${path.sep}tree${path.sep}`)
		&& file.endsWith(".js"));
	assert.deepEqual(sourceTreeLoads, [], "Generic mocks must not import an unbundled source Tree");
	const packageRoot = path.join(__dirname, "node_modules", "@fluidframework", "tree");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
	const entry = path.resolve(
		packageRoot,
		manifest.exports["./alpha"][lane === "CJS" ? "require" : "import"].default,
	);
	if (lane === "CJS") {
		assert.equal(require.resolve("@fluidframework/tree/alpha"), entry);
	}
	const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	console.log(JSON.stringify({
		lane,
		forest,
		proof: "Packed modules with generic local mock ordering; not AFR or OCS",
		clients: 3,
		wrapperIdentity: true,
		sourceWorktreeTreeLoaded: false,
		scenario: "Prefix correction + later P/local L + removed-root retention + correction detach/edit/reattach",
		checkpoint: "final",
		finalPending: 0,
		perClientOriginalIdentity: true,
		ddsType: factory.type,
		treeEntry: entry,
		treeEntrySha256: digest(entry),
		tarballSha256: digest(path.join(base, "r7-m4", "fluidframework-tree-2.111.0.tgz")),
		nodeVersion: process.version,
	}, null, 2));
}

let completed = false;
process.once("beforeExit", () => {
	if (!completed) {
		console.error("Packed proof exited with an unresolved receipt; this is not a pass");
		process.exitCode = 1;
	}
});
main().then(
	() => { completed = true; },
	(error) => {
		completed = true;
		console.error(error);
		process.exitCode = 1;
	},
);
