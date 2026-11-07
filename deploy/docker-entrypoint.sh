#!/bin/sh
# Container entrypoint. When a visible (non-headless) browser is requested and there is no
# display, run Xvfb next to the server and point DISPLAY at it; otherwise just run the server.
#
# - Xvfb is started directly rather than through xvfb-run: xvfb-run waits for a SIGUSR1 from
#   the X server, which is not delivered reliably to PID 1 inside a container, so it can hang
#   before the server ever starts.
# - A restarted container ("docker compose restart", Docker's restart policy) keeps its /tmp, so
#   the lock file and socket of the previous Xvfb are still there. Xvfb then exits at once with
#   "(EE) Server is already active for display 99", and every browser launch fails later with
#   "Looks like you launched a headed browser without having a XServer running". The stale files
#   are removed before each start, and readiness is judged by the Xvfb process being alive, not
#   by the socket file existing.
# - Xvfb is supervised: when it exits, it is started again (browsers open at that moment die
#   with it; the server launches a new one on the next tool call). When the server exits, the
#   container exits with its status.
set -eu

headless="$(printf %s "${BROWSER_MCP_HEADLESS:-1}" | tr '[:upper:]' '[:lower:]')"
case "$headless" in
  0 | false | no | off) ;;
  *) exec "$@" ;;
esac
if [ -n "${DISPLAY:-}" ]; then
  exec "$@"
fi
if ! command -v Xvfb > /dev/null 2>&1; then
  echo "browser-mcp: BROWSER_MCP_HEADLESS=$headless but neither DISPLAY nor Xvfb is available" >&2
  exec "$@"
fi

screen="${BROWSER_MCP_XVFB_SCREEN:-1920x1080x24}"
display=":99"
lock="/tmp/.X${display#:}-lock"
socket="/tmp/.X11-unix/X${display#:}"
export DISPLAY="$display"

# True while the process is running (a zombie child that has not been waited for does not count).
alive() {
  if [ -d /proc ]; then
    [ -r "/proc/$1/status" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status"
  else
    kill -0 "$1" 2> /dev/null
  fi
}

# Starts Xvfb and waits (up to ~5 s) for its socket. Returns 1 when Xvfb exited instead.
start_xvfb() {
  rm -f "$lock" "$socket"
  echo "browser-mcp: visible browser requested; starting Xvfb on $display ($screen)" >&2
  Xvfb "$display" -screen 0 "$screen" -nolisten tcp -ac +extension GLX +render -noreset &
  xvfb_pid=$!
  i=0
  while [ "$i" -lt 50 ]; do
    if ! alive "$xvfb_pid"; then
      wait "$xvfb_pid" 2> /dev/null || true
      echo "browser-mcp: Xvfb exited right after starting (its message is above)" >&2
      return 1
    fi
    if [ -S "$socket" ]; then
      echo "browser-mcp: Xvfb ready on $display" >&2
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done
  echo "browser-mcp: Xvfb did not come up within 5 s; continuing anyway" >&2
  return 0
}

if ! start_xvfb; then
  echo "browser-mcp: a visible browser needs Xvfb; not starting the server without it" >&2
  exit 1
fi

"$@" &
app_pid=$!
forward() { kill -s "$1" "$app_pid" 2> /dev/null || true; }
trap 'forward TERM' TERM
trap 'forward INT' INT

xvfb_failed=0
while alive "$app_pid"; do
  if [ "$xvfb_failed" -eq 0 ] && ! alive "$xvfb_pid"; then
    wait "$xvfb_pid" 2> /dev/null || true
    echo "browser-mcp: Xvfb exited; starting it again" >&2
    if ! start_xvfb; then
      echo "browser-mcp: Xvfb could not be restarted; stopping the server" >&2
      xvfb_failed=1
      forward TERM
    fi
  fi
  sleep 1
done

status=0
wait "$app_pid" || status=$?
kill "$xvfb_pid" 2> /dev/null || true
exit "$status"
