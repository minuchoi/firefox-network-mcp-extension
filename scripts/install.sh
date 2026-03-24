#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Browser Bridge Setup ==="
echo ""
echo "1. Install Python dependencies:"
echo "   cd $PROJECT_DIR && uv sync"
echo ""
echo "2. Load Firefox extension:"
echo "   - Open Firefox, navigate to: about:debugging#/runtime/this-firefox"
echo "   - Click 'Load Temporary Add-on'"
echo "   - Select: $PROJECT_DIR/extension/manifest.json"
echo ""
echo "3. Configure Claude Code MCP (already done if .mcp.json exists):"
echo "   Add to .mcp.json in your project:"
cat <<EOF
   {
     "mcpServers": {
       "browser-bridge": {
         "command": "uv",
         "args": ["run", "--directory", "$PROJECT_DIR", "python", "-m", "mcp_server.server"]
       }
     }
   }
EOF
echo ""
echo "4. Verify: The extension badge should show 'ON' (green) when the MCP server is running."
