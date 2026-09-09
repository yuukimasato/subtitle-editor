#!/usr/bin/env python3
"""http.server with COOP/COEP headers to enable crossOriginIsolation for jassub pthread testing."""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8749


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
