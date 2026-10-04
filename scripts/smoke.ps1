$ErrorActionPreference = 'Stop'
Remove-Item -Force data/smoke.sqlite* -ErrorAction SilentlyContinue
$imp = node --no-warnings dist/src/cli.js import --y "3,1,2" --w "1,1,1" --name demo --db data/smoke.sqlite | ConvertFrom-Json
$seqId = $imp.sequence.id
$v1 = $imp.version.id
"imported seq=$seqId v1=$v1"

$f1 = node --no-warnings dist/src/cli.js fit $v1 nondecreasing --db data/smoke.sqlite | ConvertFrom-Json
"v1 nondecreasing fit: $($f1.result.fit -join ',') sse=$($f1.result.weightedSSE)"

$v2obj = node --no-warnings dist/src/cli.js add-version $seqId --w "3,1,1" --note first-heavy --db data/smoke.sqlite | ConvertFrom-Json
$v2 = $v2obj.id
$f2 = node --no-warnings dist/src/cli.js fit $v2 nondecreasing --db data/smoke.sqlite | ConvertFrom-Json
"v2 nondecreasing fit: $($f2.result.fit -join ',') sse=$($f2.result.weightedSSE)"

$dec = node --no-warnings dist/src/cli.js fit $v1 nonincreasing --db data/smoke.sqlite | ConvertFrom-Json
"v1 nonincreasing fit: $($dec.result.fit -join ',')"

$cmp = node --no-warnings dist/src/cli.js compare $seqId $v1 $v2 nondecreasing --db data/smoke.sqlite | ConvertFrom-Json
"compare delta: $($cmp.fitDelta -join ',')"

"--- CSV export ---"
node --no-warnings dist/src/cli.js export $v1 nondecreasing csv --db data/smoke.sqlite
"--- restart: blocks ---"
node --no-warnings dist/src/cli.js blocks $v1 nondecreasing --db data/smoke.sqlite
"--- point-fit ---"
node --no-warnings dist/src/cli.js point-fit $v1 nondecreasing 1 --db data/smoke.sqlite
"--- invalid input error code ---"
node --no-warnings dist/src/cli.js import --y "[1,\"x\"]" --db data/smoke.sqlite
