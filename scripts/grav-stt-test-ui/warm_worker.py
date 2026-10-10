#!/usr/bin/env python3
"""Private loopback worker that keeps the temporary STT models warm.

It is deliberately not an HTTP service. It binds only within the pod; the
local tester reaches it through the existing SSH connection.
"""

import argparse
import json
import socketserver

from runner import preload_runtime, transcribe_file


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            request = json.loads(self.rfile.readline())
            result = transcribe_file(request["input"], request["output"])
            response = {"success": True, "result": result}
        except Exception as error:  # Return diagnostics to the private tester only.
            response = {"success": False, "error": str(error)}
        self.wfile.write((json.dumps(response, ensure_ascii=False) + "\n").encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19037)
    args = parser.parse_args()
    preload_seconds = preload_runtime()
    print(json.dumps({"ready": True, "preloadSeconds": preload_seconds}), flush=True)
    with socketserver.TCPServer((args.host, args.port), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
