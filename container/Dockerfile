FROM ghcr.io/static-web-server/static-web-server:2.44.0-alpine@sha256:c6704bc8f1fe05378d91c3288495ce2e0131cf31cf8956f117cb1c7d83c49c31

LABEL org.opencontainers.image.title="Trinity Web" \
      org.opencontainers.image.description="Trinity Matrix client static web host" \
      org.opencontainers.image.licenses="MIT"

COPY --chown=1000:1000 sws.toml /etc/sws.toml
COPY --chown=1000:1000 LICENSE /home/sws/LICENSE
COPY --chown=1000:1000 www/ /home/sws/public/

USER sws
EXPOSE 8080
ENTRYPOINT ["static-web-server", "--config-file", "/etc/sws.toml"]
