#!/bin/bash
cd "$(dirname "$0")"
npm run start > /tmp/mobiusx-electron.log 2>&1
