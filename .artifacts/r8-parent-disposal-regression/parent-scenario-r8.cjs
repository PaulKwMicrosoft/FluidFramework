const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const [format, forest] = process.argv.slice(2);
  assert(['CJS','ESM'].includes(format) && ['Reference','Optimized'].includes(forest));
  const artifacts = 'C:\\office\\FluidFramework-sharedtree-bridge\\.artifacts';
  const archive = path.join(artifacts,'r8','fluidframework-tree-2.111.0.tgz');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const archiveSha256 = sha(readFileSync(archive));
  assert.equal(archiveSha256,'EA7CFC5BB102887160482896309F9BD89A0A435040BBDCD26D937AE4C99FFE55');
  const consumer = path.join(artifacts,'r8-consumer');
  const packed = createRequire(path.join(consumer,'package.json'));
  const packageRoot = path.join(consumer,'node_modules','@fluidframework','tree');
  const manifest = JSON.parse(readFileSync(path.join(packageRoot,'package.json'),'utf8'));
  const entry = path.resolve(packageRoot,manifest.exports['./alpha'][format === 'CJS' ? 'require' : 'import'].default);
  const api = format === 'CJS' ? packed('@fluidframework/tree/alpha') : await import(pathToFileURL(entry));
  const source = path.join(artifacts,'r8-source','packages','dds','tree');
  const sourceRequire = createRequire(path.join(source,'package.json'));
  const { MockContainerRuntimeFactory, MockFluidDataStoreRuntime, MockStorage } =
    sourceRequire('@fluidframework/test-runtime-utils/internal');
  const { createIdCompressor } = packed('@fluidframework/id-compressor/internal');
  const runtime = new MockFluidDataStoreRuntime({
    clientId:`dispose-${format}-${forest}`,id:'test',idCompressor:createIdCompressor(),
  });
  const transport = new MockContainerRuntimeFactory();
  const factory = api.configuredSharedTreeAlpha({
    forest:api[`ForestType${forest}`],minVersionForCollab:'2.80.0',enableDetachedRootEditing:true,
    externalAuthority:{documentEpoch:'dispose-repro',authorityId:'trusted-test',authorityEpoch:'epoch'},
  }).getFactory();
  const tree = factory.create(runtime,'tree');
  transport.createContainerRuntime(runtime);
  tree.connect({deltaConnection:runtime.createDeltaConnection(),objectStorage:new MockStorage()});
  const sf = new api.SchemaFactory(`dispose-repro-${format}-${forest}`);
  class Root extends sf.object('Root',{value:sf.number}) {}
  const config = new api.TreeViewConfiguration({schema:Root});
  const live = tree.viewWith(config);
  try {
    live.initialize({value:0});
    transport.processAllMessages();
    const authority = api.getSharedTreeAuthority(tree);
    const seed = authority.capture();
    const receipt = authority.publishAdvance({
      batchId:'seed',nextCheckpoint:'ready',capture:seed,approvePrefix:seed.editIds.length,
    });
    transport.processAllMessages();
    assert.equal(await receipt,'applied');
    seed.dispose();
    const capture = authority.capture({trackNodeReferences:true});
    const draft = authority.createDraft(capture);
    const view = draft.viewWith(config);
    let callbackCount = 0;
    let revertible;
    view.events.on('commitApplied',(_metadata,getRevertible) => {
      assert.equal(typeof getRevertible,'function');
      revertible = getRevertible(() => {
        callbackCount++;
        capture.dispose();
      });
    });
    view.root.value = 1;
    assert.notEqual(revertible,undefined);
    assert.doesNotThrow(() => capture.dispose(),
      'r8 must complete the exact parent commitApplied/revertible cleanup scenario');
    assert.doesNotThrow(() => capture.dispose());
    assert.throws(() => capture.exportSequenced(),/disposed/i);
    assert.equal(callbackCount,1);
    assert.equal(live.root.value,0);
    const healthy = authority.capture();
    healthy.dispose();
    assert(!Object.keys(require.cache).some(file =>
      file.startsWith(path.join(source,'lib')+path.sep) || file.startsWith(path.join(source,'dist')+path.sep)));
    console.log(JSON.stringify({
      result:'desired-cleanup-contract-passed',format,forest,archiveSha256,
      entry,entrySha256:sha(readFileSync(entry)),callbackCount,disposalError:null,
      liveValue:live.root.value,liveCaptureStillUsable:true,
      productionFiles:Object.fromEntries([
        'shared-tree\\externalAuthorityController.js',
        'shared-tree\\authorityNodeReferences.js',
        'shared-tree\\treeCheckout.js',
      ].map(file => {
        const full = path.join(packageRoot,format === 'CJS' ? 'dist' : 'lib',file);
        return [full,sha(readFileSync(full))];
      })),
      boundary:'Exact parent scenario adapted only for frozen r8 loading and desired-success assertions; generic local ordering mocks, no SDK edits, network or native operation',
    }));
  } finally { live.dispose(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
