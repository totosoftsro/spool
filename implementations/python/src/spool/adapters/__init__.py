"""Client adapters.

Each adapter is imported on demand, so neither httpx nor requests is required to
use the core, the CLI, or the other adapter::

    from spool.adapters.httpx_adapter import SpoolReplayTransport
    from spool.adapters.requests_adapter import SpoolReplayAdapter

Adding an adapter for another client is one of the best-scoped contributions to
this project; see ``docs/contributing-adapters.md``.
"""
