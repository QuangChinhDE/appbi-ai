"""Create the two document fixtures the eval set could not honestly fake.

`scanned_pdf` and `contradictory_docs` were listed as NOT COVERED for a reason:
there was no scanned document in the corpus, and no genuinely conflicting pair.
Inventing a probe against text that does not exist would have measured the
invention. So the fixtures are created — through the application's own API, the
same way a person would, so they exercise upload, extraction, OCR, the index
queue and the retrieval path rather than a hand-written row.

They are named with a `[EVAL]` prefix and live in their own space so they are
obvious in the library and easy to remove.

    python backend/eval/seed_eval_fixtures.py --api http://localhost:8000 \
        --email admin@appbi.io --password ...
    python backend/eval/seed_eval_fixtures.py --cleanup
"""
from __future__ import annotations

import argparse
import io
import json
import time
import urllib.error
import urllib.request

SPACE = "Kiểm thử truy hồi"
PREFIX = "[EVAL]"

#: A conflict a real knowledge base produces: an old SLA target left in a
#: superseded runbook while the current policy says something else. Both are
#: Published, both are authored, and nothing in the text says which wins — the
#: reader has to be told there is a disagreement rather than handed one number.
CONTRADICTION_A = """# Chính sách SLA giao hàng (bản hiện hành)

## Mục tiêu giao đúng hẹn
Mục tiêu tỷ lệ giao đúng hẹn của toàn hệ thống là **95%**, áp dụng từ Quý III.

Đây là con số được Ban điều hành phê duyệt và là mức dùng để đánh giá KPI vận hành.
"""

CONTRADICTION_B = """# Sổ tay vận hành kho (bản cũ)

## Ngưỡng giao đúng hẹn
Ngưỡng tỷ lệ giao đúng hẹn dùng trong sổ tay này là **88%**.

Con số này được dùng cho báo cáo nội bộ của kho và chưa cập nhật theo chính sách mới.
"""

SCANNED_LINES = [
    "BIEN BAN KIEM KE KHO QUY III",
    "Tong so kien hang kiem ke: 1842 kien",
    "So kien thieu hut: 7 kien",
    "Nguoi lap bien ban: Tran Van Kho",
]


