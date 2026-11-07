#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$EUID" == 0 ]] || { echo 'Run the Nginx installer as root.' >&2; exit 1; }
mode="${1:-http}"
[[ "$mode" == http || "$mode" == tls ]] || { echo 'Usage: install-nginx.sh [http|tls]' >&2; exit 1; }
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site=/etc/nginx/sites-available/booran-sales-floor
enabled=/etc/nginx/sites-enabled/booran-sales-floor
acme=/var/www/booran/shared/acme
install -d -m 0755 "$acme/.well-known/acme-challenge"

if [[ -e "$enabled" && ! -L "$enabled" ]]; then
  echo "Expected $enabled to be a symlink." >&2
  exit 1
fi
if [[ -L "$enabled" && "$(readlink -f "$enabled")" != "$site" ]]; then
  echo "Unexpected existing Nginx symlink $enabled." >&2
  exit 1
fi

activate() {
  local candidate backup linked=false had_site=false
  candidate="$(mktemp)"
  backup="$(mktemp)"
  cat "$source_dir/nginx-http.conf" > "$candidate"
  if [[ "$1" == tls ]]; then
    printf '\n' >> "$candidate"
    cat "$source_dir/nginx-https.conf" >> "$candidate"
  fi
  if [[ -f "$site" ]]; then cp "$site" "$backup"; had_site=true; fi
  install -m 0644 "$candidate" "$site"
  if [[ ! -L "$enabled" ]]; then ln -s "$site" "$enabled"; linked=true; fi
  if ! nginx -t || ! systemctl reload nginx; then
    if "$linked"; then unlink "$enabled"; fi
    if "$had_site"; then install -m 0644 "$backup" "$site"; else unlink "$site"; fi
    unlink "$candidate"
    unlink "$backup"
    return 1
  fi
  unlink "$candidate"
  unlink "$backup"
}

web=booran-sales-floor.goodshowroom.com
api=booran-sales-floor-backend.goodshowroom.com
has_certs() {
  [[ -r "/etc/letsencrypt/live/$web/fullchain.pem" && -r "/etc/letsencrypt/live/$api/fullchain.pem" ]]
}
if has_certs; then activate tls; else activate http; fi

if [[ "$mode" == tls ]]; then
  args=(certonly --webroot -w "$acme" --non-interactive --agree-tos --keep-until-expiring --deploy-hook 'systemctl reload nginx')
  if [[ -n "${CERTBOT_EMAIL:-}" ]]; then args+=(--email "$CERTBOT_EMAIL"); fi
  certbot "${args[@]}" --cert-name "$web" -d "$web" -d "www.$web"
  certbot "${args[@]}" --cert-name "$api" -d "$api" -d "www.$api"
  activate tls
fi
