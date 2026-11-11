import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const lane = process.env.ADVERSARIAL_FORMAT ?? "CJS";
const require = createRequire(import.meta.url);
const sourceRequire = createRequire(path.join(import.meta.dirname, "..", "r7-source",
	"packages", "dds", "tree", "package.json"));
const api = lane === "ESM" ? await import("@fluidframework/tree/alpha") : require("@fluidframework/tree/alpha");
const sdk = lane === "ESM" ? await import("fluid-framework/alpha") : require("fluid-framework/alpha");
for (const key of ["Tree", "SchemaFactory", "getSharedTreeAuthority", "configuredSharedTreeAlpha"]) {
	assert.equal(api[key], sdk[key]);
}
const { MockContainerRuntimeFactory, MockFluidDataStoreRuntime, MockStorage } =
	sourceRequire("@fluidframework/test-runtime-utils/internal");
const { createIdCompressor } = require("@fluidframework/id-compressor/internal");
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
const archive = path.join(import.meta.dirname, "..", "r7-m4", "fluidframework-tree-2.111.0.tgz");
assert.equal(sha(archive), "EA7CFC5BB102887160482896309F9BD89A0A435040BBDCD26D937AE4C99FFE55");
const sf = new api.SchemaFactory(`r7-public-retry-${lane}`);
class Item extends sf.object("Item", { value: sf.number }) {}
class Items extends sf.array("Items", Item) {}
class Root extends sf.object("Root", {
	value: sf.number, other: sf.number, items: Items, slot: sf.optional(Item),
}) {}
const config = new api.TreeViewConfiguration({ schema: Root });
const results = [];

async function setup(t, correction) {
	const kind = api.configuredSharedTreeAlpha({
		minVersionForCollab: "2.80.0", enableDetachedRootEditing: true,
		externalAuthority: { documentEpoch: "r7-public", authorityId: "a", authorityEpoch: "e" },
	});
	assert.equal(typeof kind.getFactory, "function");
	const factory = kind.getFactory();
	assert.equal(factory.type, "https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2");
	const transport = new MockContainerRuntimeFactory();
	const trees = [], runtimes = [], sends = [];
	for (let i = 0; i < 3; i++) {
		const runtime = new MockFluidDataStoreRuntime({
			clientId: `r7-${lane}-${i}`, id: "test", idCompressor: createIdCompressor(),
		});
		const tree = factory.create(runtime, `tree-${i}`);
		const cr = transport.createContainerRuntime(runtime);
		const submit = cr.submit.bind(cr);
		cr.submit = (content, metadata) => {
			if (content.kind === "advance") sends.push({ client: i, batchId: content.content.batchId });
			return submit(content, metadata);
		};
		tree.connect({ deltaConnection: runtime.createDeltaConnection(), objectStorage: new MockStorage() });
		trees.push(tree); runtimes.push(cr);
	}
	const views = trees.map(tree => tree.viewWith(config));
	views[0].initialize({ value: 0, other: 0, items: [{ value: 0 }] });
	transport.processAllMessages();
	const controllers = trees.map(api.getSharedTreeAuthority), authority = controllers[0];
	const init = authority.capture();
	const boot = authority.publishAdvance({
		batchId: "boot", nextCheckpoint: "ready", capture: init, approvePrefix: init.editIds.length,
	});
	transport.processAllMessages(); assert.equal(await boot, "applied"); init.dispose();
	views[0].root.value = 1;
	transport.processAllMessages();
	const cut = authority.capture({ trackNodeReferences: true });
	const resources = [cut];
	const draft = correction ? authority.createDraft(cut, { afterPrefix: 1 }) : undefined;
	if (draft) { resources.push(draft); draft.viewWith(config).root.value = 2; }
	const publication = { batchId: "retry", nextCheckpoint: "approved", capture: cut, approvePrefix: 1, draft };
	t.after(() => { for (const resource of resources.reverse()) resource.dispose(); });
	return { transport, trees, runtimes, views, controllers, authority, cut, draft, publication, sends, resources };
}

