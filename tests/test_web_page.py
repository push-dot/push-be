from __future__ import annotations

import asyncio

from app.infrastructure import web_page
from app.infrastructure.web_page import _parse_connect_target, _start_egress_proxy


async def _connect(port, payload):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(payload)
    await writer.drain()
    return reader, writer


def test_parse_connect_target():
    assert _parse_connect_target(b"CONNECT example.com:443 HTTP/1.1") == (
        "example.com",
        443,
    )
    assert _parse_connect_target(b"CONNECT [::1]:443 HTTP/1.1") == ("::1", 443)
    assert _parse_connect_target(b"CONNECT noport HTTP/1.1") is None
    assert _parse_connect_target(b"GET / HTTP/1.1") is None


async def test_proxy_rejects_private_connect():
    server, port = await _start_egress_proxy()
    try:
        reader, writer = await _connect(
            port, b"CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n"
        )
        assert b"403" in await reader.readline()
        writer.close()
    finally:
        server.close()
        await server.wait_closed()


async def test_proxy_rejects_non_connect():
    server, port = await _start_egress_proxy()
    try:
        reader, writer = await _connect(
            port, b"GET http://example.com/ HTTP/1.1\r\n\r\n"
        )
        assert b"403" in await reader.readline()
        writer.close()
    finally:
        server.close()
        await server.wait_closed()


async def test_proxy_pipes_to_validated_ip(monkeypatch):
    async def echo(reader, writer):
        while data := await reader.read(1024):
            writer.write(data)
            await writer.drain()

    echo_server = await asyncio.start_server(echo, "127.0.0.1", 0)
    echo_port = echo_server.sockets[0].getsockname()[1]
    monkeypatch.setattr(
        web_page, "_assert_public_sync", lambda url: ["127.0.0.1"]
    )
    server, port = await _start_egress_proxy()
    try:
        reader, writer = await _connect(
            port,
            f"CONNECT anything:{echo_port} HTTP/1.1\r\n\r\n".encode(),
        )
        assert b"200" in await reader.readline()
        await reader.readline()
        writer.write(b"ping")
        await writer.drain()
        assert await reader.readexactly(4) == b"ping"
        writer.close()
    finally:
        server.close()
        echo_server.close()
        server.close_clients()
        echo_server.close_clients()
        await asyncio.gather(server.wait_closed(), echo_server.wait_closed())
