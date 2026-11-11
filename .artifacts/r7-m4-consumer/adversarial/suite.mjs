import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const lane = process.env.ADVERSARIAL_FORMAT ?? "CJS";
const harness = path.resolve(import.meta.dirname, "..");
// Isolated r7 adaptation: the original audit files and evidence remain untouched.
const source = "C:\\office\\FluidFramework-sharedtree-bridge\\.artifacts\\r7-source";
const requirePacked = createRequire(path.join(harness, "package.json"));
const requireSource = createRequire(path.join(source, "packages", "dds", "tree", "package.json"));
const sha = value => createHash("sha256").update(value).digest("hex").toUpperCase();
const pins = {
	tree: sha(readFileSync(path.join(harness, "vendor", "sharedtree-authority-r7-m4.tgz"))),
	wrapper: sha(readFileSync(path.join(harness, "vendor", "fluid-framework-authority-r2.tgz"))),
};
assert.equal(pins.tree, "EA7CFC5BB102887160482896309F9BD89A0A435040BBDCD26D937AE4C99FFE55");
assert.equal(pins.wrapper, "2A0942EE89B05FB58F9E03EE40B7852C73A11DCE4C6A7F459556D8CD2218D16F");
const entries = {};
async function alpha(name) {
	const root = path.join(harness, "node_modules", name);
	const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const entry = path.resolve(root, manifest.exports["./alpha"][lane === "CJS" ? "require" : "import"].default);
	entries[name] = { path: entry, sha256: sha(readFileSync(entry)) };
	assert(entry.startsWith(path.join(harness, "node_modules")));
	return lane === "CJS" ? requirePacked(`${name}/alpha`) : import(pathToFileURL(entry));
}
const api = await alpha("@fluidframework/tree");
const wrapper = await alpha("fluid-framework");
for (const name of ["Tree", "SchemaFactory", "getSharedTreeAuthority", "configuredSharedTreeAlpha"]) {
	assert.equal(api[name], wrapper[name], `One packed implementation: ${name}`);
}
const { MockContainerRuntimeFactoryForReconnection, MockFluidDataStoreRuntime, MockStorage } =
	requireSource("@fluidframework/test-runtime-utils/internal");
const { createIdCompressor } = requirePacked("@fluidframework/id-compressor/internal");
const { FlushMode } = requireSource("@fluidframework/runtime-definitions/internal");
const { SchemaFactory, TreeViewConfiguration, Tree, TreeStatus,
	configuredSharedTreeAlpha, getSharedTreeAuthority } = api;
