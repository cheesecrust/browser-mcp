#!/bin/sh
# Container entrypoint. When a visible (non-headless) browser is requested and there is no
# display, start Xvfb in the background and point DISPLAY at it; then run the server.
# Xvfb is started directly rather than through xvfb-run: xvfb-run waits for a SIGUSR1 from
# the X server, which is not delivered reliably to PID 1 inside a container, so it can hang
# before the server ever starts.
set -eu

headless="$(printf %s "${BROWSER_MCP_HEADLESS:-1}" | tr '[:upper:]' '[:lower:]')"
case "$headless" in
  0 | false | no | off)
    if [ -z "${DISPLAY:-}" ]; then
      if command -v Xvfb > /dev/null 2>&1; then
        screen="${BROWSER_MCP_XVFB_SCREEN:-1280x720x24}"
        display=":99"
        echo "browser-mcp: visible browser requested; starting Xvfb on $display ($screen)" >&2
        Xvfb "$display" -screen 0 "$screen" -nolisten tcp -ac +extension GLX +render -noreset &
        export DISPLAY="$display"
        # Wait (up to ~5 s) for the X socket before launching anything that needs it.
        i=0
        while [ ! -S "/tmp/.X11-unix/X${display#:}" ] && [ "$i" -lt 50 ]; do
          i=$((i + 1))
          sleep 0.1
        done
        if [ -S "/tmp/.X11-unix/X${display#:}" ]; then
          echo "browser-mcp: Xvfb ready on $display" >&2
        else
          echo "browser-mcp: Xvfb did not come up within 5 s; continuing anyway" >&2
        fi
      else
        echo "browser-mcp: BROWSER_MCP_HEADLESS=$headless but neither DISPLAY nor Xvfb is available" >&2
      fi
    fi
    ;;
esac
exec "$@"
