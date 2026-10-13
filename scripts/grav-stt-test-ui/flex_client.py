#!/usr/bin/env python3
"""One private loopback request client for ``flex_worker.py``."""

import argparse
import json
import socket


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19038)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.connect((args.host, args.port))
        client.sendall((json.dumps({"input": args.input, "output": args.output}) + "\n").encode())
        print(client.makefile("r", encoding="utf-8").readline(), end="")


if __name__ == "__main__":
    main()