const sf = new SchemaFactory(`bounded-adversarial-r5-${lane}`);
class Item extends sf.object("Item", { name: sf.string, value: sf.number }) {}
class Items extends sf.array("Items", Item) {}
class Root extends sf.object("Root", {
	value: sf.number, other: sf.number, local: sf.number,
	tick0: sf.number, tick1: sf.number, tick2: sf.number,
	items: Items, slot: sf.optional(Item),
}) {}
const configuration = new TreeViewConfiguration({ schema: Root });
const labels = { documentEpoch: "adversarial-document", authorityId: "trusted-test", authorityEpoch: "epoch" };
const results = [];
const skippedKnownGaps = [];
const omissions = [
	"No real server, storage retention/expiry, authorization, runtime connection protocol or network sockets.",
	"Reconnect mock retains all missed ops in memory and immediately removes disconnected clients from quorum.",
	"Packed Tree production implementation; generic source ordering mocks only. Private fields read for history diagnostics.",
	"No native importer, OCS causal acceptance, AFR, persistence recovery, arbitrary subset approval or complete detach parity.",
	"Bounded schedules, not exhaustive; MSN is advanced by actual sequenced edits, not elapsed wall-clock time.",
];
let activeRecord;
let id = 0;
const clone = x => JSON.parse(JSON.stringify(x));
function sessionIdFor(name, client) {
	const h = sha(`${name}:${client}`).toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const ids = (tree, commits) => commits.map(c => c.revision === "root" ? "root" : tree.kernel.getStableRevision(c.revision));
const kernelState = tree => tree.kernel.getExternalAuthorityState();
const localIds = tree => ids(tree, tree.kernel.editManager.getLocalCommits("main"));
const branch = tree => tree.kernel.editManager.sharedBranches.get("main");
const fields = root => ({
	value: root.value, other: root.other, local: root.local,
	items: [...root.items].map(n => [n.name, n.value]),
	slot: root.slot && [root.slot.name, root.slot.value],
});
const state = (f, i = 0) => {
	const capture = f.controllers[i].capture();
	try {
		return { checkpoint: capture.checkpoint, p: [...capture.editIds], l: localIds(f.trees[i]),
			a: clone(capture.exportApproved()), s: clone(capture.exportSequenced()),
			visible: fields(f.views[i].root) };
	} finally { capture.dispose(); }
};
function remember(f, label) {
	activeRecord.trace.push({ label, sequence: f.transport.sequenceNumber, msn: f.transport.getMinSeq(),
		clients: f.trees.map((t, i) => ({
			checkpoint: kernelState(t).checkpoint, p: ids(t, kernelState(t).provisional),
			l: localIds(t), visible: fields(f.views[i].root),
			lastSequence: f.runtimes[i].deltaManager.lastSequenceNumber,
			kernelMsn: t.kernel.editManager.minimumSequenceNumber,
			retainedSequenceContexts: branch(t).sequenceIdToCommit.size,
		})) });
}
function ancestors(tree, head) {
	const chain = [];
	for (let c = head; c !== undefined; c = c.parent) chain.push(...ids(tree, [c]));
	return chain;
}

// Only transport scheduling is replaced. Each client receives a FIFO prefix of
// the one sequencer log, never a made-up per-client order.
class Transport extends MockContainerRuntimeFactoryForReconnection {
	log = [];
	getFirstMessageToProcess() {
		const message = super.getFirstMessageToProcess();
		const previous = this.log.at(-1);
		assert(message.minimumSequenceNumber >= (previous?.minimumSequenceNumber ?? 0), "Monotone MSN");
		assert(message.referenceSequenceNumber >= (previous?.minimumSequenceNumber ?? 0),
			"Submitted transport reference cannot predate the legal collaboration window");
		assert(message.referenceSequenceNumber < message.sequenceNumber, "Reference precedes operation");
		this.log.push(clone(message));
		return message;
	}
}

async function setup(t) {
	const kind = configuredSharedTreeAlpha({
		minVersionForCollab: "2.80.0", enableDetachedRootEditing: true, externalAuthority: labels,
	});
	const transport = new Transport();
	const runtimes = [], trees = [], submissions = [], gates = [];
	for (let i = 0; i < 3; i++) {
		const runtime = new MockFluidDataStoreRuntime({
			clientId: `case-${++id}-client-${i}`, id: "test",
			idCompressor: createIdCompressor(sessionIdFor(activeRecord.name, i)),
		});
		const tree = kind.getFactory().create(runtime, `tree-${i}`);
		const cr = transport.createContainerRuntime(runtime);
		// The generic mock omits silent clients from its minSeq map. Include them
		// explicitly, otherwise a paused silent writer cannot pin the window.
		transport.minSeq.set(cr.clientId, 0);
		const process = cr.process.bind(cr);
		const gate = { held: false, pending: [], delivered: 0 };
		cr.process = message => {
			if (gate.held) gate.pending.push(message);
			else {
				if (cr.connected) {
					assert(message.sequenceNumber > gate.delivered, "Strict FIFO delivery");
					gate.delivered = message.sequenceNumber;
				}
				process(message);
			}
		};
		gate.release = () => {
			gate.held = false;
			for (const message of gate.pending.splice(0)) cr.process(message);
		};
		const submit = cr.submit.bind(cr);
		cr.submit = (content, metadata) => {
			submissions.push({ client: i, ref: cr.deltaManager.lastSequenceNumber,
				connected: cr.connected, content: clone(content) });
			return submit(content, metadata);
		};
		runtimes.push(cr); trees.push(tree); gates.push(gate);
		tree.connect({ deltaConnection: runtime.createDeltaConnection(), objectStorage: new MockStorage() });
	}
	const views = trees.map(tree => tree.viewWith(configuration));
	views[0].initialize({
		value: 0, other: 0, local: 0, tick0: 0, tick1: 0, tick2: 0,
		items: [{ name: "a", value: 0 }, { name: "b", value: 0 }],
	});
	transport.processAllMessages();
	const controllers = trees.map(getSharedTreeAuthority);
	const capture = controllers[0].capture();
	const p = controllers[0].publishAdvance({
		batchId: "bootstrap", nextCheckpoint: "ready", capture, approvePrefix: capture.editIds.length,
	});
	transport.processAllMessages(); assert.equal(await p, "applied"); capture.dispose();
	const f = { transport, runtimes, trees, views, controllers, submissions, gates, resources: [] };
	t.after(() => {
		for (const resource of f.resources.reverse()) resource.dispose();
		activeRecord.envelopes = transport.log.map(m => ({
			sequence: m.sequenceNumber, minimumSequence: m.minimumSequenceNumber,
			referenceSequence: m.referenceSequenceNumber, client: m.clientId,
			kind: m.contents?.kind ?? m.contents?.type,
			batchId: m.contents?.kind === "advance" ? m.contents.content.batchId : undefined,
		}));
	});
	remember(f, "bootstrapped");
	return f;
}
const capture = (f, i = 0) => {
	const c = f.controllers[i].capture(); f.resources.push(c); return c;
};
const draft = (f, c, k = c.editIds.length, i = 0) => {
	const d = f.controllers[i].createDraft(c, { afterPrefix: k }); f.resources.push(d); return d;
};
const publication = (c, d, k = c.editIds.length, name = `advance-${++id}`) => ({
	batchId: name, nextCheckpoint: name, capture: c, approvePrefix: k, ...(d ? { draft: d } : {}),
});
async function settle(f, p, i = 0) {
	const receipt = f.controllers[i].publishAdvance(p);
	f.transport.processAllMessages(); assert.equal(await receipt, "applied");
}
async function age(f, rounds = 12, clients = [0, 1, 2]) {
	for (let round = 0; round < rounds; round++) {
		for (const i of clients) {
			f.views[i].root[`tick${i}`]++;
			f.transport.processAllMessages();
		}
	}
	remember(f, `aged-${rounds}-${clients.join("")}`);
}
function checkIdentities(f, roots, items) {
	f.views.forEach((v, i) => {
		assert.equal(v.root, roots[i]);
		if (items) assert.equal(v.root.items.find(n => n.name === "b"), items[i]);
	});
}
function add(name, fn, classification = "supported") {
	const skip = classification === "confirmed-contract-gap" && !process.env.ADVERSARIAL_REPRO_CONTRACTS;
	if (skip) skippedKnownGaps.push(name);
	test(name, { timeout: 15000, skip: skip ? "Already falsified in initial CJS evidence; opt in with --repro-contracts" : false }, async t => {
		const record = { name, classification, status: "running", trace: [] };
		results.push(record); activeRecord = record;
		try { await fn(t, record); record.status = "passed"; }
		catch (error) { record.status = "failed"; record.error = { message: error.message, stack: error.stack }; throw error; }
	});
}

add("MSN crosses captured P; retained/disposed forks preserve original contexts, A/P/L and ancestry", async (t, record) => {
	const f = await setup(t);
	const roots = f.views.map(v => v.root), items = f.views.map(v => v.root.items[1]);
	f.views[1].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), frozenA = clone(c.exportApproved()), frozenS = clone(c.exportSequenced());
	const d = draft(f, c); d.viewWith(configuration).root.value = 12;
	const oldSequence = f.transport.sequenceNumber;
	const contexts = f.trees.map(tree => branch(tree).sequenceIdToCommit.getPairOrNextLower({
		sequenceNumber: oldSequence, indexInBatch: Infinity,
	})[1]);
	const parents = contexts.map(c => c.parent), changes = contexts.map(c => c.change);
	for (let i = 0; i < 8; i++) {
		const disposable = capture(f);
		const discarded = draft(f, disposable);
		discarded.viewWith(configuration).root.other = 999;
		discarded.dispose(); disposable.dispose();
	}
	await age(f);
	assert(f.transport.getMinSeq() > oldSequence, "Actual sequencer MSN passed original P");
	f.trees.forEach((tree, i) => {
		assert(tree.kernel.editManager.minimumSequenceNumber > oldSequence, "Tree consumed advanced MSN");
		assert.equal(branch(tree).sequenceIdToCommit.getPairOrNextLower({
			sequenceNumber: oldSequence, indexInBatch: Infinity,
		})[1], contexts[i]);
		assert.equal(contexts[i].parent, parents[i]); assert.equal(contexts[i].change, changes[i]);
	});
	const allP = state(f).p;
	f.runtimes[2].runtimeOptions.flushMode = FlushMode.TurnBased;
	f.views[2].root.local = 77;
	const originalL = localIds(f.trees[2]); assert.equal(originalL.length, 1);
	const receipt = f.controllers[0].publishAdvance(publication(c, d));
	assert.equal(kernelState(f.trees[0]).checkpoint, "ready", "No optimistic A");
	f.transport.processAllMessages(); assert.equal(await receipt, "applied");
	assert.deepEqual(state(f).p, allP.slice(c.editIds.length));
	assert.deepEqual(localIds(f.trees[2]), originalL);
	assert.equal(f.views[2].root.local, 77); assert.equal(f.views[0].root.local, 0);
	for (const tree of f.trees) assert(ancestors(tree, kernelState(tree).approved).includes(c.editIds[0]));
	const a = draft(f, capture(f), 0).viewWith(configuration).root;
	assert.equal(a.value, 12); assert.equal(a.local, 0); assert.equal(a.tick0, 0);
	assert.deepEqual(c.exportApproved(), frozenA); assert.deepEqual(c.exportSequenced(), frozenS);
	checkIdentities(f, roots, items);
	f.runtimes[2].flush(); f.runtimes[2].runtimeOptions.flushMode = FlushMode.Immediate;
	f.transport.processAllMessages();
	assert.equal(f.runtimes[2].outbox.length, 0, "Held runtime outbox actually flushed");
	assert(state(f).p.includes(originalL[0])); assert.equal(localIds(f.trees[2]).length, 0);
	f.trees.forEach((tree, i) => {
		assert.equal(branch(tree).sequenceIdToCommit.getPairOrNextLower({
			sequenceNumber: oldSequence, indexInBatch: Infinity,
		})[1], contexts[i], "Correction cannot replace an original sequenced authoring context");
		assert.equal(contexts[i].parent, parents[i]); assert.equal(contexts[i].change, changes[i]);
	});
	remember(f, "old-capture-settled-and-L-sequenced");
	record.oldSequence = oldSequence;
	record.oldContextRevisions = f.trees.map((tree, i) => ids(tree, [contexts[i]])[0]);
});

