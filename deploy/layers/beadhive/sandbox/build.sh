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
    if [ -z "$(ls vendor/beadhive-*.whl 2>/dev/null | head -1)" ]; then
        [ "$missing" -eq 0 ] && echo "sandbox build cannot start:" >&2
        note "vendor/ has no beadhive-*.whl"
        missing=1
    fi
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
    echo "vendor/ holds the Beadhive payloads this layer installs: the beadhive wheel and the" >&2
    echo "four packed seat binaries. They are build inputs, not artifacts of this repository," >&2
    echo "and are deliberately gitignored — populate the directory before building." >&2
    exit 1
fi

echo "==> ${TAG}"
echo "    wheel: $(basename "$(ls vendor/beadhive-*.whl | head -1)")"
echo "    seats: ${SEATS}"

docker buildx build \
    --platform linux/amd64 \
    --load \
    -t "${TAG}" \
    .

echo "==> done: ${TAG}"
