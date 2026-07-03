#!/usr/bin/env sh
# Deploy the static site to the chilos.dev server.
#
# Adjust HOST (ssh user@host) and DOCROOT (where nginx should serve from),
# then run: ./deploy.sh
#
# The current chilos.dev responds 405 to HEAD, which suggests nginx is
# proxying to an app server rather than serving static files. To serve this
# static site instead, point the server block at DOCROOT, e.g.:
#
#   server {
#     server_name chilos.dev;
#     root /var/www/chilos.dev;
#     index index.html;
#     location / { try_files $uri $uri/ =404; }
#   }
#
set -eu

HOST="${1:-david@45.32.95.66}"
DOCROOT="${2:-/var/www/chilos.dev}"

ssh "$HOST" "mkdir -p '$DOCROOT'"
rsync -av --delete site/ "$HOST:$DOCROOT/"
echo "Deployed to $HOST:$DOCROOT"