add("Connected delayed old-context writer pins MSN; FIFO catch-up preserves target identities", async t => {
	const f = await setup(t);
	const kept = f.views.map(v => v.root.items[1]);
	f.views[0].root.value = 10; f.transport.processAllMessages();
	// Announce an up-to-date transport reference before holding this writer.
	await age(f, 1);
	const oldReference = f.runtimes[2].deltaManager.lastSequenceNumber;
	f.gates[2].held = true;
	f.runtimes[2].runtimeOptions.flushMode = FlushMode.TurnBased;
	f.views[2].root.items.removeAt(0);
	f.views[2].root.items[0].value = 9;
	const pendingIds = localIds(f.trees[2]);
	const c = capture(f), d = draft(f, c);
	const v = d.viewWith(configuration);
	v.root.items.insertAtStart({ name: "normalization", value: 2 });
	await settle(f, publication(c, d));
	await age(f, 8, [0, 1]);
	assert(f.transport.getMinSeq() <= oldReference, "Connected old writer MUST pin MSN");
	f.runtimes[2].flush(); f.runtimes[2].runtimeOptions.flushMode = FlushMode.Immediate;
	f.transport.processAllMessages();
	assert.equal(f.runtimes[2].outbox.length, 0, "Held runtime outbox actually flushed");
	assert.deepEqual(localIds(f.trees[2]), pendingIds, "No local retirement before its own echo");
	f.gates[2].release();
	for (let i = 0; i < 3; i++) {
		assert.deepEqual(fields(f.views[i].root).items, [["normalization", 2], ["b", 9]]);
		assert.equal(f.views[i].root.items[1], kept[i]);
		for (const pendingId of pendingIds) assert(state(f, i).p.includes(pendingId));
		assert.equal(localIds(f.trees[i]).length, 0);
	}
	await age(f, 3);
	assert(f.transport.getMinSeq() > oldReference);
	remember(f, "late-old-context-P-and-catchup");
});

