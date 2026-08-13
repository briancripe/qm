FROM beadhive/core:dev AS beadhive

FROM qm-sandbox-local:latest

ARG AGENT_USER=bees
ARG AGENT_UID=8335
ARG AGENT_GID=8335

COPY --from=beadhive /nix /nix
COPY --from=beadhive /opt/toolchain /opt/toolchain
COPY --from=beadhive /etc/beadhive /etc/beadhive
COPY --from=beadhive /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

ENV PATH=/opt/toolchain/bin:${PATH}

RUN printf '%s\n' \
    'case ":$PATH:" in' \
    '  *":/opt/toolchain/bin:"*) ;;' \
    '  *) PATH="/opt/toolchain/bin:$PATH" ;;' \
    'esac' \
    'export PATH' \
    > /etc/profile.d/09-beadhive-toolchain-path.sh \
    && chmod 0644 /etc/profile.d/09-beadhive-toolchain-path.sh

ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

ARG BEADHIVE_VERSION=0.11.2

COPY vendor/ /tmp/vendor/

RUN set -eux; \
    uv tool install "beadhive==${BEADHIVE_VERSION}"; \
    bh --version

RUN set -eux; \
    for seat in bh-dispatcher bh-developer bh-reviewer bh-merger; do \
        install -m 0755 "/tmp/vendor/$seat" "/usr/local/bin/$seat"; \
        "/usr/local/bin/$seat" --help > /dev/null; \
    done; \
    rm -rf /tmp/vendor

ENV BH_IN_CONTAINER=1

RUN groupadd -g "${AGENT_GID}" "${AGENT_USER}" \
    && useradd -m -d "/home/${AGENT_USER}" -u "${AGENT_UID}" -g "${AGENT_GID}" \
        -s /bin/bash "${AGENT_USER}" \
    && install -d -o "${AGENT_UID}" -g "${AGENT_GID}" \
        "/home/${AGENT_USER}/workspace" \
        "/home/${AGENT_USER}/hives" \
        "/home/${AGENT_USER}/worktrees" \
        "/home/${AGENT_USER}/seats" \
        "/home/${AGENT_USER}/.beadhive" \
        "/home/${AGENT_USER}/.claude" \
        "/home/${AGENT_USER}/.codex"

ENV HOME=/home/${AGENT_USER}
USER ${AGENT_USER}
WORKDIR /home/${AGENT_USER}/workspace
CMD ["node", "/opt/microvm-agent/agent.mjs"]
