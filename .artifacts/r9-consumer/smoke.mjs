import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";

const lane = process.argv[2];
assert(["CJS", "ESM"].includes(lane));
assert.equal(typeof global.gc, "function");
const require = createRequire(import.meta.url);
const load = specifier => lane === "CJS" ? require(specifier) : import(specifier);
const tree = await load("@fluidframework/tree/alpha");
const wrapper = await load("fluid-framework/alpha");
const publicTree = await load("@fluidframework/tree");
const publicWrapper = await load("fluid-framework");
for (const name of ["Tree", "SchemaFactory", "TreeViewConfiguration"]) {
  assert.equal(publicTree[name], publicWrapper[name], `public identity: ${name}`);
  assert.equal(publicTree[name], tree[name], `direct/alpha identity: ${name}`);
}
for (const name of ["Tree", "SchemaFactory", "TreeViewConfiguration",
  "configuredSharedTreeAlpha", "getSharedTreeAuthority", "asTreeViewAlpha", "TreeAlpha"]) {
  assert.notEqual(tree[name], undefined, `Missing alpha export: ${name}`);
  assert.equal(tree[name], wrapper[name], `wrapper/Tree identity: ${name}`);
}
const packageRoot = realpathSync(path.join(import.meta.dirname, "node_modules", "@fluidframework", "tree"));
const wrapperRoot = realpathSync(path.join(import.meta.dirname, "node_modules", "fluid-framework"));
const wrapperRequire = createRequire(path.join(wrapperRoot, "package.json"));
const directEntry = realpathSync(lane === "CJS" ? require.resolve("@fluidframework/tree/alpha")
  : fileURLToPath(import.meta.resolve("@fluidframework/tree/alpha")));
assert(directEntry.startsWith(`${packageRoot}${path.sep}`));
assert(realpathSync(wrapperRequire.resolve("@fluidframework/tree/alpha")).startsWith(`${packageRoot}${path.sep}`));
const wrapperManifest = JSON.parse(readFileSync(path.join(wrapperRoot, "package.json")));
assert.equal(wrapperManifest.dependencies["@fluidframework/tree"], "~2.111.0");
const { MockContainerRuntimeFactory, MockFluidDataStoreRuntime, MockStorage } =
  await load("@fluidframework/test-runtime-utils/internal");
const { createIdCompressor } = await load("@fluidframework/id-compressor/internal");
const proofs = [];
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");

