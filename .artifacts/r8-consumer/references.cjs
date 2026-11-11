const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");

async function main() {
	const [lane, forest] = process.argv.slice(2);
	assert(["ESM", "CJS"].includes(lane));
	assert(["Reference", "Optimized"].includes(forest));
	const api = lane === "ESM"
		? await import("@fluidframework/tree/alpha")
		: require("@fluidframework/tree/alpha");
	const sdk = lane === "ESM"
		? await import("fluid-framework/alpha")
		: require("fluid-framework/alpha");
	for (const name of ["Tree", "SchemaFactory", "getSharedTreeAuthority", "configuredSharedTreeAlpha"]) {
		assert.notEqual(api[name], undefined);
		assert.equal(api[name], sdk[name]);
	}
	const sourceRequire = createRequire(path.join(
		__dirname, "..", "r8-source", "packages", "dds", "tree", "package.json",
	));
	const {
		MockContainerRuntimeFactory, MockFluidDataStoreRuntime, MockStorage,
	} = sourceRequire("@fluidframework/test-runtime-utils/internal");
	const { createIdCompressor } = require("@fluidframework/id-compressor/internal");
	const kind = sdk.configuredSharedTreeAlpha({
		forest: api[`ForestType${forest}`],
		minVersionForCollab: "2.80.0",
		enableDetachedRootEditing: true,
		externalAuthority: {
			documentEpoch: `r7-refs-${lane}-${forest}`,
			authorityId: "authority", authorityEpoch: "epoch",
		},
	});
	assert.equal(typeof kind.getFactory, "function");
	const factory = kind.getFactory();
	assert.equal(factory.type,
		"https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2");
	const transport = new MockContainerRuntimeFactory();
	const trees = Array.from({ length: 3 }, (_, i) => {
		const runtime = new MockFluidDataStoreRuntime({
			clientId: `reference-${lane}-${forest}-${i}`,
			id: "test", idCompressor: createIdCompressor(),
		});
		const tree = factory.create(runtime, `tree-${i}`);
		transport.createContainerRuntime(runtime);
		tree.connect({
			deltaConnection: runtime.createDeltaConnection(),
			objectStorage: new MockStorage(),
		});
		return tree;
	});
	const { SchemaFactory, TreeViewConfiguration, Tree } = sdk;
	const sf = new SchemaFactory(`r7-references-${lane}-${forest}`);
	class Item extends sf.object("Item", { nativeId: sf.number, value: sf.number }) {}
	class Items extends sf.array("Items", Item) {}
	class Root extends sf.object("Root", {
		items: Items, slot: sf.optional(Item), value: sf.number, other: sf.number,
	}) {}
	const config = new TreeViewConfiguration({ schema: Root });
	const views = trees.map((tree) => tree.viewWith(config));
	views[0].initialize({
		items: Array.from({ length: 3 }, () => ({ nativeId: 7, value: 0 })),
		value: 0, other: 0,
	});
	transport.processAllMessages();
	const controllers = trees.map(sdk.getSharedTreeAuthority);
	const authority = controllers[0];
	const initial = authority.capture();
	const bootstrap = authority.publishAdvance({
		batchId: "bootstrap", nextCheckpoint: "ready",
		capture: initial, approvePrefix: initial.editIds.length,
	});
	transport.processAllMessages();
	assert.equal(await bootstrap, "applied");
	initial.dispose();
	const first = views[0].root.items[0];
	const second = views[0].root.items[1];
	assert.equal(Tree.shortId(first), undefined);

	views[1].root.items.insertAtEnd({ nativeId: 7, value: 2 });
	transport.processAllMessages();
	// The third approved node has never been hydrated on client 0.
	views[2].root.items.removeAt(2);
	transport.processAllMessages();
	views[1].root.other = 7;
	transport.processAllMessages();
	const born = views[0].root.items[2];
	const cut = authority.capture({ trackNodeReferences: true });
	assert.equal(cut.editIds.length, 3);
	const tracked = (node) => {
		const result = cut.reference(node);
		assert.equal(result.kind, "tracked");
		return result.reference;
	};
	const node = (ref, target, status = "inDocument") => {
		const result = cut.resolve(ref, target);
		assert.equal(result.kind, "node");
		assert.equal(result.status, status);
		assert(Tree.is(result.node, Item));
		return result.node;
	};
	const firstRef = tracked(first);
	const secondRef = tracked(second);
	const bornRef = tracked(born);
	assert.notEqual(firstRef, secondRef, "Identical JSON/native IDs are distinct identities");
	const approved = authority.createDraft(cut);
	const a = approved.viewWith(config);
	assert.notEqual(a.root.items[0], first, "Fork wrappers remain context-specific");
	assert.equal(node(firstRef, approved), a.root.items[0]);
	assert.equal(tracked(a.root.items[0]), firstRef);
	assert.deepEqual(cut.resolve(bornRef, approved), { kind: "absent" });
	const removedRef = tracked(a.root.items[2]);
	const removedLive = node(removedRef, "live", "removed");
	const prefix = authority.createDraft(cut, { afterPrefix: 2 });
	const b = prefix.viewWith(config);
	assert.equal(tracked(b.root.items[2]), bornRef);
	assert.equal(node(bornRef, prefix), b.root.items[2]);
	const removed = node(removedRef, prefix, "removed");
	removed.value = 12;
	b.root.slot = removed;
	b.root.items[0].value = 5;
	b.root.value = 42;
	b.root.other = 8;
	assert.throws(() => { b.root.slot = removedLive; }, /checkout|branch|removed/i);

	a.root.items.insertAtEnd({ nativeId: 7, value: 2 });
	assert.deepEqual(cut.reference(a.root.items[3]), { kind: "outsideCapture" });
	assert.deepEqual(cut.resolve(bornRef, approved), { kind: "absent" });
	assert.deepEqual(cut.reference(new Item({ nativeId: 7, value: 0 })), { kind: "outsideCapture" });
	const foreign = controllers[1].capture({ trackNodeReferences: true });
	assert.throws(() => cut.reference(views[1].root.items[0]), /another capture|checkout/);
	const foreignRef = foreign.reference(views[1].root.items[0]);
	assert.equal(foreignRef.kind, "tracked");
	assert.throws(() => cut.resolve(foreignRef.reference, "live"), /exact capture/);
	assert.throws(() => cut.resolve({ scope: "capture-local" }, "live"), /exact capture/);
	foreign.dispose();

	views[1].root.other = 9;
	transport.processAllMessages();
	const later = authority.capture();
	const receipt = authority.publishAdvance({
		batchId: "correct", nextCheckpoint: "corrected",
		capture: cut, approvePrefix: 2, draft: prefix,
	});
	assert.throws(() => cut.resolve(firstRef, prefix), /active unpublished/);
	assert.throws(() => cut.reference(removed), /owned by this reference capture/);
	const before = authority.capture();
	assert.equal(before.checkpoint, "ready");
	before.dispose();
	const authorityMessages = transport.outstandingMessageCount;
	assert(authorityMessages > 0);
	first.value = 11;
	views[0].root.items.insertAtEnd({ nativeId: 7, value: 99 });
	const lateBorn = views[0].root.items[3];
	assert.deepEqual(cut.reference(lateBorn), { kind: "outsideCapture" });
	views[2].root.items[2].value = 23;
	transport.processSomeMessages(authorityMessages);
	assert.equal(await receipt, "applied");
	assert.equal(node(firstRef, "live"), first);
	assert.equal(first.value, 11, "Local unsequenced write survives correction");
	assert.equal(views[1].root.items[0].value, 5, "That L is not yet on the peer");
	assert.equal(views[2].root.items[2].value, 23);
	assert.equal(node(removedRef, "live"), removedLive);
	assert.equal(views[0].root.slot, removedLive);
	assert.equal(removedLive.value, 12);
	const after = authority.capture();
	assert.deepEqual(after.editIds, later.editIds.slice(2));
	assert.equal(views[0].root.other, 9);
	after.dispose();
	later.dispose();
	transport.processAllMessages();
	assert.deepEqual(cut.reference(lateBorn), { kind: "outsideCapture" });
	assert.equal(node(bornRef, "live"), born);
	assert.equal(born.value, 23);

	views[0].root.slot = undefined;
	removedLive.value = 13;
	views[0].root.items.insertAtEnd(removedLive);
	assert.equal(node(removedRef, "live"), removedLive);
	transport.processAllMessages();
	for (const view of views) {
		assert.equal(view.root.items.at(-1).value, 13);
		assert.equal(view.root.slot, undefined);
	}
	views[0].root.items.removeAt(views[0].root.items.length - 1);
	views[0].root.items.insertAtEnd({ nativeId: 7, value: 13 });
	assert.equal(node(removedRef, "live", "removed"), removedLive);
	assert.notEqual(node(removedRef, "live", "removed"), views[0].root.items.at(-1));
	assert.deepEqual(cut.reference(views[0].root.items.at(-1)), { kind: "outsideCapture" });
	transport.processAllMessages();

	assert.throws(() => authority.capture({ trackNodeReferences: true, maxNodes: 1 }), /limit/);
	const limited = authority.capture({ trackNodeReferences: true, maxDrafts: 1 });
	const only = authority.createDraft(limited);
	only.viewWith(config);
	assert.throws(() => authority.createDraft(limited), /draft limit/);
	only.dispose();
	const replacement = authority.createDraft(limited);
	replacement.viewWith(config);
	limited.dispose();
	assert.throws(() => replacement.viewWith(config), /disposed/);
	replacement.dispose();
	let callbacks = 0;
	const off = Tree.on(first, "nodeChanged", () => {
		callbacks++;
		assert.throws(() => cut.resolve(firstRef, "live"), /forbidden|change event/i);
		assert.throws(() => cut.dispose(), /forbidden|change event/i);
	});
	first.value = 17;
	off();
	assert.equal(callbacks, 1);
	assert.equal(node(firstRef, "live"), first);
	transport.processAllMessages();
	cut.dispose();
	assert.throws(() => cut.resolve(firstRef, "live"), /disposed/);
	assert.throws(() => approved.viewWith(config), /disposed/);
	approved.dispose();
	prefix.dispose();
	assert.equal("reference" in initial, false);

	const sourceTreeLoads = Object.keys(require.cache).filter((file) =>
		file.includes(`${path.sep}r8-source${path.sep}packages${path.sep}dds${path.sep}tree${path.sep}`)
		&& file.endsWith(".js"));
	assert.deepEqual(sourceTreeLoads, []);
	const packageRoot = path.join(__dirname, "node_modules", "@fluidframework", "tree");
	const moduleDir = lane === "CJS" ? "dist" : "lib";
	const files = [
		"entrypoints\\alpha.js", "shared-tree\\authorityNodeReferences.js",
		"shared-tree\\externalAuthorityController.js", "shared-tree\\treeCheckout.js",
		"core\\tree\\anchorSet.js", "treeFactory.js",
	];
	const hashes = Object.fromEntries(files.map((file) => {
		const absolute = path.resolve(packageRoot, moduleDir, file);
		return [absolute, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")];
	}));
	console.log(JSON.stringify({
		lane, forest, clients: 3, success: true,
		transport: "Generic local mock ordering, not AFR or OCS",
		wireProtocol: 2, ddsType: factory.type,
		wrapperIdentity: true, sourceWorktreeTreeLoaded: false,
		proofs: [
			"A/prefix/live counterparts", "identical-content discrimination",
			"unhydrated removed-root metadata", "P births absent before creation",
			"late/draft/L births outside capture", "atomic correction with later P and genuine L",
			"same-node detach/edit/reattach", "replacement cannot retarget",
			"capture/view/target/forgery ownership", "limits/disposal/reentrancy",
		],
		hashes, nodeVersion: process.version,
	}, null, 2));
}

let completed = false;
process.once("beforeExit", () => {
	if (!completed) {
		console.error("Reference proof exited before its receipt completed");
		process.exitCode = 1;
	}
});
main().then(
	() => { completed = true; },
	(error) => { completed = true; console.error(error); process.exitCode = 1; },
);
