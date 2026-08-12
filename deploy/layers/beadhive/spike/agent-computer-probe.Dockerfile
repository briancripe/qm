# bh-lrcw.1 spike probe — proves the beadhive layer's install recipe works inside a container.
#
# This is NOT the layer's real Dockerfile (that one is ../sandbox/Dockerfile and FROMs qm's
# own sandbox base). It exists because qm's base, fly/Dockerfile, cannot build under the
# single-UID user namespace this host is limited to: apt's http method drops privileges to
# the _apt user and setgroups(2) fails with EPERM when only one UID is mapped.
#
#   E: Method gave invalid 400 URI Failure message: Failed to setgroups - setgroups
#      (1: Operation not permitted)
#
# APT::Sandbox::User "root" disables that privilege drop. It is set HERE rather than in
# qm's fly/Dockerfile so no upstream file is modified for a spike.
#
# The bd / dolt / bh steps below are copied from ../sandbox/Dockerfile — the point is to
# exercise that recipe, not a different one. ONE deviation, marked inline: tar needs
# --no-same-owner here, because a tarball carrying uid/gid 1001 cannot be chowned when only
# one UID is mapped. That is a property of this probe's runtime, NOT a defect in the layer
# Dockerfile — an ordinary build with a full subuid range restores ownership fine.

FROM debian:12-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/00-no-sandbox \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

ARG BEADS_VERSION=1.1.2
ARG TARGETARCH=amd64

# --- bd: the bead store CLI, from the beads release ---------------------------------
RUN set -eux; \
    asset="beads_${BEADS_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    rel="https://github.com/steveyegge/beads/releases/download/v${BEADS_VERSION}"; \
    cd /tmp; \
    curl -fsSL "${rel}/${asset}" -o "$asset"; \
    curl -fsSL "${rel}/checksums.txt" -o checksums.txt; \
    grep " ${asset}\$" checksums.txt | sha256sum -c -; \
    tar --no-same-owner -xzf "$asset" -C /usr/local/bin bd; \
    rm -f "$asset" checksums.txt; \
    chmod 0755 /usr/local/bin/bd; \
    bd --version

# --- dolt: bd's embedded store engine -----------------------------------------------
RUN set -eux; \
    curl -fsSL https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash; \
    dolt version

# --- bh: the Beadhive integration-plane driver --------------------------------------
RUN set -eux; \
    curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh; \
    uv tool install --python python3 beadhive; \
    ln -sf /root/.local/share/uv/tools/beadhive/bin/bh /usr/local/bin/bh; \
    bh --version
