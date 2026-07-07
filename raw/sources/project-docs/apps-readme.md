# Apps

Kibitzer has three runtime app surfaces:

- `server/` - local Python server and state machine
- `extension/` - Chrome MV3 extension for observation relay and notifications
- `menubar/` - OS-native status surfaces for the local server

The server is authoritative. Extension and menu/tray surfaces follow server
actions and health state.
