"""Python twin of probe.mjs, run inside the wrapper by canary.mjs."""
import asyncio
import json
import os
import socket
import urllib.request

PORT = int(os.environ["CANARY_HARNESS_PORT"])


def attempt(fn):
    try:
        fn()
        return "ok"
    except Exception as e:  # noqa: BLE001
        reason = getattr(e, "reason", e)
        return getattr(reason, "errno", None) and f"errno{reason.errno}" or type(reason).__name__


def get(url):
    return attempt(lambda: urllib.request.urlopen(url, timeout=5).read())


def async_get(url):
    """httpx is what the Python payer uses; it resolves through asyncio (host as bytes)."""
    import httpx

    async def go():
        async with httpx.AsyncClient(timeout=5) as c:
            await c.get(url)

    return attempt(lambda: asyncio.run(go()))


def tcp(host, port):
    return attempt(lambda: socket.create_connection((host, port), timeout=5).close())


print(
    json.dumps(
        {
            "public:fetch": get("http://example.com/"),
            "public:fetch-ip": get("http://93.184.216.34/"),
            "public:dns": attempt(lambda: socket.getaddrinfo("example.com", 80)),
            "public:tcp-name": tcp("example.com", 80),
            "public:tcp-ip": tcp("93.184.216.34", 80),
            "harness:fetch-ip": get(f"http://127.0.0.1:{PORT}/"),
            "harness:fetch-localhost-name": get(f"http://provider.test.localhost:{PORT}/"),
            "harness:httpx-localhost-name": async_get(f"http://provider.test.localhost:{PORT}/"),
            "harness:tcp": tcp("127.0.0.1", PORT),
        }
    )
)
