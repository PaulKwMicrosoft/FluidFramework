$ErrorActionPreference = 'Stop'
$base = Split-Path $PSScriptRoot
$source = Join-Path $base 'r6-source'
$tree = Join-Path $source 'packages\dds\tree'
$consumer = Join-Path $base 'r6-consumer'
$packed = Join-Path $consumer 'node_modules\@fluidframework\tree'
$output = Join-Path $base 'r6'
$parent = '834f2552c7baa214e82b2d9ddbed559d60293009'
$commit = (git -C $source rev-parse HEAD).Trim()
if ((git -C $source rev-parse 'HEAD^').Trim() -ne $parent) { throw 'Wrong source parent' }
if (@(git -C $source status --porcelain).Count) { throw 'Source is not clean' }
git -C $source apply --check --reverse (Join-Path $output 'sharedtree-source.patch')
if ($LASTEXITCODE) { throw 'Incremental patch does not match committed source' }

function Hash([string] $path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

$production = @()
$packageFiles = @()
foreach ($file in Get-ChildItem $packed -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($packed, $file.FullName)
    $hash = Hash $file.FullName
    $packageFiles += [ordered]@{ path = $relative; sha256 = $hash }
    if ($relative -ne 'package.json') {
        $original = Join-Path $tree $relative
        if (!(Test-Path -LiteralPath $original) -or (Hash $original) -ne $hash) {
            throw "Packaged file differs from validated source/build: $relative"
        }
        if ($relative -match '^(src|lib|dist)\\') {
            $production += [ordered]@{ path = $relative; sha256 = $hash }
        }
    }
}
$manifest = Get-Content (Join-Path $packed 'package.json') -Raw | ConvertFrom-Json
$before = @(Import-Clixml (Join-Path $PSScriptRoot 'r5-before.clixml'))
foreach ($record in $before) {
    if ((Hash $record.Path) -ne $record.Hash) { throw "r5 changed: $($record.Path)" }
}
if ((git -C (Join-Path $base 'detach-port') rev-parse HEAD).Trim() -ne $parent) {
    throw 'r5 source HEAD changed'
}
$wrapperBaseline = Join-Path $PSScriptRoot 'wrapper-baseline'
if (Test-Path $wrapperBaseline) { throw 'Wrapper baseline extraction already exists' }
New-Item -ItemType Directory $wrapperBaseline | Out-Null
tar -xf (Join-Path $base 'r2\fluid-framework-2.111.0.tgz') -C $wrapperBaseline
if ($LASTEXITCODE) { throw 'Wrapper extraction failed' }
$wrapperFiles = @(Get-ChildItem (Join-Path $wrapperBaseline 'package') -Recurse -File)
foreach ($file in $wrapperFiles) {
    $relative = [IO.Path]::GetRelativePath((Join-Path $wrapperBaseline 'package'), $file.FullName)
    $copied = Join-Path $consumer "node_modules\fluid-framework\$relative"
    if ((Hash $copied) -ne (Hash $file.FullName)) { throw "Wrapper differs: $relative" }
}
$historical = [ordered]@{
    'r2\fluidframework-tree-2.111.0.tgz' = 'B018B9E461E39E90006C8554C6C2A16D168FA17715E61E8D29C958FF188C6D33'
    'r2\fluid-framework-2.111.0.tgz' = '2A0942EE89B05FB58F9E03EE40B7852C73A11DCE4C6A7F459556D8CD2218D16F'
    'r3\fluidframework-tree-2.111.0.tgz' = '921546E57F9F611F374226FF097FED95563BADC1FE92C2476A5823EACFAFABDD'
    'r4\fluidframework-tree-2.111.0.tgz' = 'A3B17F0D75738D37D8D00C366620D9FFE86CABBA2C6C73336D56A84B1208C179'
    'r5\fluidframework-tree-2.111.0.tgz' = '2EC514151BB1A314EFE8C7020FC1E20F9D7815F6BC7D6BC2908ADBCC4936BA20'
}
foreach ($entry in $historical.GetEnumerator()) {
    if ((Hash (Join-Path $base $entry.Key)) -ne $entry.Value) { throw "Historical archive changed: $($entry.Key)" }
}
$proofs = @()
foreach ($lane in 'ESM','CJS') {
    if ((Get-Content (Join-Path $PSScriptRoot "$($lane.ToLower())-tests.log") -Raw) -notmatch '83 passing') {
        throw "Incomplete source matrix: $lane"
    }
    foreach ($forest in 'Reference','Optimized') {
        foreach ($scenario in 'references','proof') {
            $path = Join-Path $PSScriptRoot "packed-$lane-$forest-$scenario.json"
            $result = Get-Content $path -Raw | ConvertFrom-Json
            if ($result.lane -ne $lane -or $result.forest -ne $forest) { throw 'Wrong packed proof' }
            if ($scenario -eq 'references' -and $result.success -ne $true) { throw 'Failed references proof' }
            if ($scenario -eq 'proof' -and ($result.checkpoint -ne 'final' -or $result.finalPending -ne 0)) {
                throw 'Failed atomic/detach proof'
            }
            $proofs += [ordered]@{ path = $path; sha256 = Hash $path; result = $result }
        }
    }
}
$fixtureHashes = @{}
foreach ($file in Get-ChildItem $consumer -File) { $fixtureHashes[$file.Name] = Hash $file.FullName }
$evidenceHashes = @{}
foreach ($file in Get-ChildItem $PSScriptRoot -File) { $evidenceHashes[$file.Name] = Hash $file.FullName }
$result = [ordered]@{
    successor = 'r6'
    sourceCommit = $commit
    sourceParent = $parent
    branch = 'user/paulkw/sharedtree-capture-node-references'
    sourceClean = $true
    packageVersion = $manifest.version
    packageGitHead = $manifest.gitHead
    treeArchiveSha256 = Hash (Join-Path $output 'fluidframework-tree-2.111.0.tgz')
    sourcePatchSha256 = Hash (Join-Path $output 'sharedtree-source.patch')
    wireProtocol = 2
    ddsType = 'https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2'
    compatibility = 'Process-local opt-in only. No wire/DDS change. Mixed r5/r6 runtime deployment not tested; no v1 migration.'
    sourceCasesPerFormat = @{ references = 30; atomic = 19; detach = 16; authority = 18; total = 83 }
    sourceFormats = @('ESM','CJS')
    forestKinds = @('ObjectForest','ChunkedForest')
    packedProofRuns = $proofs
    publicTypeFixtures = @('api-proof.mts','api-proof.cts')
    wrapper = @{ source = 'r2'; filesByteMatched = $wrapperFiles.Count; sha256 = $historical['r2\fluid-framework-2.111.0.tgz']; newNamedTypes = '@fluidframework/tree/alpha only; wrapper inference works' }
    r5Immutability = @{ beforeLedger = 'r6-evidence\r5-before.clixml'; filesByteMatched = $before.Count; head = $parent }
    historicalArchives = $historical
    build = 'Unfiltered root clean blocked by intentionally absent unrelated dependencies. Root Tree dependency-closure clean build completed all 385 tasks, offline. Only intended alpha report changes remain.'
    packageFileCount = $packageFiles.Count
    productionFileCount = $production.Count
    packageFiles = $packageFiles
    productionFiles = $production
    fixtureHashes = $fixtureHashes
    evidenceHashes = $evidenceHashes
    excludedClaims = @('AFR','OCS','native conversion','durable references','runtime summaries','bounded authority history','correction-draft-born to live counterpart','full historical detach parity')
}
$result | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $output 'verification.json') -Encoding utf8
[ordered]@{
    sourceCommit = $commit
    archiveSha256 = $result.treeArchiveSha256
    patchSha256 = $result.sourcePatchSha256
    verificationSha256 = Hash (Join-Path $output 'verification.json')
    productionFiles = $production.Count
    allPackageFiles = $packageFiles.Count
    r5FilesUnchanged = $before.Count
    wrapperFilesUnchanged = $wrapperFiles.Count
    packedProofRuns = $proofs.Count
} | ConvertTo-Json