def _scanned_pdf(lines) -> bytes:
    """A PDF containing only a PICTURE of text — no text layer, so only OCR reads it."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1700, 700), "white")
    draw = ImageDraw.Draw(image)
    y = 60
    for line in lines:
        draw.text((40, y), line, fill="black")
        y += 44
    image = image.resize((image.width * 2, image.height * 2), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format="PDF", resolution=200.0)
    return buf.getvalue()


class Api:
    def __init__(self, base: str, token: str | None = None):
        self.base = base.rstrip("/") + "/api/v1"
        self.token = token

    def call(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.base + path, method=method, data=data, headers=headers)
        try:
            raw = urllib.request.urlopen(req).read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            return {"_status": exc.code, "_body": exc.read().decode("utf-8")[:300]}

    def upload(self, path: str, filename: str, blob: bytes):
        boundary = "----appbiEvalFixture"
        body = (
            ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
             "Content-Type: application/pdf\r\n\r\n" % (boundary, filename)).encode()
            + blob
            + ("\r\n--%s--\r\n" % boundary).encode()
        )
        req = urllib.request.Request(
            self.base + path, method="POST", data=body,
            headers={
                "Content-Type": "multipart/form-data; boundary=%s" % boundary,
                "Authorization": "Bearer " + (self.token or ""),
            },
        )
        try:
            raw = urllib.request.urlopen(req).read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            return {"_status": exc.code, "_body": exc.read().decode("utf-8")[:300]}


def _publish(api: Api, doc_id: int) -> None:
    """Publish the LATEST version.

    `/publish` takes an explicit version and makes that one live — the working
    draft is deliberately left alone, so v1 can stay published while v2 is being
    written. Calling it without a version therefore published v1, which for the
    scanned document was the empty snapshot taken before the upload: the editor
    showed the OCR text and the index stayed empty. The version has to be named.
    """
    doc = api.call("GET", "/catalog/govern/knowledge/%d" % doc_id)
    version = int(doc.get("version") or 1)
    api.call("POST", "/catalog/govern/knowledge/%d/publish" % doc_id,
             {"version": version, "change_note": "eval fixture"})


def _wait_indexed(api: Api, doc_id: int, seconds: float = 40.0) -> dict:
    """Indexing is queued now, so the fixture is not ready when the save returns."""
    deadline = time.time() + seconds
    last: dict = {}
    while time.time() < deadline:
        last = api.call("GET", "/catalog/govern/knowledge/%d/embedding-config" % doc_id)
        job = last.get("index_job") or {}
        if job.get("state") in ("done", "error") and (last.get("chunk_count") or 0) > 0:
            return last
        time.sleep(1.5)
    return last


def seed(api: Api) -> dict:
    created: dict[str, int] = {}

    for key, title, body in (
        ("contradiction_current", "%s Chính sách SLA giao hàng (hiện hành)" % PREFIX, CONTRADICTION_A),
        ("contradiction_stale", "%s Sổ tay vận hành kho (bản cũ)" % PREFIX, CONTRADICTION_B),
    ):
        doc = api.call("PUT", "/catalog/govern/knowledge",
                       {"title": title, "body": body, "space": SPACE, "status": "Published"})
        if "id" not in doc:
            print("  FAILED %s: %s" % (key, doc))
            continue
        created[key] = doc["id"]
        _publish(api, doc["id"])
        state = _wait_indexed(api, doc["id"])
        print("  %s -> doc %s, %s chunk(s)" % (key, doc["id"], state.get("chunk_count")))

    doc = api.call("PUT", "/catalog/govern/knowledge",
                   {"title": "%s Biên bản kiểm kê kho (bản scan)" % PREFIX,
                    "body": "", "space": SPACE, "status": "Published"})
    if "id" in doc:
        doc_id = doc["id"]
        created["scanned"] = doc_id
        api.upload("/catalog/govern/knowledge/%d/source/upload" % doc_id,
                   "bien-ban-kiem-ke.pdf", _scanned_pdf(SCANNED_LINES))
        # Read the extracted text back and SAVE it, then publish.
        #
        # Uploading writes `body` without bumping the version, and retrieval
        # serves the PUBLISHED snapshot — so publishing straight after an upload
        # publishes the version that existed BEFORE it, which for a new document
        # is empty. The first run of this script produced a document whose editor
        # showed the OCR text and whose index was empty, with only `index_stale`
        # hinting at why. Worth knowing about the product, not just the fixture.
        current = api.call("GET", "/catalog/govern/knowledge/%d" % doc_id)
        chars = len(current.get("body") or "")
        api.call("PUT", "/catalog/govern/knowledge",
                 {"id": doc_id, "title": current.get("title"),
                  "space": SPACE, "body": current.get("body") or "",
                  "status": "Published"})
        _publish(api, doc_id)
        state = _wait_indexed(api, doc_id)
        print("  scanned -> doc %s, upload extracted ~%s chars, %s chunk(s)"
              % (doc_id, chars, state.get("chunk_count")))
        if not state.get("chunk_count"):
            print("     (if this is 0, OCR did not run — check tesseract in the image)")
    else:
        print("  FAILED scanned: %s" % doc)

    return created


def cleanup(api: Api) -> None:
    docs = (api.call("GET", "/catalog/govern/knowledge") or {}).get("docs") or []
    for doc in docs:
        if str(doc.get("title", "")).startswith(PREFIX):
            api.call("DELETE", "/catalog/govern/knowledge/%d" % doc["id"])
            print("  removed doc %s %s" % (doc["id"], doc["title"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--email", default="admin@appbi.io")
    parser.add_argument("--password", default="123456")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()

    api = Api(args.api)
    login = api.call("POST", "/auth/login", {"email": args.email, "password": args.password})
    if "access_token" not in login:
        raise SystemExit("login failed: %s" % login)
    api.token = login["access_token"]

    if args.cleanup:
        cleanup(api)
        return
    print("seeding eval fixtures into space %r" % SPACE)
    created = seed(api)
    print(json.dumps(created, indent=2))


if __name__ == "__main__":
    main()
