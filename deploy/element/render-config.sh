#!/bin/sh
# Renders Element Web's runtime config.json from the template by substituting
# the deployment's homeserver URL / server name. Runs as one of the nginx
# image's /docker-entrypoint.d hooks (alpine has no gettext envsubst, so sed
# does the substitution), AFTER the image's own 18-load-element-modules.sh has
# copied the baked-in config — the nginx config serves /config.json from
# /tmp/element-web-config, which is where this writes.
set -eu

: "${HOMESERVER_PUBLIC_URL:?HOMESERVER_PUBLIC_URL required}"
: "${MATRIX_SERVER_NAME:?MATRIX_SERVER_NAME required}"

mkdir -p /tmp/element-web-config
sed \
  -e "s|__HOMESERVER_PUBLIC_URL__|${HOMESERVER_PUBLIC_URL}|g" \
  -e "s|__MATRIX_SERVER_NAME__|${MATRIX_SERVER_NAME}|g" \
  /element-config.template.json > /tmp/element-web-config/config.json

echo "[element] config.json rendered for homeserver ${HOMESERVER_PUBLIC_URL}"