add("Disconnected old-context L catches up beyond original MSN then resubmits stable revisions", async (t, record) => {
	const f = await setup(t), kept = f.views.map(v => v.root.items[1]);
	f.views[0].root.value = 10; f.transport.processAllMessages();
	const oldReference = f.runtimes[2].deltaManager.lastSequenceNumber;
	f.runtimes[2].connected = false;
	f.views[2].root.items.removeAt(0); f.views[2].root.items[0].value = 9;
	const pending = localIds(f.trees[2]); assert.equal(pending.length, 2);
	const c = capture(f), d = draft(f, c);
	d.viewWith(configuration).root.items.insertAtStart({ name: "normalization", value: 2 });
	await settle(f, publication(c, d));
	await age(f, 12, [0, 1]);
	assert(f.transport.getMinSeq() > oldReference);
	assert.deepEqual(localIds(f.trees[2]), pending);
	assert.equal(kernelState(f.trees[2]).checkpoint, "ready");
	const reconnectLogStart = f.submissions.length;
	f.runtimes[2].connected = true;
	assert.deepEqual(localIds(f.trees[2]), pending, "Rebase must preserve operation identities");
	f.transport.processAllMessages();
	f.views.forEach((v, i) => {
		assert.deepEqual(fields(v.root).items, [["normalization", 2], ["b", 9]]);
		assert.equal(v.root.items[1], kept[i]);
		for (const revision of pending) assert(state(f, i).p.includes(revision));
		assert.equal(localIds(f.trees[i]).length, 0);
	});
	record.oldReference = oldReference;
	record.resubmissionReferences = f.submissions.slice(reconnectLogStart).filter(s => s.client === 2).map(s => s.ref);
	assert(record.resubmissionReferences.every(ref => ref > oldReference),
		"Reconnect resubmits after catch-up; old transport reference is not falsely injected after MSN");
	remember(f, "offline-old-L-rebased-and-sequenced");
});

