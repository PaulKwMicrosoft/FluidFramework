$ErrorActionPreference = 'Stop'
$base = Split-Path $PSScriptRoot
$source = Join-Path $base 'r7-source'
$tree = Join-Path $source 'packages\dds\tree'
$consumer = Join-Path $base 'r7-consumer'
$packed = Join-Path $consumer 'node_modules\@fluidframework\tree'
$output = Join-Path $base 'r7'
$parent = 'ae2ecd6572c1bc46b7a3cd6207106d5ecc5ff1e0'
$commit = (git -C $source rev-parse HEAD).Trim()
function Hash([string] $path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
if ((git -C $source rev-parse 'HEAD^').Trim() -ne $parent) { throw 'Wrong source base' }
if (@(git -C $source status --porcelain).Count) { throw 'Dirty source' }
git -C $source apply --check --reverse (Join-Path $output 'sharedtree-source.patch')
if ($LASTEXITCODE) { throw 'Incremental patch does not match committed source' }
$archive = Join-Path $output 'fluidframework-tree-2.111.0.tgz'
if ((Hash $archive) -ne 'F8F4E58F5BC67AFBFA7E0D9B4D9851833B989698547E82AC423411FC9FA1DECE') {
    throw 'Unexpected final package'
}
$files = @()
$production = 0
foreach ($file in Get-ChildItem $packed -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($packed, $file.FullName)
    $hash = Hash $file.FullName
    if ($relative -ne 'package.json' -and (Hash (Join-Path $tree $relative)) -ne $hash) {
        throw "Package differs from source/build: $relative"
    }
    if ($relative -match '^(src|lib|dist)\\') { $production++ }
    $files += [ordered]@{ path = $relative; sha256 = $hash }
}
$before = @(Import-Clixml (Join-Path $PSScriptRoot 'immutable-before.clixml'))
foreach ($record in $before) {
    if ((Hash $record.Path) -ne $record.Hash) { throw "Protected r5/r6 file changed: $($record.Path)" }
}
if ((git -C (Join-Path $base 'r6-source') rev-parse HEAD).Trim() -ne $parent) { throw 'r6 HEAD changed' }
if ((git -C (Join-Path $base 'detach-port') rev-parse HEAD).Trim() -ne '834f2552c7baa214e82b2d9ddbed559d60293009') {
    throw 'r5 HEAD changed'
}
$wrapper = Join-Path $PSScriptRoot 'wrapper-baseline'
New-Item -ItemType Directory $wrapper | Out-Null
tar -xf (Join-Path $base 'r2\fluid-framework-2.111.0.tgz') -C $wrapper
if ($LASTEXITCODE) { throw 'Wrapper extraction failed' }
$wrapperFiles = @(Get-ChildItem (Join-Path $wrapper 'package') -Recurse -File)
foreach ($file in $wrapperFiles) {
    $relative = [IO.Path]::GetRelativePath((Join-Path $wrapper 'package'), $file.FullName)
    if ((Hash $file.FullName) -ne (Hash (Join-Path $consumer "node_modules\fluid-framework\$relative"))) {
        throw "Wrapper changed: $relative"
    }
}
$results = @()
foreach ($lane in 'ESM','CJS') {
    $sourceLog = Get-Content (Join-Path $PSScriptRoot "$($lane.ToLower())-tests.log") -Raw
    if ($sourceLog -notmatch '103 passing') { throw "Incomplete source tests: $lane" }
    $retries = Get-Content (Join-Path $consumer "artifacts\retry-contracts-$lane.json") -Raw | ConvertFrom-Json
    if ($retries.passed -ne 12 -or $retries.failed -ne 0 -or $retries.archiveSha256 -ne (Hash $archive)) {
        throw "Packed retry failure/pin mismatch: $lane"
    }
    $audit = Get-Content (Join-Path $consumer "artifacts\adversarial-$($lane.ToLower()).json") -Raw | ConvertFrom-Json
    if ($audit.counts.passed -ne 18 -or $audit.counts.failed -ne 0 -or
        $audit.counts.skippedAlreadyFalsifiedContracts -ne 2 -or $audit.pins.tree -ne (Hash $archive)) {
        throw "Packed adversarial regression failure/pin mismatch: $lane"
    }
    foreach ($forest in 'Reference','Optimized') {
        foreach ($scenario in 'references','proof') {
            $result = Get-Content (Join-Path $PSScriptRoot "packed-$lane-$forest-$scenario.json") -Raw | ConvertFrom-Json
            if ($result.lane -ne $lane -or $result.forest -ne $forest) { throw 'Wrong reference/atomic proof' }
            if ($scenario -eq 'references' -and $result.success -ne $true) { throw 'Reference proof failed' }
            if ($scenario -eq 'proof' -and ($result.checkpoint -ne 'final' -or $result.finalPending -ne 0)) {
                throw 'Atomic proof failed'
            }
        }
    }
    $results += [ordered]@{ lane = $lane; positiveRetries = $retries; adaptedAudit = $audit }
}
$evidence = @()
foreach ($root in @($PSScriptRoot, $consumer)) {
    foreach ($file in Get-ChildItem $root -File) {
        $evidence += [ordered]@{ path = $file.FullName; sha256 = Hash $file.FullName }
    }
}
$auditCopy = Join-Path $consumer 'adversarial\suite.mjs'
$evidence += [ordered]@{ path = $auditCopy; sha256 = Hash $auditCopy }
$result = [ordered]@{
    successor = 'r7'
    sourceCommit = $commit
    sourceParent = $parent
    branch = 'user/paulkw/sharedtree-publication-retries'
    packageVersion = '2.111.0'
    archiveSha256 = Hash $archive
    sourcePatchSha256 = Hash (Join-Path $output 'sharedtree-source.patch')
    protocolVersion = 2
    ddsType = 'https://graph.microsoft.com/types/tree/detached-roots-v1/external-authority-v2'
    apiSignatureChanges = $false
    sourceCasesPerFormat = @{ retry = 20; reference = 30; atomic = 19; detach = 16; authority = 18; total = 103 }
    packedPositiveCasesPerFormat = 12
    packedAdaptedAuditPerFormat = @{ passed = 18; historicalReprosSkipped = 2; supported = 13; invalidWire = 4; excludedSummaryBoundary = 1 }
    packedReferenceAtomicRuns = 8
    productionFilesByteMatched = $production
    packageFiles = $files
    wrapperFilesByteMatched = $wrapperFiles.Count
    wrapperSha256 = Hash (Join-Path $base 'r2\fluid-framework-2.111.0.tgz')
    protectedR5R6FilesByteMatched = $before.Count
    protectedLedger = 'r7-evidence\immutable-before.clixml'
    protectedR5ArchiveSha256 = Hash (Join-Path $base 'r5\fluidframework-tree-2.111.0.tgz')
    protectedR6ArchiveSha256 = Hash (Join-Path $base 'r6\fluidframework-tree-2.111.0.tgz')
    receiptLimits = @{ publicPerKernel = 128; coreInFlight = 128; lifetime = 'Original live capture and draft; no durable reopen. Completed capture disposal releases public entries.' }
    existingUnboundedState = 'Authority history, original sequencing contexts and wire batch ledger remain unbounded.'
    evidence = $evidence
    results = $results
    omitted = @('AFR','OCS','native','real server retention','durable receipt/restart recovery','mixed-version deployment proof','r6 reference implementation audit')
}
$result | ConvertTo-Json -Depth 35 | Set-Content (Join-Path $output 'verification.json') -Encoding utf8
Remove-Item $wrapper -Recurse -Force
[ordered]@{
    commit = $commit
    archive = $result.archiveSha256
    patch = $result.sourcePatchSha256
    verification = Hash (Join-Path $output 'verification.json')
    productionFiles = $production
    packageFiles = $files.Count
    protectedFiles = $before.Count
    wrapperFiles = $wrapperFiles.Count
} | ConvertTo-Json
