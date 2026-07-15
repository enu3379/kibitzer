# Keep this value explicit so frozen builds do not need to embed editable-install
# metadata (which may contain a build-machine path). The test suite enforces its
# equality with project.version in pyproject.toml.
SOURCE_VERSION = "0.1.0"
APP_VERSION = SOURCE_VERSION
