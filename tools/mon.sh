#!/bin/bash
# VRAM (whole GPU) + deepsea Chrome RAM
nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$(dirname "$0")/chrome_mem.ps1")" 2>/dev/null | sort -k2 -n -r | head -4
