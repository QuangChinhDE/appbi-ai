# -*- coding: utf-8 -*-
"""`audience` is a runtime contract, not a rendering hint.

An author diagnostic names a node key, a configuration and a remedy — maintenance
detail a viewer cannot act on. Before this it travelled in every reader response
and was merely not styled differently, so a reader surface that rendered its
notices at all showed it.

INVARIANT: author notices do not leave the server on a reader boundary; author
surfaces receive both and present them apart. Frontend filtering is defence in
depth, not the boundary.
"""
from app.services.agent_flows.envelope import Notice, reader_notices


def author(code="read_exceeds_context"):
    return Notice(code=code, text="x", audience="author", severity="warning",
                  node_key="overview", remedies=["làm gì đó"])


def reader(code="memory_reset"):
    return Notice(code=code, text="y")


def test_an_author_notice_is_dropped_at_the_reader_boundary():
    assert reader_notices([author()]) == []


def test_a_reader_notice_survives():
    n = reader()
    assert reader_notices([n]) == [n]


def test_a_mixed_list_keeps_only_reader_notices():
    out = reader_notices([reader("a"), author(), reader("b")])
    assert [n.code for n in out] == ["a", "b"]


def test_a_legacy_notice_with_no_audience_is_treated_as_reader():
    """The backend default is `reader`; an older stored notice carries no field at
    all. Dropping those would silently remove working reader notices."""
    legacy = Notice(code="charts_unreadable", text="cũ")
    assert legacy.audience == "reader"
    assert reader_notices([legacy]) == [legacy]


def test_the_two_reader_dispatch_paths_filter_and_the_author_path_does_not():
    """Structural, and deliberately so: which dispatch site filters is the whole
    contract, and a behavioural test of all three needs a live run."""
    import inspect

    from app.services.agent_flows import dispatch

    src = inspect.getsource(dispatch)
    for fn in ("run_for_link", "run_for_chat_thread"):
        body = src[src.index("async def %s(" % fn):]
        body = body[:body.index("\nasync def ", 10)] if "\nasync def " in body[10:] else body
        assert "reader_notices(" in body, f"{fn} is a reader surface and does not filter"

    preview = src[src.index("async def run_preview("):]
    preview = preview[:preview.index("\nasync def ", 10)]
    assert "reader_notices(" not in preview, (
        "run_preview is the AUTHOR surface — filtering there would hide the "
        "diagnostics Studio Test exists to show"
    )


def test_stored_thread_history_is_filtered_for_the_reader():
    """Turns recorded before the boundary existed are replayed through the same
    reader path, so the filter cannot trust what was written."""
    import inspect

    from app.services.agent_flows import direct_chat

    src = inspect.getsource(direct_chat)
    assert '"audience", "reader") != "author"' in src


# ── recorded in full, sent filtered ─────────────────────────────────────────

def test_to_dict_can_narrow_notices_without_changing_the_envelope():
    """DEFECT FOUND IN THE BROWSER. The reader filter ran BEFORE `runs_service
    .record`, so a real viewer's turn stored the reader's copy and the author's
    diagnostics were gone forever. Studio Test showed them for questions the
    author asked themselves; Runs showed none for actual traffic — the opposite
    of where an author needs them.

    The wire copy narrows; the object keeps everything."""
    from app.services.agent_flows.envelope import FlowOutput, text_answer

    out = FlowOutput(run_id="r1", status="ok", answer=text_answer("xong"),
                     notices=[reader("memory_reset"), author()])
    wire = out.to_dict(notices=reader_notices(out.notices))

    assert [n["code"] for n in wire["notices"]] == ["memory_reset"]
    assert [n.code for n in out.notices] == ["memory_reset", "read_exceeds_context"], (
        "narrowing the wire copy must not mutate the envelope that gets recorded"
    )
    assert out.to_dict()["notices"][1]["audience"] == "author"


def test_the_reader_paths_narrow_on_send_and_record_the_full_set():
    import inspect

    from app.services.agent_flows import dispatch

    src = inspect.getsource(dispatch)
    for fn in ("run_for_link", "run_for_chat_thread"):
        body = src[src.index("async def %s(" % fn):]
        body = body[:body.index("\nasync def ", 10)] if "\nasync def " in body[10:] else body
        assert "to_dict(notices=reader_notices(" in body, (
            f"{fn} must narrow the SENT envelope"
        )
        assert "out.notices = reader_notices(" not in body, (
            f"{fn} filters before recording — the author loses diagnostics for "
            f"real viewer traffic"
        )