for (const forest of ["Reference", "Optimized"]) {
  for (const externalAuthority of [false, true]) {
    const options = {
      forest: tree[`ForestType${forest}`],
      minVersionForCollab: "2.80.0",
      enableDetachedRootEditing: true,
      ...(externalAuthority ? { externalAuthority: {
        documentEpoch: `r9-${lane}-${forest}`, authorityId: "a", authorityEpoch: "e",
      } } : {}),
    };
    const factory = wrapper.configuredSharedTreeAlpha(options).getFactory();
    if (externalAuthority) assert.equal(factory.type,
      "https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2");
    const transport = new MockContainerRuntimeFactory();
    const trees = Array.from({ length: 2 }, (_, i) => {
      const runtime = new MockFluidDataStoreRuntime({
        id: "test", clientId: `${lane}-${forest}-${externalAuthority}-${i}`, idCompressor: createIdCompressor(),
      });
      const instance = factory.create(runtime, `tree-${i}`);
      transport.createContainerRuntime(runtime);
      instance.connect({ deltaConnection: runtime.createDeltaConnection(), objectStorage: new MockStorage() });
      return instance;
    });
    const sf = new wrapper.SchemaFactory(`r9-smoke-${lane}-${forest}-${externalAuthority}`);
    class Item extends sf.object("Item", { value: sf.number }) {}
    class Root extends sf.object("Root", { value: sf.number, other: sf.number, slot: sf.optional(Item) }) {}
    const config = new wrapper.TreeViewConfiguration({ schema: Root });
    const views = trees.map(instance => wrapper.asTreeViewAlpha(instance.viewWith(config)));
    const live = views[0];
    live.initialize({ value: 0, other: 0, slot: { value: 0 } });
    transport.processAllMessages();

    const parent = live.fork();
    parent.root.value = 1;
    const child = parent.fork();
    child.root.value = 2;
    assert.equal(live.root.value, 0);
    assert.equal(parent.root.value, 1);
    live.root.other = 3;
    transport.processAllMessages();
    child.rebaseOnto(live);
    assert.equal(child.root.value, 2);
    assert.equal(child.root.other, 3);
    live.merge(child);
    parent.dispose();
    transport.processAllMessages();
    assert.equal(live.root.value, 2);
    assert.equal(views[1].root.value, 2);
    assert.equal(views[1].root.other, 3);
    const proof = { forest, externalAuthority, transitiveForkIsolationRebaseMerge: true };

    if (externalAuthority) {
      const authority = wrapper.getSharedTreeAuthority(trees[0]);
      assert.equal(authority, tree.getSharedTreeAuthority(trees[0]));
      const initial = authority.capture();
      const bootstrap = authority.publishAdvance({
        batchId: "bootstrap", nextCheckpoint: "ready", capture: initial, approvePrefix: initial.editIds.length,
      });
      transport.processAllMessages();
      assert.equal(await bootstrap, "applied");
      initial.dispose();
      const original = live.root.slot;
      original.value = 4;
      transport.processAllMessages();
      const capture = authority.capture({ trackNodeReferences: true });
      const tracked = capture.reference(original);
      assert.equal(tracked.kind, "tracked");
      assert.deepEqual(capture.exportSequenced(), capture.exportSequenced());
      const draft = authority.createDraft(capture, { afterPrefix: capture.editIds.length });
      const draftView = wrapper.asTreeViewAlpha(draft.viewWith(config));
      assert.notEqual(draftView.root.slot, original);
      assert.equal(draftView.root.slot.value, 4);
      assert.equal(capture.resolve(tracked.reference, draft).node, draftView.root.slot);
      draftView.root.slot.value = 9;
      const publication = {
        batchId: "correct", nextCheckpoint: "settled", capture,
        approvePrefix: capture.editIds.length, draft,
      };
      const receipt = authority.publishAdvance(publication);
      const retry = authority.publishAdvance(publication);
      transport.processAllMessages();
      assert.deepEqual(await Promise.all([receipt, retry]), ["applied", "applied"]);
      assert.equal(await authority.publishAdvance(publication), "duplicate");
      assert.equal(live.root.slot, original);
      assert.equal(original.value, 9);
      assert.equal(views[1].root.slot.value, 9);
      assert.equal(capture.resolve(tracked.reference, "live").node, original);
      live.root.slot = undefined;
      original.value = 10;
      live.root.slot = original;
      transport.processAllMessages();
      assert.equal(live.root.slot, original);
      assert.equal(views[1].root.slot.value, 10);
      capture.dispose();
      capture.dispose();
      assert.throws(() => capture.exportSequenced(), /disposed/);
      assert.throws(() => draft.viewWith(config), /disposed/);
      draft.dispose();
      const weak = [];
      function captureAndDispose() {
        const next = authority.capture();
        weak.push(new WeakRef(next));
        next.exportSequenced();
        next.dispose();
      }
      for (let i = 0; i < 100; i++) captureAndDispose();
      for (let i = 0; i < 8; i++) {
        await setImmediate();
        global.gc();
      }
      const alive = weak.filter(ref => ref.deref() !== undefined).length;
      assert.equal(alive, 0, "Disposed public captures remain reachable");
      Object.assign(proof, {
        authorityCheckpointAndCorrection: true, referenceCaptureAndDraftIdentity: true,
        identicalRetry: true, detachedEditReattach: true, disposalExpiry: true,
        captureExportDisposeCycles: weak.length, disposedCapturesAlive: alive,
      });
    }
    proofs.push(proof);
  }
}
const sourceTreeLoads = Object.keys(require.cache).filter(file =>
  /[\\/]r9-source[\\/]packages[\\/]dds[\\/]tree[\\/]/.test(file));
assert.deepEqual(sourceTreeLoads, []);
const result = {
  success: true, lane, nodeVersion: process.version, packageRoot, wrapperRoot, directEntry,
  archiveSha256: hash(path.join(import.meta.dirname, "..", "r9", "fluidframework-tree-2.111.0.tgz")),
  wrapperSha256: hash("C:\\office\\ppt-sharedtree-bridge\\harness-r5\\vendor\\fluid-framework-authority-r2.tgz"),
  editManagerSha256: hash(path.join(packageRoot, lane === "CJS" ? "dist" : "lib", "shared-tree-core", "editManager.js")),
  sourceWorktreeTreeLoaded: false, wrapperAndDirectIdentity: true, proofs,
  limitation: "Fresh installed archive, local mock sequencing only; no real services/native/browser/OCS/AFR.",
};
writeFileSync(path.join(import.meta.dirname, "evidence", `smoke-${lane}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
