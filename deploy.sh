#!/usr/bin/env sh
# Deploy the static site to the chilos.dev server.
#
# Usage: ./deploy.sh <ssh-user@host> [docroot]
# e.g.:  ./deploy.sh you@example.com /var/www/chilos.dev
#
# HOST (ssh user@host) is required. DOCROOT defaults to /var/www/chilos.dev.
# The docroot is typically root-owned, so you may need --rsync-path="sudo rsync".
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

HOST="${1:?usage: ./deploy.sh <ssh-user@host> [docroot]}"
DOCROOT="${2:-/var/www/chilos.dev}"

ssh "$HOST" "mkdir -p '$DOCROOT'"
rsync -av --delete site/ "$HOST:$DOCROOT/"
echo "Deployed to $HOST:$DOCROOT"
