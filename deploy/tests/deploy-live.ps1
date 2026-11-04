$ErrorActionPreference='Continue'
$r=Join-Path $env:TEMP ('issue106-deploy-' + [guid]::NewGuid().ToString('N'))
foreach ($name in @('issue106e2e-production','traslado-production_default')) { docker network inspect $name *> $null; if ($LASTEXITCODE -eq 0) { throw "Existing network $name" } }
foreach ($name in @('traslado-production_database','issue106gatewaycfg','issue106vroomcfg')) { docker volume inspect $name *> $null; if ($LASTEXITCODE -eq 0) { throw "Existing volume $name" } }
if (docker ps -aq -f label=com.docker.compose.project=traslado-production) { throw 'Existing production project containers' }
foreach ($tag in @('issue106-api:bad','issue106-api:old','issue106-office:old','issue106-office:bad','issue106-driver:old','issue106-driver:bad')) { docker image inspect $tag *> $null; if ($LASTEXITCODE -eq 0) { throw "Existing image $tag" } }
if (docker ps -aq -f name='^issue106-config-helper$') { throw 'Existing config helper' }
$made=$false
function client([string]$command) {
 docker run --rm --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock --mount "type=bind,source=$r\work,target=/work,readonly" --mount "type=bind,source=$r\state,target=/state" --mount "type=bind,source=$r\shim,target=/shim" -e DEPLOY_ROOT=/state -e PATH=/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --entrypoint sh docker:cli -c $command | Out-Host
 return $LASTEXITCODE
}
try {
 $made=$true
 New-Item -ItemType Directory -Path $r | Out-Null
 python deploy/tests/prepare-deploy-probe.py $r
 if($LASTEXITCODE -ne 0){throw 'probe preparation failed'}
 & (Join-Path $env:ProgramFiles 'Git\bin\bash.exe') -c 'df -h /c'
 if ((Get-PSDrive C).Free -lt 1.5GB) { throw 'Less than 1.5 GB free; stopping before build' }
 docker build -t issue106-api:bad "$r\build"
 if($LASTEXITCODE -ne 0){throw 'test image build failed'}
 docker tag traslado-test-api:local issue106-api:old
 docker tag traslado-test-office:local issue106-office:old; docker tag traslado-test-office:local issue106-office:bad
 docker tag traslado-test-driver:local issue106-driver:old; docker tag traslado-test-driver:local issue106-driver:bad
 docker network create issue106e2e-production | Out-Null
 docker volume create issue106gatewaycfg | Out-Null; docker volume create issue106vroomcfg | Out-Null
 docker create --name issue106-config-helper --mount type=volume,source=issue106gatewaycfg,target=/gateway --mount type=volume,source=issue106vroomcfg,target=/conf alpine:latest true | Out-Null
 docker cp deploy/Gateway.Caddyfile issue106-config-helper:/gateway/Caddyfile
 docker cp infra/vroom/config.yml issue106-config-helper:/conf/config.yml
 docker rm issue106-config-helper | Out-Null
 $cmd='chmod +x /shim/docker; cd /work; IMAGE_TAG=old DEPLOY_PROJECT=production docker compose -p traslado-production --env-file /state/production/.env -f deploy/compose.yaml up -d db'
 if ((client $cmd) -ne 0) { throw 'database start failed' }
 $ready=$false; for($i=0;$i -lt 30;$i++){docker exec traslado-production-db-1 pg_isready -U postgres *> $null; if($LASTEXITCODE -eq 0){$ready=$true;break}; Start-Sleep 1}; if(!$ready){throw 'db not ready'}
 $cmd='cd /work; IMAGE_TAG=old DEPLOY_PROJECT=production docker compose -p traslado-production --env-file /state/production/.env -f deploy/compose.yaml run --rm --no-deps bootstrap'
 if ((client $cmd) -ne 0) { throw 'bootstrap failed' }
 if ((client 'sh /work/deploy/deploy.sh old production') -ne 0) { throw 'initial deploy failed' }
 Write-Host 'Initial deploy succeeded (pull simulated)'
 $bad=client 'sh /work/deploy/deploy.sh bad production'
 if ($bad -eq 0) { throw 'unhealthy deployment unexpectedly passed' }
 $tag=(Get-Content "$r\state\production\deployed-tag" -Raw).Trim(); if($tag -ne 'old'){throw 'recorded tag changed after failed deployment'}
 $actual=docker inspect -f '{{.Config.Image}}' traslado-production-api-1; if($actual -ne 'issue106-api:old'){throw "Wrong rollback image: $actual"}
 $table=docker exec traslado-production-db-1 psql -U postgres -d traslado -tAc "select to_regclass('public.issue106_probe')"; if($table.Trim() -ne 'issue106_probe'){throw 'forward migration missing after rollback'}
 Write-Host 'PASS: failed health restored old image while the new schema remained migrated'
} finally {
 if($made){
  client 'cd /work; IMAGE_TAG=old DEPLOY_PROJECT=production docker compose -p traslado-production --env-file /state/production/.env -f deploy/compose.yaml down -v --remove-orphans' | Out-Null
  docker rm -f issue106-config-helper *> $null
  docker volume rm issue106gatewaycfg issue106vroomcfg *> $null
  docker network rm issue106e2e-production *> $null
  docker image rm issue106-api:bad issue106-api:old issue106-office:old issue106-office:bad issue106-driver:old issue106-driver:bad *> $null
  if (Test-Path -LiteralPath $r) {
   $resolved=(Resolve-Path -LiteralPath $r).Path
   $temp=(Resolve-Path -LiteralPath $env:TEMP).Path
   if (-not $resolved.StartsWith($temp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved).StartsWith('issue106-deploy-'))) { throw 'Unsafe temporary path' }
   Remove-Item -LiteralPath $resolved -Recurse -Force
  }
 }
}
