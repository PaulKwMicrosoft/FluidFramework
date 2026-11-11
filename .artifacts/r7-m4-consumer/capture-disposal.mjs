import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const lane = process.env.ADVERSARIAL_FORMAT ?? "CJS";
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
const archive = path.join(import.meta.dirname, "..", "r7-m4", "fluidframework-tree-2.111.0.tgz");
assert.equal(sha(archive), "EA7CFC5BB102887160482896309F9BD89A0A435040BBDCD26D937AE4C99FFE55");
const require = createRequire(import.meta.url);
const api = lane === "ESM" ? await import("@fluidframework/tree/alpha") : require("@fluidframework/tree/alpha");
const sourceRequire = createRequire(path.join(import.meta.dirname, "..", "r7-source",
	"packages", "dds", "tree", "package.json"));
const { MockContainerRuntimeFactory, MockFluidDataStoreRuntime, MockStorage } =
	sourceRequire("@fluidframework/test-runtime-utils/internal");
const { createIdCompressor } = require("@fluidframework/id-compressor/internal");
const results = [];

function setup(forest) {
	const kind = api.configuredSharedTreeAlpha({
		forest: api[`ForestType${forest}`], minVersionForCollab: "2.80.0",
		enableDetachedRootEditing: true,
		externalAuthority: { documentEpoch: "m4-disposal", authorityId: "a", authorityEpoch: "e" },
	});
	const runtime = new MockFluidDataStoreRuntime({ id: "test", idCompressor: createIdCompressor() });
	const transport = new MockContainerRuntimeFactory();
	const tree = kind.getFactory().create(runtime, "tree");
	transport.createContainerRuntime(runtime);
	tree.connect({ deltaConnection: runtime.createDeltaConnection(), objectStorage: new MockStorage() });
	const sf = new api.SchemaFactory(`m4-disposal-${lane}-${forest}`);
	class Root extends sf.object("Root", { value: sf.number }) {}
	const config = new api.TreeViewConfiguration({ schema: Root });
	const live = api.asTreeViewAlpha(tree.viewWith(config));
	live.initialize({ value: 0 });
	transport.processAllMessages();
	const authority = api.getSharedTreeAuthority(tree);
	const capture = authority.capture({ trackNodeReferences: true });
	const draft = authority.createDraft(capture, { afterPrefix: capture.editIds.length });
	const view = api.asTreeViewAlpha(draft.viewWith(config));
	return { live, authority, capture, draft, view };
}

function add(forest, name, run) {
	test(`${forest}: ${name}`, { timeout: 10000 }, () => {
		const record = { forest, name, status: "running" }; results.push(record);
		try { run(setup(forest)); record.status = "passed"; }
		catch (error) { record.status = "failed"; record.error = error.message; throw error; }
	});
}

for (const forest of ["Reference", "Optimized"]) {
	add(forest, "reentrant capture disposal from a public revertible disposal callback", f => {
		const root = f.live.root;
		let calls = 0;
		const off = f.view.events.on("changed", ({ getRevertible }) => {
			assert(getRevertible);
			getRevertible(() => { calls++; f.capture.dispose(); });
		});
		f.view.root.value = 1;
		off();
		assert.doesNotThrow(() => f.capture.dispose());
		assert.equal(calls, 1);
		f.capture.dispose();
		assert.equal(calls, 1);
		assert.throws(() => f.capture.exportSequenced(), /disposed/);
		assert.equal(f.live.root, root);
		assert.equal(root.value, 0);
		f.authority.capture().dispose();
		f.draft.dispose();
	});
	add(forest, "transaction preflight does not expire the capture", f => {
		const before = f.capture.exportSequenced();
		for (const root of [f.live.root, f.view.root]) {
			const branch = api.TreeAlpha.context(root);
			assert(branch.isBranch());
			branch.runTransaction(() => {
				assert.throws(() => f.capture.dispose(), /completed transaction/);
				return { rollback: true };
			});
			assert.deepEqual(f.capture.exportSequenced(), before);
			assert.equal(f.capture.reference(f.live.root).kind, "tracked");
		}
		f.capture.dispose();
		f.draft.dispose();
	});
	add(forest, "change-event preflight does not expire the capture", f => {
		const before = f.capture.exportSequenced();
		let rejected = 0;
		for (const root of [f.live.root, f.view.root]) {
			const off = api.Tree.on(root, "nodeChanged", () => {
				assert.throws(() => f.capture.dispose(), /forbidden|change event/i);
				rejected++;
			});
			root.value = 2;
			off();
			assert.deepEqual(f.capture.exportSequenced(), before);
			assert.equal(f.capture.reference(f.live.root).kind, "tracked");
		}
		assert.equal(rejected, 2);
		f.capture.dispose();
		f.draft.dispose();
	});
	add(forest, "real disposal callback errors propagate after the capture expires", f => {
		const failure = new Error("Disposal observer failure");
		let calls = 0;
		const off = f.view.events.on("changed", ({ getRevertible }) => {
			assert(getRevertible);
			getRevertible(() => { calls++; f.capture.dispose(); throw failure; });
		});
		f.view.root.value = 1; off();
		assert.throws(() => f.capture.dispose(), error => error === failure);
		assert.equal(calls, 1);
		assert.throws(() => f.capture.exportApproved(), /disposed/);
		assert.doesNotThrow(() => f.capture.dispose());
		assert.equal(f.live.root.value, 0);
		f.draft.dispose();
	});
}

after(() => {
	const sourceTreeLoads = Object.keys(require.cache).filter(file =>
		file.includes(`${path.sep}r7-source${path.sep}packages${path.sep}dds${path.sep}tree${path.sep}`));
	assert.deepEqual(sourceTreeLoads, []);
	const packageRoot = path.join(import.meta.dirname, "node_modules", "@fluidframework", "tree");
	const format = lane === "ESM" ? "lib" : "dist";
	const hashes = Object.fromEntries([
		"entrypoints\\alpha.js", "shared-tree\\authorityNodeReferences.js",
		"shared-tree\\externalAuthorityController.js", "shared-tree\\treeCheckout.js",
	].map(file => {
		const full = path.join(packageRoot, format, file);
		return [full, sha(full)];
	}));
	writeFileSync(path.join(import.meta.dirname, "artifacts", `capture-disposal-${lane}.json`),
		JSON.stringify({
			lane, scope: "Actual packed public API, both forests; local mock ordering only",
			archiveSha256: sha(archive), hashes, sourceTreeLoads,
			results, passed: results.filter(r => r.status === "passed").length,
			failed: results.filter(r => r.status === "failed").length,
		}, null, 2));
});
