# Extension Lib

Shared extension helpers live here.

- `serverConnection.ts` discovers and validates the local server port.
- `api.ts` sends product requests through that validated connection.
- `domainFilter.ts` mirrors the server's sensitive-domain pre-drop rules.