add("Removed subtree survives MSN with all captures/drafts disposed and no undo pin", async t => {
	const f = await setup(t), nodes = f.views.map(v => v.root.items[0]);
	f.views[0].root.items.removeAt(0); nodes[0].value = 7; f.transport.processAllMessages();
	const removalSequence = f.transport.sequenceNumber;
	const c = capture(f), d = draft(f, c);
	d.viewWith(configuration).root.value = 100;
	await settle(f, publication(c, d)); c.dispose(); d.dispose();
	await age(f, 12);
	assert(f.transport.getMinSeq() > removalSequence);
	nodes.forEach(node => { assert.equal(Tree.status(node), TreeStatus.Removed); assert.equal(node.value, 7); });
	nodes[1].value = 9; f.views[1].root.slot = nodes[1]; f.transport.processAllMessages();
	f.views.forEach((v, i) => {
		assert.equal(v.root.slot, nodes[i]); assert.equal(nodes[i].value, 9);
		assert.equal(Tree.status(nodes[i]), TreeStatus.InDocument);
	});
	assert.equal(state(f).p.length, 38);
	remember(f, "aged-removed-node-reattached");
});

add("Delayed self-echo holds entire inbound suffix; identical wire retries apply once", async t => {
	const f = await setup(t);
	f.views[1].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), d = draft(f, c); d.viewWith(configuration).root.value = 12;
	const p = publication(c, d);
	f.gates[0].held = true;
	let resolved = false;
	const receipt = f.controllers[0].publishAdvance(p).then(result => { resolved = true; return result; });
	const wire = f.submissions.at(-1).content;
	f.transport.processAllMessages();
	assert.equal(state(f, 1).checkpoint, p.nextCheckpoint);
	assert.equal(state(f, 0).checkpoint, "ready"); await turn(); assert.equal(resolved, false);
	// A new transport op, not illegal repeated delivery of the same sequence.
	f.runtimes[0].submit(wire, undefined); f.transport.processAllMessages();
	f.views[1].root.other = 8; f.transport.processAllMessages();
	assert.equal(state(f, 0).checkpoint, "ready"); assert.equal(f.views[0].root.other, 0);
	f.gates[0].release(); assert.equal(await receipt, "applied");
	const approved = f.trees.map(tree => kernelState(tree).approved);
	const before = f.trees.map((_, i) => state(f, i));
	f.runtimes[0].submit(wire, undefined); f.transport.processAllMessages();
	f.trees.forEach((tree, i) => {
		assert.equal(kernelState(tree).approved, approved[i]);
		assert.deepEqual(state(f, i), before[i]);
	});
	remember(f, "delayed-echo-and-wire-retries");
});

