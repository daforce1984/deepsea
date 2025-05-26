@echo off
echo Starting Python HTTP server on port 8888...
echo Attempting to open index.html in your default browser at http://localhost:8888/index.html
echo If the browser opens before the server is ready, please refresh the browser page after a few moments.
echo.

REM Start the default web browser pointing to the local server address
start "" "http://localhost:8888/index.html"

REM Start the Python HTTP server
REM This command will keep running in this window until manually closed (Ctrl+C or closing the window)
python -m http.server 8888

echo.
echo Server has been stopped.
pause
