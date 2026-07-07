# Core Pipeline

Core code is source-neutral. It receives `Observation` objects and returns `PipelineResult` actions.

## Must Not Know

- Chrome APIs
- notification UI details
- FastAPI request objects
- page extraction mechanics

## Owns

- normalization contract
- relevance calculation
- anchor updates
- tier cascade decisions
- controller update and intervention gating

