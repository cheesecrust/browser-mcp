#!/bin/sh
# Container entrypoint. When a visible (non-headless) browser is requested and there is no
# display, start the server under Xvfb so Chrome gets a window; otherwise run it as is.
set -eu

headless="$(printf %s "${BROWSER_MCP_HEADLESS:-1}" | tr '[:upper:]' '[:lower:]')"
case "$headless" in
  0 | false | no | off)
    if [ -z "${DISPLAY:-}" ]; then
      if command -v xvfb-run > /dev/null 2>&1; then
        echo "browser-mcp: visible browser requested; starting under Xvfb (${BROWSER_MCP_XVFB_SCREEN:-1280x720x24})" >&2
        exec xvfb-run -a --server-args="-screen 0 ${BROWSER_MCP_XVFB_SCREEN:-1280x720x24} -nolisten tcp" "$@"
      fi
      echo "browser-mcp: BROWSER_MCP_HEADLESS=$headless but neither DISPLAY nor xvfb-run is available" >&2
    fi
    ;;
esac
exec "$@"
