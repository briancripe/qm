#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

TAG="${LOCAL_SANDBOX_IMAGE:-qm-sandbox-beadhive:latest}"
SEATS="bh-dispatcher bh-developer bh-reviewer bh-merger"

missing=0
note() { echo "  - $1" >&2; }

for image in beadhive/core:dev qm-sandbox-local:latest; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        [ "$missing" -eq 0 ] && echo "sandbox build cannot start:" >&2
        note "image ${image} is not present locally"
        missing=1
    fi
done

if [ ! -d vendor ]; then
    [ "$missing" -eq 0 ] && echo "sandbox build cannot start:" >&2
    note "vendor/ does not exist"
    missing=1
else
    for seat in ${SEATS}; do
        if [ ! -f "vendor/${seat}" ]; then
            [ "$missing" -eq 0 ] && echo "sandbox build cannot start:" >&2
            note "vendor/${seat} is absent"
            missing=1
        fi
    done
fi

if [ "$missing" -ne 0 ]; then
    echo "" >&2
    echo "vendor/ holds the four packed seat binaries this layer installs. They are build" >&2
    echo "inputs, not artifacts of this repository, and are deliberately gitignored —" >&2
    echo "populate the directory before building." >&2
    exit 1
fi

echo "==> ${TAG}"
echo "    beadhive: ${BEADHIVE_VERSION:-0.11.0} (pypi)"
echo "    seats:    ${SEATS}"

docker buildx build \
    --platform linux/amd64 \
    --load \
    -t "${TAG}" \
    .

echo "==> done: ${TAG}"
