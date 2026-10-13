import json
import sys

from ytmusicapi import YTMusic


def main():
    query = sys.argv[1]
    limit = int(sys.argv[2])
    results = YTMusic().search(query, filter="songs", limit=limit)
    print(json.dumps(results[:limit], ensure_ascii=False))


if __name__ == "__main__":
    main()
