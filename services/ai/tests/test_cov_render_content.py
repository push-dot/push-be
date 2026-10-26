from __future__ import annotations

import pytest

from app.domain.content import code_point_slice, validate_document_content
from app.domain.entities import Block
from app.domain.errors import DomainError


def _para(bid, text, marks=None):
    node = {"type": "text", "text": text}
    if marks is not None:
        node["marks"] = marks
    return {"type": "paragraph", "attrs": {"blockId": bid}, "content": [node]}


def _doc(*nodes):
    return {"type": "doc", "content": list(nodes)}


def _error(content, blocks=()):
    with pytest.raises(DomainError) as e:
        validate_document_content(content, list(blocks))
    assert e.value.status == 400
    return e.value


def test_rejects_non_dict_content():
    assert "TipTap" in _error("not json").message


@pytest.mark.parametrize("href,msg", [
    ("javascript:alert(1)", "http(s)"),
    ("ftp://example.com/x", "http(s)"),
    ("https://user:pw@example.com/", "credentials"),
    ("https://", "host"),
])
def test_link_marks_must_be_safe_http_urls(href, msg):
    content = _doc(_para("b1", "x", [{"type": "link", "attrs": {"href": href}}]))
    assert msg in _error(content, [Block(id="b1", text="x")]).message


def test_link_mark_without_href_and_unknown_marks_rejected():
    assert "href" in _error(_doc(_para("b1", "x", [{"type": "link", "attrs": {}}]))).message
    assert "href" in _error(_doc(_para("b1", "x", [{"type": "link"}]))).message
    assert "unsupported mark type bold" in _error(
        _doc(_para("b1", "x", [{"type": "bold"}]))).message


def test_valid_link_mark_passes():
    content = _doc(_para("b1", "site", [{"type": "link", "attrs": {"href": "https://a.example/"}}]))
    validate_document_content(content, [Block(id="b1", text="site")])


@pytest.mark.parametrize("attrs", [None, {}, {"blockId": ""}])
def test_block_nodes_require_block_id(attrs):
    node = {"type": "heading", "content": [{"type": "text", "text": "x"}]}
    if attrs is not None:
        node["attrs"] = attrs
    assert "heading requires attrs.blockId" in _error(_doc(node)).message


def test_duplicate_block_ids_in_content_rejected():
    assert "duplicate blockId b1" in _error(_doc(_para("b1", "a"), _para("b1", "b"))).message


def test_blocks_must_have_ids_and_match_content():
    content = _doc(_para("b1", "a"))
    assert "block id is required" in _error(content, [Block(id="", text="a")]).message
    assert "has no matching content node" in _error(content, [Block(id="zz", text="a")]).message
    assert "text does not match" in _error(content, [Block(id="b1", text="other")]).message
    assert "has no matching block" in _error(content, []).message
    dup = [Block(id="b1", text="a"), Block(id="b1", text="a")]
    assert "duplicate block id b1" in _error(content, dup).message


def test_nested_list_items_are_blocks_with_concatenated_text():
    item = {"type": "listItem", "attrs": {"blockId": "li"},
            "content": [_para("p", "inner")]}
    content = _doc({"type": "bulletList", "content": [item]})
    validate_document_content(content, [Block(id="li", text="inner"), Block(id="p", text="inner")])


@pytest.mark.parametrize("s,start,end,expected", [
    ("가나다", 0, 2, "가나"),
    ("가나다", 1, 3, "나다"),
    ("abc", 0, 4, None),
    ("abc", 3, 4, None),
    ("abc", -1, 2, None),
    ("abc", 2, 2, None),
])
def test_code_point_slice_bounds(s, start, end, expected):
    assert code_point_slice(s, start, end) == expected

