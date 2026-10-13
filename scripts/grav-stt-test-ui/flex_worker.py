#!/usr/bin/env python3
"""Private loopback worker which keeps Indic-Transcribe Flex warm on the pod."""

import argparse
import json
import socketserver

from flex_runner import preload_model, transcribe_file


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            request = json.loads(self.rfile.readline())
            result = transcribe_file(request["input"], request["output"])
            response = {"success": True, "result": result}
        except Exception as error:
            response = {"success": False, "error": str(error)}
        self.wfile.write((json.dumps(response, ensure_ascii=False) + "\n").encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19038)
    args = parser.parse_args()
    preload_model()
    print(json.dumps({"ready": True, "model": "Indic-Transcribe Flex"}), flush=True)
    with socketserver.TCPServer((args.host, args.port), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
