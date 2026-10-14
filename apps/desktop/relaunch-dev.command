#!/bin/bash
cd "$(dirname "$0")"
pkill -f "apps/cloud-agent-gateway" 2>/dev/null
pkill -f "apps/desktop-agent" 2>/dev/null
sleep 1
npm start
