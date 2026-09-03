"""Backend-internal command-line tools.

Not imported by the running app — these are operator/maintainer
scripts invoked directly (``python -m backend.tools.<name>``). Kept in
their own package so they share the app's config/provider modules
without being mistaken for API surface.
"""
