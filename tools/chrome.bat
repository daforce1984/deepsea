@echo off
REM Visible debug Chrome for the DeepSea WebGPU game (dedicated profile, single reused test tab).
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\chrome_automation\deepsea" --remote-debugging-port=9031 --remote-allow-origins=* --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required --window-size=1440,900 about:blank