function add(name, run) {
	test(name, { timeout: 10000 }, async t => {
		const record = { name, status: "running" };
		results.push(record);
		try { await run(t); record.status = "passed"; }
		catch (error) { record.status = "failed"; record.error = error.message; throw error; }
	});
}

for (const correction of [false, true]) {
	const kind = correction ? "correction" : "prefix";
	add(`${kind}: positive F1/F2 contract, one send and duplicate before callbacks`, async t => {
		const f = await setup(t, correction);
		const facade = api.getSharedTreeAuthority(new Proxy(f.trees[0], {}));
		assert.equal(facade, f.authority);
		const first = f.authority.publishAdvance(f.publication);
		const second = facade.publishAdvance({ ...f.publication });
		assert.equal(f.sends.filter(s => s.batchId === "retry").length, 1);
		const before = f.authority.capture(); assert.equal(before.checkpoint, "ready"); before.dispose();
		f.transport.processAllMessages();
		const afterEcho = f.authority.publishAdvance(f.publication);
		assert.deepEqual(await Promise.all([first, second, afterEcho]), ["applied", "applied", "duplicate"]);
		assert.equal(await f.authority.publishAdvance(f.publication), "duplicate");
		assert.equal(f.sends.filter(s => s.batchId === "retry").length, 1);
		assert.equal(f.views[0].root.value, correction ? 2 : 1);
	});
	add(`${kind}: changed inputs reject and original receipt stays usable`, async t => {
		const f = await setup(t, correction);
		const otherCut = f.authority.capture();
		const otherDraft = f.authority.createDraft(f.cut, { afterPrefix: 1 });
		otherDraft.viewWith(config).root.value = 2;
		f.resources.push(otherCut, otherDraft);
		const mutable = { ...f.publication };
		const first = f.authority.publishAdvance(mutable);
		mutable.nextCheckpoint = "changed";
		for (const changed of [
			mutable, { ...f.publication, capture: otherCut },
			{ ...f.publication, approvePrefix: 0 }, { ...f.publication, draft: otherDraft },
		]) {
			await assert.rejects(f.authority.publishAdvance(changed), /different publication inputs/);
			f.authority.capture().dispose();
		}
		f.transport.processAllMessages();
		assert.equal(await first, "applied");
		assert.equal(await f.authority.publishAdvance(f.publication), "duplicate");
		assert.equal(f.sends.filter(s => s.batchId === "retry").length, 1);
	});
	add(`${kind}: competing batch becomes stale and every retry remains stale`, async t => {
		const f = await setup(t, correction);
		const peerCut = f.controllers[1].capture(); f.resources.push(peerCut);
		const winner = f.controllers[1].publishAdvance({
			batchId: "winner", nextCheckpoint: "winner", capture: peerCut, approvePrefix: 1,
		});
		const first = f.authority.publishAdvance(f.publication);
		const second = f.authority.publishAdvance(f.publication);
		f.transport.processAllMessages();
		assert.equal(await winner, "applied");
		assert.deepEqual(await Promise.all([first, second]), ["stale", "stale"]);
		assert.equal(await f.authority.publishAdvance(f.publication), "stale");
		assert.equal(f.views[0].root.value, 1);
	});
	add(`${kind}: later P and actual unsequenced L survive one approval`, async t => {
		const f = await setup(t, correction);
		f.views[1].root.other = 7; f.transport.processAllMessages();
		const later = f.authority.capture(); f.resources.push(later);
		const first = f.authority.publishAdvance(f.publication);
		const pendingMessageCount = f.transport.outstandingMessageCount;
		const original = f.views[2].root.items[0];
		f.views[2].root.items.removeAt(0); original.value = 11; f.views[2].root.slot = original;
		const second = f.authority.publishAdvance(f.publication);
		f.transport.processSomeMessages(pendingMessageCount);
		assert.deepEqual(await Promise.all([first, second]), ["applied", "applied"]);
		assert.equal(f.views[0].root.slot, undefined);
		assert.equal(f.views[2].root.slot, original);
		const after = f.authority.capture(); f.resources.push(after);
		assert.deepEqual(after.editIds, later.editIds.slice(1));
		f.transport.processAllMessages();
		assert.equal(await f.authority.publishAdvance(f.publication), "duplicate");
		assert(f.views.every(v => v.root.slot.value === 11 && v.root.other === 7));
	});
	add(`${kind}: disposed capture expires retry without canceling the original send`, async t => {
		const f = await setup(t, correction);
		const first = f.authority.publishAdvance(f.publication);
		f.cut.dispose();
		await assert.rejects(f.authority.publishAdvance(f.publication), /live capture/);
		f.transport.processAllMessages(); assert.equal(await first, "applied");
		const fresh = f.authority.capture(); f.resources.push(fresh);
		await assert.rejects(f.authority.publishAdvance({
			capture: fresh, batchId: "retry", nextCheckpoint: "different",
		}), /already reserved/);
	});
}

