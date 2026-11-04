import json
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1])
(root / 'work').mkdir()
(root / 'state' / 'production').mkdir(parents=True)
(root / 'shim').mkdir()
(root / 'build').mkdir()
shutil.copytree('deploy', root / 'work' / 'deploy')
compose = root / 'work' / 'deploy' / 'compose.yaml'
text = compose.read_text(encoding='ascii')
text = text.replace('./Gateway.Caddyfile:/etc/caddy/Caddyfile:ro', 'issue106gatewaycfg:/etc/caddy:ro')
text = text.replace('../infra/vroom/config.yml:/conf/config.yml:ro', 'issue106vroomcfg:/conf')
text = text.replace('volumes:\n  database:\n', 'volumes:\n  database:\n  issue106gatewaycfg:\n    external: true\n  issue106vroomcfg:\n    external: true\n')
compose.write_text(text, encoding='ascii', newline='\n')
env = pathlib.Path('deploy/.env.example').read_text(encoding='ascii')
env += '\nAPI_IMAGE=issue106-api\nOFFICE_IMAGE=issue106-office\nDRIVER_IMAGE=issue106-driver\nOSRM_IMAGE=issue106-osrm-test:local\nINGRESS_PREFIX=issue106e2e\n'
(root / 'state' / 'production' / '.env').write_text(env, encoding='ascii', newline='\n')
(root / 'shim' / 'docker').write_text('#!/bin/sh\ncase " $* " in *" pull "*) echo "TEST: simulated pull of local tags"; exit 0;; esac\nexec /usr/local/bin/docker "$@"\n', encoding='ascii', newline='\n')
journal = json.loads(pathlib.Path('packages/api/drizzle/meta/_journal.json').read_text(encoding='utf-8'))
journal['entries'].append({'idx': len(journal['entries']), 'version': '7', 'when': 9999999999999, 'tag': '0016_issue106_probe', 'breakpoints': True})
(root / 'build' / '_journal.json').write_text(json.dumps(journal), encoding='ascii')
(root / 'build' / '0016_issue106_probe.sql').write_text('CREATE TABLE issue106_probe (id integer);\n', encoding='ascii', newline='\n')
(root / 'build' / 'Dockerfile').write_text('FROM traslado-test-api:local\nCOPY _journal.json /app/packages/api/drizzle/meta/_journal.json\nCOPY 0016_issue106_probe.sql /app/packages/api/drizzle/0016_issue106_probe.sql\nCMD ["node", "-e", "setInterval(()=>{}, 100000)"]\n', encoding='ascii', newline='\n')