add("Lost pre-sequence authority send reconnects with byte-identical payload beyond captured MSN", async (t, record) => {
	const f = await setup(t);
	f.views[1].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), old = f.transport.sequenceNumber, d = draft(f, c);
	d.viewWith(configuration).root.value = 12;
	const p = publication(c, d), receipt = f.controllers[0].publishAdvance(p);
	const original = f.submissions.at(-1).content;
	f.runtimes[0].connected = false;
	await age(f, 12, [1, 2]);
	assert(f.transport.getMinSeq() > old);
	assert.equal(state(f, 1).checkpoint, "ready", "Dropped outbound advance has not sequenced");
	f.runtimes[0].connected = true;
	const retries = f.submissions.filter(s => s.content.kind === "advance" && s.content.content.batchId === p.batchId);
	assert.equal(retries.length, 2); assert.deepEqual(retries[1].content, original);
	f.transport.processAllMessages(); assert.equal(await receipt, "applied");
	assert.equal(state(f).p.length, 24); assert(f.views.every(v => v.root.value === 12));
	record.payloadHash = sha(JSON.stringify(original));
	remember(f, "lost-send-resubmitted-after-window");
});

add("Authority sequenced before disconnect; lost self-echo replays before resubmit after MSN advances", async (t, record) => {
	const f = await setup(t);
	f.views[1].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), d = draft(f, c); d.viewWith(configuration).root.value = 12;
	const p = publication(c, d), oldReference = f.runtimes[0].deltaManager.lastSequenceNumber;
	f.gates[0].held = true;
	let resolved = false;
	const receipt = f.controllers[0].publishAdvance(p).then(result => { resolved = true; return result; });
	f.transport.processAllMessages();
	assert.equal(state(f, 1).checkpoint, p.nextCheckpoint);
	assert.equal(state(f).checkpoint, "ready"); await turn(); assert.equal(resolved, false);
	const remoteApproved = kernelState(f.trees[1]).approved;
	f.runtimes[0].connected = false;
	f.gates[0].release(); // Move missed FIFO suffix into the reconnect mock's in-memory backlog.
	await age(f, 10, [1, 2]);
	assert(f.transport.getMinSeq() > oldReference); assert.equal(state(f).checkpoint, "ready");
	await turn(); assert.equal(resolved, false);
	f.runtimes[0].connected = true;
	f.transport.processAllMessages(); assert.equal(await receipt, "applied");
	assert.equal(kernelState(f.trees[1]).approved, remoteApproved);
	assert(f.views.every(v => v.root.value === 12));
	assert.equal(state(f).p.length, 20);
	const submissions = f.submissions.filter(s => s.content.kind === "advance" && s.content.content.batchId === p.batchId);
	assert.equal(submissions.length, 1, "Catch-up self-echo retires the pending send before resubmission");
	record.oldReference = oldReference;
	record.storageAssumption = "Original sequenced echo remains in mock backlog; no service-retention expiry modeled.";
	remember(f, "lost-sequenced-echo-caught-up");
});

add("Concurrent aged correction publications settle applied/stale and keep stale retry stale", async t => {
	const f = await setup(t);
	f.views[2].root.value = 10; f.transport.processAllMessages();
	const captures = [capture(f, 0), capture(f, 1)];
	const drafts = captures.map((c, i) => draft(f, c, 1, i));
	drafts.forEach((d, i) => { d.viewWith(configuration).root.value = 12 + i; });
	await age(f, 10);
	const p0 = publication(captures[0], drafts[0]), p1 = publication(captures[1], drafts[1]);
	const r0 = f.controllers[0].publishAdvance(p0), r1 = f.controllers[1].publishAdvance(p1);
	const staleWire = f.submissions.at(-1).content;
	f.transport.processAllMessages();
	assert.deepEqual(await Promise.all([r0, r1]), ["applied", "stale"]);
	assert.equal(state(f).p.length, 30);
	const before = state(f);
	f.runtimes[1].submit(staleWire, undefined); f.transport.processAllMessages();
	assert.deepEqual(state(f), before);
	assert(f.views.every(v => v.root.value === 12));
	assert.equal(branch(f.trees[0]).authorityBatches.get(p1.batchId).outcome, "stale");
	remember(f, "aged-competition-and-stale-duplicate");
});

