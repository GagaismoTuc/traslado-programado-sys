$ErrorActionPreference='Continue'
$env:IMAGE_TAG='local'; $env:API_IMAGE='traslado-test-api'; $env:OFFICE_IMAGE='traslado-test-office'; $env:DRIVER_IMAGE='traslado-test-driver'; $env:OSRM_IMAGE='issue106-osrm-test:local'; $env:INGRESS_PREFIX='issue106ingress'; $env:EDGE_HTTP_PORT='18080'; $env:EDGE_HTTPS_PORT='18443'; $env:CADDY_TLS='tls internal'
$projects=@('issue106probea','issue106probeb'); $made=@(); $edgeMade=$false
foreach ($resource in @('issue106probea_default','issue106probeb_default','issue106ingress-production','issue106ingress-staging')) { docker network inspect $resource *> $null; if ($LASTEXITCODE -eq 0) { throw "Existing network $resource" } }
foreach ($name in $projects) { docker volume inspect "${name}_database" *> $null; if ($LASTEXITCODE -eq 0) { throw "Existing volume $name" }; if (docker ps -aq --filter "label=com.docker.compose.project=$name") { throw "Existing containers $name" } }
if (docker ps -aq --filter 'label=com.docker.compose.project=issue106edge') { throw 'Existing edge containers' }
foreach ($vol in @('issue106edge_caddy_data','issue106edge_caddy_config')) { docker volume inspect $vol *> $null; if ($LASTEXITCODE -eq 0) { throw "Existing volume $vol" } }
try {
 $edgeMade=$true
 docker compose -p issue106edge --env-file deploy/.env.example -f deploy/edge.compose.yaml up -d
 if ($LASTEXITCODE -ne 0) { throw 'edge startup failed' }
 for ($j=0;$j -lt 2;$j++) {
    $name=$projects[$j]; $env:DEPLOY_PROJECT=@('production','staging')[$j]; $made += $name
    docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml up -d db
    if ($LASTEXITCODE -ne 0) { throw 'db startup failed' }
    $ready=$false
    for ($i=0;$i -lt 30;$i++) { docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml exec -T db pg_isready -U postgres *> $null; if ($LASTEXITCODE -eq 0) { $ready=$true; break }; Start-Sleep 1 }
    if (!$ready) { throw 'database unavailable' }
    docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml run --rm --no-deps bootstrap
    if ($LASTEXITCODE -ne 0) { throw 'bootstrap failed' }
    docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml run --rm --no-deps migrate
    if ($LASTEXITCODE -ne 0) { throw 'migration failed' }
    docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml up -d
    if ($LASTEXITCODE -ne 0) { throw 'stack failed' }
    $ready=$false
    for ($i=0;$i -lt 40;$i++) { "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" | docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml exec -T api node *> $null; if ($LASTEXITCODE -eq 0) { $ready=$true; break }; Start-Sleep 1 }
    if (!$ready) { throw 'internal health failed' }
    Write-Host "$name internal health OK with mock OSRM"
 }
 foreach ($hostName in @('production.example.invalid','staging.example.invalid')) {
   $ready=$false
   for($i=0;$i -lt 30;$i++){ curl.exe --noproxy '*' -fsSk --resolve "${hostName}:18443:127.0.0.1" "https://${hostName}:18443/api/health" *> $null; if($LASTEXITCODE -eq 0) {$ready=$true;break}; Start-Sleep 1 }
   if(!$ready){docker logs --tail 30 issue106edge-edge-1;throw "HTTPS health failed for $hostName"}
   Write-Host "$hostName HTTPS health OK with mock OSRM"
 }
 $ip=docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' issue106probea-db-1
 "const net=require('net');let c=net.connect(5432,'$ip');c.setTimeout(3000);c.on('connect',()=>process.exit(0));c.on('error',()=>process.exit(1));c.on('timeout',()=>process.exit(1));" | docker exec -i issue106probea-api-1 node
 if ($LASTEXITCODE -ne 0) { throw 'Production database positive control failed' }
 $probe="const net=require('net');let c=net.connect(5432,'$ip');c.setTimeout(3000);c.on('connect',()=>process.exit(1));c.on('error',()=>process.exit(0));c.on('timeout',()=>process.exit(0));"
 $probe | docker exec -i issue106probeb-api-1 node
 if ($LASTEXITCODE -ne 0) { throw 'Staging reached production database IP' }
 "require('dns').lookup('issue106probea-db-1',(e)=>process.exit(e?0:1))" | docker exec -i issue106probeb-api-1 node
 if ($LASTEXITCODE -ne 0) { throw 'Staging resolved production database name' }
 Write-Host 'Staging could not connect to production database IP or resolve its container name'
} finally {
 foreach ($name in $made) { $env:DEPLOY_PROJECT=if($name -eq 'issue106probea') {'production'} else {'staging'}; docker compose -p $name --env-file deploy/.env.example -f deploy/compose.yaml down -v --remove-orphans }
 if($edgeMade){docker compose -p issue106edge --env-file deploy/.env.example -f deploy/edge.compose.yaml down -v --remove-orphans}
}
