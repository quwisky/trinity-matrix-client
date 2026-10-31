FROM ghcr.io/static-web-server/static-web-server:2.44.1-alpine@sha256:2fe3e5c0a20691f23fb270338578c8d31b5f7a19abb308c4c1ec901a7eefbe2e

LABEL org.opencontainers.image.title="Trinity Web" \
      org.opencontainers.image.description="Trinity Matrix client static web host" \
      org.opencontainers.image.licenses="MIT"

COPY --chown=1000:1000 sws.toml /etc/sws.toml
COPY --chown=1000:1000 LICENSE /home/sws/LICENSE
COPY --chown=1000:1000 www/ /home/sws/public/

USER sws
EXPOSE 8080
ENTRYPOINT ["static-web-server", "--config-file", "/etc/sws.toml"]
