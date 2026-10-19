"""Loaded into Python clients by run.mjs (PYTHONPATH). The network-deny layer blocks the OS
resolver, so `localhost` and `*.localhost` (the harness's virtual hosts) are resolved here
to 127.0.0.1. Every other name goes to the real resolver, which the sandbox refuses."""
import socket

_real = socket.getaddrinfo


def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    # asyncio and anyio pass the host as bytes.
    name = host.decode("ascii", "ignore") if isinstance(host, bytes) else host
    if isinstance(name, str) and (name == "localhost" or name.endswith(".localhost")):
        if family in (0, socket.AF_INET):
            return _real("127.0.0.1", port, socket.AF_INET, type, proto, flags)
        raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")
    return _real(host, port, family, type, proto, flags)


socket.getaddrinfo = _getaddrinfo
