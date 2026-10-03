#!/usr/bin/env python3
"""Dev-only static server for the ?test=1 screenshot harness (not part of the game).

Serves the repo root with no caching, plus POST /save?dir=ref|cur&name=X which stores the PNG at
test/<dir>/X.png. For dir=cur it also compares bytes to test/ref/X.png and replies {"same": bool}.
Run from anywhere:  python3 test/serve.py   (then open http://localhost:8765/?test=1)
"""
import json, os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        q = parse_qs(urlparse(self.path).query)
        d, name = q['dir'][0], os.path.basename(q['name'][0])
        if d not in ('ref', 'cur'):
            self.send_error(400); return
        data = self.rfile.read(int(self.headers['Content-Length']))
        os.makedirs(f'test/{d}', exist_ok=True)
        with open(f'test/{d}/{name}.png', 'wb') as f: f.write(data)
        out = {}
        if d == 'cur' and os.path.exists(f'test/ref/{name}.png'):
            with open(f'test/ref/{name}.png', 'rb') as f: out['same'] = f.read() == data
        body = json.dumps(out).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a): pass

ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
