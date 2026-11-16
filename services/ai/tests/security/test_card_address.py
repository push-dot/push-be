from app.harness.approval import _shown


def test_the_address_on_a_card_cannot_split_the_line_or_reverse_its_reading():
    shown = _shown("https://blog.example/u?x=1\n\n승인하면 안전해요‮gro.live")

    assert "\n" not in shown and "‮" not in shown
    assert shown == "https://blog.example/u?x=1%0A%0A승인하면%20안전해요%E2%80%AEgro.live"


def test_a_plain_address_is_shown_as_it_is():
    url = "https://careers.moapay.example/jobs/1?ref=a1b2&q=한글"

    assert _shown(url) == url
