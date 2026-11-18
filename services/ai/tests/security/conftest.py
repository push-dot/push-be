"""Security tests must never reach a remote host, even when the code under test regresses."""

from __future__ import annotations

import ipaddress
import socket

import pytest


def _is_local(address) -> bool:
    if not isinstance(address, tuple):
        return True  # AF_UNIX
    try:
        return ipaddress.ip_address(address[0]).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def _loopback_only(monkeypatch):
    real_connect = socket.socket.connect

    def connect(self, address):
        if not _is_local(address):
            raise AssertionError(f"security test tried to reach {address!r}")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", connect)