add("Same in-flight pure-prefix retry must not poison the tree (known r5 failure)", async (t, record) => {
	const f = await setup(t);
	f.views[0].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), p = publication(c, undefined);
	const receipt = f.controllers[0].publishAdvance(p);
	await assert.rejects(f.controllers[0].publishAdvance(p), /already in flight/);
	record.contractGap = "Same-batch/same-payload in-flight API retry breaks SharedTree, not just the call. Original receipt cannot receive its self-echo.";
	// This assertion intentionally fails on r5. Do not clear the production breaker.
	assert.equal(state(f).checkpoint, "ready");
	f.transport.processAllMessages(); assert.equal(await receipt, "applied");
}, "confirmed-contract-gap");

add("Corrected publication cannot be retried via public API even after successful echo", async (t, record) => {
	const f = await setup(t);
	f.views[0].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), d = draft(f, c); d.viewWith(configuration).root.value = 12;
	const p = publication(c, d), receipt = f.controllers[0].publishAdvance(p);
	f.transport.processAllMessages(); assert.equal(await receipt, "applied");
	record.contractGap = "Public correction draft is one-shot. This is NOT a pass of the requested same-batch/same-payload retry invariant.";
	// Intentionally fails the requested idempotency contract, unlike a test
	// that would count the current rejection as successful idempotency.
	const duplicate = f.controllers[0].publishAdvance(p);
	f.transport.processAllMessages(); assert.equal(await duplicate, "duplicate");
}, "confirmed-contract-gap");

add("Pure-prefix identical public API retry after echo returns duplicate", async t => {
	const f = await setup(t);
	f.views[0].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), p = publication(c, undefined);
	await settle(f, p);
	const before = state(f), duplicate = f.controllers[0].publishAdvance(p);
	f.transport.processAllMessages(); assert.equal(await duplicate, "duplicate");
	assert.deepEqual(state(f), before);
});

for (const mode of ["changed-payload", "reused-checkpoint", "wrong-epoch"]) {
	add(`Fail-closed delivery: ${mode}`, async (t, record) => {
		const f = await setup(t);
		f.views[0].root.value = 10; f.transport.processAllMessages();
		const c = capture(f), p = publication(c, undefined);
		await settle(f, p);
		const wire = clone(f.submissions.find(s => s.content.kind === "advance" && s.content.content.batchId === p.batchId).content);
		const beforeApproved = branch(f.trees[0]).approvedHead;
		const beforeCheckpoint = branch(f.trees[0]).approvedCheckpoint;
		let regex;
		if (mode === "changed-payload") { wire.content.next = "changed"; regex = /identity reused with different content/; }
		if (mode === "reused-checkpoint") {
			wire.content.batchId = "fresh-batch"; wire.content.expected = p.nextCheckpoint;
			wire.content.next = "ready"; wire.content.approvedPrefix = [];
			regex = /checkpoint identities cannot be reused/;
		}
		if (mode === "wrong-epoch") { wire.configuration.authorityEpoch = "wrong"; regex = /Wrong authority epoch/; }
		f.runtimes[0].submit(wire, undefined);
		assert.throws(() => f.transport.processAllMessages(), regex);
		assert.equal(branch(f.trees[0]).approvedHead, beforeApproved, "Reject before authority mutation");
		assert.equal(branch(f.trees[0]).approvedCheckpoint, beforeCheckpoint);
		assert.throws(() => f.controllers[0].capture(), /invalid state by another error/);
		record.failClosed = "Protocol assertion halts delivery, not a recoverable stale/publication receipt; fixture discarded.";
	}, "explicit-rejection");
}

add("Postattach authority summary rejects after MSN advance even when P is empty", async (t, record) => {
	const f = await setup(t); await age(f, 6);
	const c = capture(f); await settle(f, publication(c, undefined));
	assert.equal(state(f).p.length, 0);
	await assert.rejects(f.trees[0].summarize(), /runtime summaries are not implemented/);
	record.excludedBoundary = "No bounded service restart/new-client snapshot path follows from these tests. Not an in-contract defect.";
}, "explicitly-excluded-capability");

add("Disposed captures, wrong-controller drafts and prefix mismatch reject without poisoning", async t => {
	const f = await setup(t);
	f.views[0].root.value = 10; f.transport.processAllMessages();
	const c = capture(f), d = draft(f, c, 0);
	await assert.rejects(f.controllers[0].publishAdvance(publication(c, d, 1)), /authoring base/);
	const foreign = capture(f, 1);
	assert.throws(() => f.controllers[0].createDraft(foreign), /live capture from this controller/);
	const dead = capture(f); dead.dispose();
	assert.throws(() => f.controllers[0].createDraft(dead), /live capture/);
	assert.throws(() => dead.exportApproved(), /disposed/);
	await settle(f, publication(c, undefined));
	assert.equal(state(f).p.length, 0);
}, "explicit-rejection");

