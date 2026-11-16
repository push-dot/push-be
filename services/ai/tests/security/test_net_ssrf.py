"""SSRF through Bot link reading: every URL a user or a page can hand the fetcher."""

from __future__ import annotations

import asyncio
import socket

import httpcore
import httpx
import pytest
from httpcore._backends.auto import AutoBackend

from app.ingest import web_page


def _answers(monkeypatch, *rounds: list[str]) -> list[str]:
    """Fake DNS: each lookup returns the next round of addresses. Returns the hosts asked."""
    asked: list[str] = []
    queue = list(rounds)

    def getaddrinfo(host, *_args, **_kwargs):
        asked.append(host)
        ips = queue.pop(0) if len(queue) > 1 else queue[0]
        return [
            (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))
            for ip in ips
        ]

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    return asked


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://2130706433/",
        "http://0x7f.1/",
        "http://127.1/",
        "http://0/",
        "http://0.0.0.0/",
        "http://[::]/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:7f00:1]/",
        "http://[::127.0.0.1]/",
        "http://[fe80::1%25en0]/",
        "http://[fd00::1]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::ffff:a9fe:a9fe]/",
        "http://[64:ff9b::a9fe:a9fe]/",
        "http://[2002:7f00:1::]/",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.0.1/",
        "http://100.64.0.1/",
        "http://198.18.0.1/",
        "http://224.0.0.1/",
        "http://255.255.255.255/",
        "http://localhost/",
        "http://LOCALHOST./",
        "http://metadata.google.internal/",
        "http://redis.internal/",
        "http://box.local/",
    ],
)
def test_net_private_and_encoded_hosts_are_refused(monkeypatch, url):
    _answers(monkeypatch, ["127.0.0.1"])
    with pytest.raises(ValueError):
        web_page._assert_public_sync(url)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://93.184.216.34/",
        "ftp://93.184.216.34/",
        "http://user:pw@93.184.216.34/",
        "http://93.184.216.34\\@127.0.0.1/",
    ],
)
def test_net_non_http_schemes_and_credentials_are_refused(url):
    with pytest.raises(ValueError):
        web_page._assert_public_sync(url)


def test_net_a_name_with_one_private_record_is_refused(monkeypatch):
    _answers(monkeypatch, ["93.184.216.34", "10.0.0.5"])
    with pytest.raises(ValueError):
        web_page._assert_public_sync("https://mixed.example/")


@pytest.mark.parametrize(
    "url",
    [
        "https://93.184.216.34:22/",
        "https://93.184.216.34:3000/",
        "http://93.184.216.34:6379/",
        "http://93.184.216.34:5432/",
        "https://93.184.216.34:8080/",
    ],
)
def test_net_ports_other_than_web_are_refused(url):
    # The VPS's own public IP passes the private-range check; its other ports are internal services.
    with pytest.raises(ValueError, match="port"):
        web_page._assert_public_sync(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://93.184.216.34/",
        "https://93.184.216.34:443/",
        "http://93.184.216.34/",
        "http://93.184.216.34:80/",
    ],
)
def test_net_web_ports_stay_allowed(url):
    assert web_page._assert_public_sync(url) == ["93.184.216.34"]


async def test_net_dns_rebinding_dials_the_address_that_was_checked(monkeypatch):
    # First answer is public and passes the check; a second lookup would rebind to loopback.
    asked = _answers(monkeypatch, ["93.184.216.34"], ["127.0.0.1"])
    dialed: list[str] = []

    async def connect_tcp(self, host, port, *_args, **_kwargs):
        dialed.append(host)
        raise httpcore.ConnectError("stub network")

    monkeypatch.setattr(AutoBackend, "connect_tcp", connect_tcp)
    with pytest.raises(httpx.ConnectError):
        await web_page.fetch_page("https://rebind.example/job")
    assert asked == ["rebind.example"]
    assert dialed == ["93.184.216.34"]


_open_connection = asyncio.open_connection


async def _connect_line(port: int, target: str) -> bytes:
    reader, writer = await _open_connection("127.0.0.1", port)
    writer.write(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    await writer.drain()
    line = await reader.readline()
    writer.close()
    return line


@pytest.mark.parametrize(
    "target",
    [
        "93.184.216.34:22",
        "93.184.216.34:3000",
        "93.184.216.34:6379",
        "127.0.0.1:443",
        "[::1]:443",
        "169.254.169.254:80",
        "localhost:443",
    ],
)
async def test_net_browser_proxy_refuses_internal_targets_and_ports(monkeypatch, target):
    _answers(monkeypatch, ["127.0.0.1"])
    dialed: list[tuple] = []

    async def refuse(*args, **_kwargs):
        dialed.append(args)
        raise OSError("no network in tests")

    monkeypatch.setattr(asyncio, "open_connection", refuse)
    server, port = await web_page._start_egress_proxy()
    try:
        assert b"403" in await _connect_line(port, target)
        assert dialed == []
    finally:
        server.close()
        await server.wait_closed()
