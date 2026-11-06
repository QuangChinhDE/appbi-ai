# One runtime of the Public Report Claude pool: the UNMODIFIED Claude Code binary from
# Anthropic's installer, shown in the report's panel through ttyd. Run with a read-only root
# and tmpfs home/tmp (see docker-compose): every recycle starts from a clean filesystem.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates ttyd socat locales tini python3-minimal \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color
RUN useradd -m -s /bin/bash viewer
# Install Claude Code into an image path (the home is a tmpfs at run time).
USER viewer
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && mkdir -p /home/viewer/.local/share \
    && cp -aL /home/viewer/.local/bin/claude /tmp/claude-bin
USER root
RUN install -m 0755 /tmp/claude-bin /usr/local/bin/claude && rm -f /tmp/claude-bin
COPY agent.py /opt/runtime/agent.py
COPY start.sh /opt/runtime/start.sh
RUN chmod 0755 /opt/runtime/start.sh
USER viewer
WORKDIR /home/viewer
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/runtime/start.sh"]
