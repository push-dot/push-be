"""provider_configs runs at bootstrap; OAuthClient's exchange/identity calls
are only reached from the unmounted auth router (dead, not tested)."""
from __future__ import annotations

from types import SimpleNamespace

from app.infrastructure.oauth import OAuthClient, provider_configs


def test_provider_configs_wire_credentials_and_official_endpoints():
    cfg = SimpleNamespace(
        google=SimpleNamespace(client_id="g-id", client_secret="g-secret"),
        github=SimpleNamespace(client_id="h-id", client_secret="h-secret"))
    out = provider_configs(cfg)
    assert set(out) == {"google", "github"}
    g, h = out["google"], out["github"]
    assert (g.client_id, g.client_secret) == ("g-id", "g-secret")
    assert (h.client_id, h.client_secret) == ("h-id", "h-secret")
    assert g.token_url == "https://oauth2.googleapis.com/token"
    assert g.auth_url.startswith("https://accounts.google.com/")
    assert h.token_url == "https://github.com/login/oauth/access_token"
    assert h.user_info_url == "https://api.github.com/user"
    for p in out.values():
        assert all(u.startswith("https://")
                   for u in (p.auth_url, p.token_url, p.user_info_url))


async def test_oauth_client_closes_cleanly():
    c = OAuthClient()
    await c.aclose()
    assert c._client.is_closed
