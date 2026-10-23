#!/bin/sh
# browser-mcp: Lightsail / EC2 launch script (Ubuntu 24.04).
#
# Paste this whole file into "Add launch script" (Lightsail) or "User data" (EC2) when
# creating the instance. It runs once as root on first boot and does everything:
# installs Docker, clones the repository, writes .env and starts the server with
# Caddy terminating HTTPS for $DOMAIN. No SSH needed. Progress is written to
# /var/log/browser-mcp-setup.log (readable from the console's browser shell).
#
# Lightsail wraps launch scripts in its own "#!/bin/sh" script, so this file must stay
# plain POSIX sh (no bash-only syntax). It can also be run by hand on an instance:
#   sudo sh lightsail-launch.sh
#
# Before pasting, fill in the settings below. Afterwards: give the instance a static
# IP, point the DNS A record of $DOMAIN at it, open only ports 80 and 443 in the
# Lightsail firewall, and register https://$DOMAIN/oauth/kakao/callback as a
# Redirect URI in Kakao Developers. Then https://$DOMAIN/healthz should answer.
#
# ---- settings ------------------------------------------------------------------
DOMAIN="browser.example.com"            # public host name whose DNS A record points at this instance
KAKAO_CLIENT_ID=""                      # Kakao Developers > app > platform keys > REST API key
KAKAO_CLIENT_SECRET=""                  # Kakao Developers > app > platform keys > REST API key > client secret
ALLOWED_USERS=""                        # Kakao user ids and/or e-mails, comma separated; "*" allows everyone
KAKAO_SCOPE=""                          # e.g. "account_email" when allowing users by e-mail
STATIC_TOKENS=""                        # optional "token:user,token2:user2" (16+ character random tokens)
OAUTH_CLIENTS=""                        # optional pre-registered OAuth clients for PlayMCP: "id:secret[:redirect_uri]"
REPO_URL="https://github.com/cheesecrust/browser-mcp.git"
BRANCH="main"
AUTO_UPDATE="true"                      # hourly: pull the branch and rebuild when it moved
# --------------------------------------------------------------------------------

LOG=/var/log/browser-mcp-setup.log
APP_DIR=/opt/browser-mcp

main() {
  set -eu
  export DEBIAN_FRONTEND=noninteractive

  echo "== browser-mcp setup started $(date -Is)"

  if [ "$DOMAIN" = "browser.example.com" ] || [ -z "$DOMAIN" ]; then
    echo "ERROR: set DOMAIN to your real host name before pasting the script"
    exit 1
  fi
  if [ -z "$KAKAO_CLIENT_ID" ] && [ -z "$STATIC_TOKENS" ]; then
    echo "ERROR: set KAKAO_CLIENT_ID (and KAKAO_CLIENT_SECRET) or STATIC_TOKENS, otherwise nobody can log in"
    exit 1
  fi

  # Small plans (2 GB) need swap to build the image; larger ones do not.
  mem_mb="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
  if [ "$mem_mb" -lt 3500 ] && [ ! -f /swapfile ]; then
    echo "== adding 2 GB swap (instance has ${mem_mb} MB RAM)"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  echo "== installing packages"
  apt-get update -q
  apt-get install -y -q git curl ca-certificates
  if ! command -v docker > /dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
  fi
  systemctl enable --now docker

  echo "== fetching $REPO_URL ($BRANCH)"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi

  if [ ! -f "$APP_DIR/.env" ]; then
    echo "== writing .env"
    (
      umask 077
      {
        echo "DOMAIN=$DOMAIN"
        echo "BROWSER_MCP_PUBLIC_URL=https://$DOMAIN"
        [ -n "$KAKAO_CLIENT_ID" ] && echo "BROWSER_MCP_KAKAO_CLIENT_ID=$KAKAO_CLIENT_ID"
        [ -n "$KAKAO_CLIENT_SECRET" ] && echo "BROWSER_MCP_KAKAO_CLIENT_SECRET=$KAKAO_CLIENT_SECRET"
        [ -n "$ALLOWED_USERS" ] && echo "BROWSER_MCP_ALLOWED_USERS=$ALLOWED_USERS"
        [ -n "$KAKAO_SCOPE" ] && echo "BROWSER_MCP_KAKAO_SCOPE=$KAKAO_SCOPE"
        [ -n "$STATIC_TOKENS" ] && echo "BROWSER_MCP_TOKENS=$STATIC_TOKENS"
        [ -n "$OAUTH_CLIENTS" ] && echo "BROWSER_MCP_OAUTH_CLIENTS=$OAUTH_CLIENTS"
        true
      } > "$APP_DIR/.env"
    )
  else
    echo "== keeping the existing .env"
  fi

  echo "== building and starting (first build downloads the Playwright image, a few minutes)"
  cd "$APP_DIR"
  docker compose --profile https up -d --build

  echo "== waiting for the server to report healthy"
  health=""
  for i in $(seq 1 30); do
    if health="$(curl -fs --noproxy '*' http://127.0.0.1:3000/healthz 2> /dev/null)"; then
      echo "== server healthy: $health"
      break
    fi
    sleep 2
  done
  if [ -z "$health" ]; then
    echo "WARNING: the server did not answer on port 3000 within 60 seconds; check: docker compose -f $APP_DIR/docker-compose.yml logs browser-mcp"
  fi

  if [ "$AUTO_UPDATE" = "true" ]; then
    chmod +x "$APP_DIR/deploy/update.sh"
    cat > /etc/cron.d/browser-mcp-update <<EOF
# browser-mcp: rebuild when the branch moved (installed by deploy/lightsail-launch.sh)
17 * * * * root $APP_DIR/deploy/update.sh >> /var/log/browser-mcp-update.log 2>&1
EOF
    chmod 644 /etc/cron.d/browser-mcp-update
    echo "== hourly auto-update installed (/etc/cron.d/browser-mcp-update)"
  fi

  echo "== done $(date -Is). Check https://$DOMAIN/healthz once DNS points here; logs: docker compose -f $APP_DIR/docker-compose.yml logs -f"
}

# Run main with its output both on stdout (terminal / cloud-init log) and in $LOG,
# then exit with main's own status. Pipelines only report tee's status, hence the file.
status_file="$(mktemp)"
{ (main) 2>&1; echo "$?" > "$status_file"; } | tee -a "$LOG"
status="$(cat "$status_file")"
rm -f "$status_file"
[ "${status:-1}" -eq 0 ] || exit "${status:-1}"
