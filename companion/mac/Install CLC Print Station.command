#!/bin/sh
set -eu
umask 077
BUNDLE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$BUNDLE/python/bin/python3" -B -E -s "$BUNDLE/clc_station_manager.py" install --bundle "$BUNDLE" "$@"
