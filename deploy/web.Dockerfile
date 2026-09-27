# Patenter website: Caddy serves the static pages, proxies the APIs and
# gets HTTPS certificates automatically. Built from the repository root.

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
# Only the public frontend files; never the service source or .env files.
COPY index.html login.html /srv/
COPY app /srv/app
COPY shared /srv/shared
COPY images-and-other-branding /srv/images-and-other-branding
