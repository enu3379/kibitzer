# Menu Bar Apps

OS-native status surfaces live here.

- `macos/`: Swift `NSStatusItem` menu bar app for macOS.

These apps observe the local server state through `GET /health`. They do not own
judging state or duplicate the server pipeline.