const seeds = [0x51a1, 0x51a2, 0x51a8, 0x51a9];
for (const seed of seeds) {
	add(`Seed ${seed}: bounded legal reconnect/publication ordering`, async (t, record) => {
		let random = seed;
		const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
		const choice = n => next() % n;
		const f = await setup(t), roots = f.views.map(v => v.root), items = f.views.map(v => v.root.items[1]);
		record.seed = seed; record.schedule = [];
		f.views[1].root.value = 10; f.transport.processAllMessages();
		const c = capture(f), originalP = [...c.editIds], d = draft(f, c);
		d.viewWith(configuration).root.value = 12;
		f.runtimes[2].connected = false;
		const localEdits = 1 + choice(3);
		for (let i = 0; i < localEdits; i++) f.views[2].root.local++;
		const originalL = localIds(f.trees[2]);
		const oldRef = f.runtimes[2].deltaManager.lastSequenceNumber;
		const rounds = 2 + choice(4);
		await age(f, rounds, [0, 1]);
		assert(f.transport.getMinSeq() > oldRef);
		const reconnectFirst = choice(2) === 0;
		if (reconnectFirst) {
			record.schedule.push("reconnect-L-before-publication");
			f.runtimes[2].connected = true; f.transport.processAllMessages();
		}
		const peerFirst = choice(2) === 0;
		if (peerFirst) { f.views[1].root.other = 5; record.schedule.push("peer-P-before-publication"); }
		const p = publication(c, d), receipt = f.controllers[0].publishAdvance(p);
		record.schedule.push("publish");
		if (!peerFirst) { f.views[1].root.other = 5; record.schedule.push("peer-P-after-publication"); }
		f.transport.processAllMessages(); assert.equal(await receipt, "applied");
		if (!reconnectFirst) {
			record.schedule.push("reconnect-L-after-publication");
			f.runtimes[2].connected = true; f.transport.processAllMessages();
		}
		for (let i = 0; i < 3; i++) {
			assert.equal(f.views[i].root.value, 12); assert.equal(f.views[i].root.other, 5);
			assert.equal(f.views[i].root.local, localEdits);
			for (const revision of originalL) assert(state(f, i).p.includes(revision));
			assert(!state(f, i).p.includes(originalP[0]));
			assert(ancestors(f.trees[i], kernelState(f.trees[i]).approved).includes(originalP[0]));
			assert.equal(localIds(f.trees[i]).length, 0);
		}
		const approved = draft(f, capture(f), 0).viewWith(configuration).root;
		assert.equal(approved.value, 12); assert.equal(approved.other, 0); assert.equal(approved.local, 0);
		checkIdentities(f, roots, items);
		const final = capture(f); await settle(f, publication(final, undefined));
		assert.equal(state(f).p.length, 0);
		assert.deepEqual(state(f).a, state(f).s);
		remember(f, "seeded-settled");
	});
}

after(() => {
	const sourceTreeLoaded = Object.keys(requirePacked.cache).filter(p =>
		p.toLowerCase().startsWith(path.join(source, "packages", "dds", "tree").toLowerCase()));
	assert.deepEqual(sourceTreeLoaded, [], "No source Tree implementation loaded through CJS");
	mkdirSync(path.join(harness, "artifacts"), { recursive: true });
	writeFileSync(path.join(harness, "artifacts",
		`adversarial-${process.env.ADVERSARIAL_REPRO_CONTRACTS ? "repro-" : ""}${lane.toLowerCase()}.json`),
		JSON.stringify({
			format: lane, node: process.version, pins, entries, sourceTreeLoaded,
			seeds, skippedKnownGaps, bounded: { clients: 3, maxAgeRounds: 12, testTimeoutMs: 15000, processTimeoutMs: 100000 },
			counts: { total: results.length, passed: results.filter(r => r.status === "passed").length,
				failed: results.filter(r => r.status === "failed").length,
				skippedAlreadyFalsifiedContracts: skippedKnownGaps.length,
				confirmedContractGapsObservedThisRun: results.filter(r => r.classification === "confirmed-contract-gap").length },
			omissions, results,
		}, null, 2));
});