add("empty correction still has an owned identity and retries idempotently", async t => {
	const f = await setup(t, false);
	const draft = f.authority.createDraft(f.cut, { afterPrefix: 1 }); f.resources.push(draft);
	draft.viewWith(config);
	const publication = { ...f.publication, draft };
	const first = f.authority.publishAdvance(publication);
	const second = f.authority.publishAdvance(publication);
	f.transport.processAllMessages();
	assert.deepEqual(await Promise.all([first, second]), ["applied", "applied"]);
	assert.equal(await f.authority.publishAdvance(publication), "duplicate");
	const after = f.authority.capture(); f.resources.push(after);
	assert.equal(after.editIds.length, 0);
});

add("changed sealed draft and disposed draft cannot repurpose a cached receipt", async t => {
	const f = await setup(t, true);
	const draft = f.authority.createDraft(f.cut, { afterPrefix: 1 }); f.resources.push(draft);
	const view = draft.viewWith(config); view.root.value = 3;
	const publication = { ...f.publication, draft };
	const first = f.authority.publishAdvance(publication);
	const branch = api.TreeAlpha.context(view.root);
	assert(branch.isBranch());
	let inTransaction;
	branch.runTransaction(() => {
		inTransaction = f.authority.publishAdvance(publication);
		return { rollback: true };
	});
	assert(inTransaction);
	await assert.rejects(inTransaction, /Finish the draft transaction/);
	view.root.value = 99;
	await assert.rejects(f.authority.publishAdvance(publication), /changed after sealing/);
	draft.dispose();
	await assert.rejects(f.authority.publishAdvance(publication), /disposed/);
	f.transport.processAllMessages(); assert.equal(await first, "applied");
	assert.equal(f.views[0].root.value, 3);
});

after(() => {
	const sourceTreeLoads = Object.keys(require.cache).filter(file =>
		file.includes(`${path.sep}r7-source${path.sep}packages${path.sep}dds${path.sep}tree${path.sep}`));
	assert.deepEqual(sourceTreeLoads, []);
	const packageRoot = path.join(import.meta.dirname, "node_modules", "@fluidframework", "tree");
	const dir = lane === "ESM" ? "lib" : "dist";
	const files = [
		"entrypoints\\alpha.js", "shared-tree\\externalAuthorityController.js",
		"shared-tree-core\\sharedTreeCore.js", "shared-tree-core\\editManager.js",
		"shared-tree\\sharedTree.js",
	];
	const hashes = Object.fromEntries(files.map(file => {
		const full = path.join(packageRoot, dir, file); return [full, sha(full)];
	}));
	writeFileSync(path.join(import.meta.dirname, "artifacts", `retry-contracts-${lane}.json`),
		JSON.stringify({
			lane, node: process.version, archiveSha256: sha(archive), hashes, sourceTreeLoads,
			scope: "Actual packed public API, generic local mock ordering; no AFR/OCS/native",
			results, passed: results.filter(x => x.status === "passed").length,
			failed: results.filter(x => x.status === "failed").length,
		}, null, 2));
});
