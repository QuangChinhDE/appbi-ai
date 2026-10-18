#!/usr/bin/env python3
"""Is http://localhost:3000 serving the frontend build you think it is?

Answers from evidence, layer by layer, and exits non-zero on any mismatch:

  1. expected   - the commit the deploy working copy is checked out at
                  (or --expect <sha>);
  2. listener   - exactly one thing owns the entry port: the compose `edge`
                  when the edge overlay is in use, else the `frontend` service.
                  A second frontend / a stray `next dev` on the port shows here;
  3. image      - the running frontend container's image label
                  org.opencontainers.image.revision (baked from GIT_SHA);
  4. html       - <meta name="appbi-build"> in the HTML the entry port serves;
  5. bundle     - that same SHA inside a JS chunk the HTML references — what a
                  browser actually downloads and runs (a stale bundle shows here
                  even when the HTML is fresh);
  6. backend    - /api/v1/health git_sha through the same entry port, reported
                  separately: frontend and backend are built independently and
                  are allowed to differ, but you should know when they do.

It never labels the runtime with the source HEAD: every SHA comes from the
artifact itself. Read-only: no container is touched.

Usage:
  python scripts/ops/verify_frontend_runtime.py
  python scripts/ops/verify_frontend_runtime.py --deploy-dir D:/Appv2/wt-appbi-ai-deploy --project appbi-ai
  python scripts/ops/verify_frontend_runtime.py --expect f17a148a --url http://localhost:3000
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from urllib.parse import urljoin


def sh(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=False).stdout.strip()


def fetch(url: str, timeout: float = 20) -> str:
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - local URL by design
        return r.read().decode('utf-8', 'replace')


def short(sha: str | None) -> str:
    return (sha or '')[:8] or '-'


def same(a: str | None, b: str | None) -> bool:
    if not a or not b or a == 'unknown' or b == 'unknown':
        return False
    n = min(len(a), len(b), 40)
    return n >= 7 and a[:n] == b[:n]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', default='http://localhost:3000')
    ap.add_argument('--project', default='appbi-ai', help='compose project name')
    ap.add_argument('--deploy-dir', default=None, help='working copy the stack is built from (default: the frontend container label)')
    ap.add_argument('--expect', default=None, help='expected frontend SHA (default: deploy dir HEAD)')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    rows: list[tuple[str, str, str]] = []  # (check, verdict, detail)
    fail = False

    def row(check: str, ok: bool | None, detail: str) -> None:
        nonlocal fail
        verdict = 'PASS' if ok else ('INFO' if ok is None else 'FAIL')
        if ok is False:
            fail = True
        rows.append((check, verdict, detail))

    fe = sh('docker', 'ps', '--filter', f'label=com.docker.compose.project={a.project}',
            '--filter', 'label=com.docker.compose.service=frontend', '--format', '{{.Names}}')
    fe_names = [n for n in fe.splitlines() if n]
    row('frontend containers', len(fe_names) == 1,
        f"{len(fe_names)} running: {', '.join(fe_names) or 'none'} (expected exactly one for project {a.project})")
    fe_name = fe_names[0] if fe_names else None

    deploy_dir = a.deploy_dir
    if fe_name and not deploy_dir:
        deploy_dir = sh('docker', 'inspect', fe_name, '--format',
                        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}') or None
    expected = a.expect or (sh('git', '-C', deploy_dir, 'rev-parse', 'HEAD') if deploy_dir else '')
    row('expected build', bool(expected), f"{short(expected)} ({'--expect' if a.expect else 'HEAD of ' + str(deploy_dir)})")

    # Who owns the entry port: published host ports of this project's containers.
    port = re.search(r':(\d+)', a.url.split('//', 1)[-1])
    port = port.group(1) if port else '80'
    owners = []
    for line in sh('docker', 'ps', '--format', '{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.service"}}').splitlines():
        name, ports, svc = (line.split('|') + ['', ''])[:3]
        if re.search(rf'(?:^|[ ,]|\d\.\d+\.\d+\.\d+:|\[::\]:):?{port}->', ports):
            owners.append(f'{name} ({svc or "no compose service"})')
    row(f'port {port} owner', len(owners) == 1 and any(s in owners[0] for s in ('(edge)', '(frontend)')),
        ', '.join(owners) or f'no container publishes {port} (a process outside Docker may own it)')

    image_sha = sh('docker', 'inspect', fe_name, '--format',
                   '{{index .Config.Labels "org.opencontainers.image.revision"}}') if fe_name else ''
    created = sh('docker', 'inspect', fe_name, '--format', '{{.Image}}') if fe_name else ''
    row('image label', same(image_sha, expected), f'revision={short(image_sha) or "missing"} image={created[7:19]}')

    html_sha = bundle_sha = None
    try:
        html = fetch(urljoin(a.url, '/login'))
        m = re.search(r'<meta name="appbi-build" content="([^"]*)"', html)
        html_sha = m.group(1) if m else None
        row('served HTML', same(html_sha, expected), f'<meta appbi-build>={short(html_sha) or "missing"}')
        chunks = re.findall(r'src="(/_next/static/[^"]+\.js)"', html)
        for c in chunks:
            body = fetch(urljoin(a.url, c))
            if html_sha and html_sha != 'unknown' and html_sha in body:
                bundle_sha = html_sha
                row('served bundle', same(bundle_sha, expected), f'SHA found in {c}')
                break
        else:
            row('served bundle', False, f'SHA not found in any of {len(chunks)} referenced chunks')
    except Exception as exc:  # noqa: BLE001
        row('served HTML', False, f'{a.url}/login unreachable: {exc}')

    try:
        health = json.loads(fetch(urljoin(a.url, '/api/v1/health')))
        be = health.get('git_sha') or health.get('build_sha') or 'unknown'
        row('backend (separate build)', None,
            f"git_sha={short(be)}{' (same commit)' if same(be, expected) else ' (differs from frontend - allowed, built separately)'}")
    except Exception as exc:  # noqa: BLE001
        row('backend (separate build)', None, f'health unreachable: {exc}')

    if a.json:
        print(json.dumps({'ok': not fail, 'checks': [dict(check=c, verdict=v, detail=d) for c, v, d in rows]}, indent=1))
    else:
        for c, v, d in rows:
            print(f'{v:4}  {c:26} {d}')
        print('\nfrontend runtime: ' + ('OK - serving the expected build' if not fail else 'MISMATCH - see FAIL rows'))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
