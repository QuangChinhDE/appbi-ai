"""What a provider failure MEANS, in one vocabulary for every vendor.

"API key không hợp lệ" was the answer to a dozen different problems: a key with
no access to the chosen model, a model the vendor retired, a parameter a
reasoning model rejects, an account out of quota. Each needs a different fix, so
each gets its own code, and the reader is told the fix — never the raw body,
which can carry request details.

The adapters attach `code` (and `retryable`) to their `error` events; the
credential checks return the same codes. Callers that only read `text` keep
working: the code is additive.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

#: code -> (Vietnamese explanation, what to do)
MESSAGES: dict[str, tuple[str, str]] = {
    "invalid_credentials": ("Nhà cung cấp từ chối API key.",
                            "Kiểm tra lại key trong AI Keys, hoặc tạo key mới."),
    "no_entitlement": ("API key hợp lệ nhưng không có quyền dùng model này.",
                       "Chọn model khác, hoặc bật quyền model này cho tài khoản của key."),
    "unknown_model": ("Nhà cung cấp không nhận ra model này.",
                      "Chọn một model khác trong danh sách."),
    "model_unavailable": ("Nhà cung cấp không cho key này dùng model — model không tồn tại với key, "
                          "hoặc key chưa được cấp quyền (nhà cung cấp không nói rõ là trường hợp nào).",
                          "Kiểm tra model trong danh sách của nhà cung cấp và quyền của tài khoản key."),
    "retired_model": ("Model này đã bị nhà cung cấp ngừng hỗ trợ.",
                      "Chuyển bước sang model thay thế được đề xuất."),
    "unsupported_parameter": ("Model không chấp nhận một tham số của yêu cầu.",
                              "Đây là lỗi tương thích của AppBI với model này — báo quản trị viên."),
    "unsupported_endpoint": ("Model không hỗ trợ cổng API đang gọi.",
                             "Đây là lỗi tương thích của AppBI với model này — báo quản trị viên."),
    "unsupported_tools": ("Model không hỗ trợ gọi công cụ theo cách này.",
                          "Chọn model có hỗ trợ công cụ cho bước dùng công cụ."),
    "rate_limited": ("Nhà cung cấp đang giới hạn tốc độ của key.",
                     "Đợi vài chục giây rồi thử lại."),
    "quota_exhausted": ("Tài khoản của key đã hết hạn mức/tín dụng.",
                        "Nạp thêm hạn mức cho tài khoản nhà cung cấp, hoặc dùng key khác."),
    "timeout": ("Model không trả lời kịp.", "Thử lại; nếu lặp lại, chọn model nhanh hơn."),
    "provider_outage": ("Nhà cung cấp đang gặp sự cố.", "Thử lại sau ít phút."),
    "truncated": ("Câu trả lời bị cắt vì chạm giới hạn độ dài đầu ra.",
                  "Thu hẹp câu hỏi; nếu lặp lại, báo quản trị viên."),
    "stream_interrupted": ("Kết nối tới nhà cung cấp bị ngắt giữa chừng.", "Thử lại."),
    "bad_request": ("Nhà cung cấp từ chối yêu cầu.", "Báo quản trị viên kèm thời điểm lỗi."),
}

RETRYABLE = {"rate_limited", "timeout", "provider_outage", "stream_interrupted"}


@dataclass(frozen=True)
class ProviderError:
    code: str
    http_status: int
    detail: str = ""

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE

    def text(self, label: str, model: str = "") -> str:
        what, fix = MESSAGES.get(self.code, MESSAGES["bad_request"])
        where = f"{label}{f' / {model}' if model else ''}"
        return f"{where}: {what} {fix}"

    def extra(self) -> dict:
        return {"http_status": self.http_status, "code": self.code, "retryable": self.retryable}


def _body_fields(body: bytes | str) -> tuple[str, str, str]:
    """(code, type, message) from a vendor error body, lower-cased."""
    try:
        obj = json.loads(body) if body else {}
    except (ValueError, TypeError):
        return "", "", (body.decode(errors="replace") if isinstance(body, bytes) else str(body)).lower()
    if isinstance(obj, list) and obj:
        obj = obj[0]
    err = obj.get("error") if isinstance(obj, dict) else None
    if not isinstance(err, dict):
        err = obj if isinstance(obj, dict) else {}
    code = str(err.get("code") or err.get("status") or "").lower()
    kind = str(err.get("type") or "").lower()
    msg = str(err.get("message") or "").lower()
    reasons = " ".join(str((d or {}).get("reason") or "") for d in (err.get("details") or [])
                       if isinstance(d, dict)).lower()
    return code, f"{kind} {reasons}".strip(), msg


def classify(status: int, body: bytes | str = b"") -> ProviderError:
    """One vendor HTTP failure → one code. Order matters: the most specific first."""
    code, kind, msg = _body_fields(body)
    blob = f"{code} {kind} {msg}"
    if "insufficient_quota" in blob or "exceeded your current quota" in blob or "credit balance" in blob \
            or "billing" in blob and status in (400, 402, 403, 429):
        return ProviderError("quota_exhausted", status, msg[:200])
    if status == 401 or "invalid_api_key" in blob or "api_key_invalid" in blob or "authentication_error" in blob \
            or "api key not valid" in blob or "pass a valid api key" in blob:
        return ProviderError("invalid_credentials", status, msg[:200])
    if "deprecated" in blob and ("model" in blob) or "has been retired" in blob or "no longer available" in blob \
            or "was shut down" in blob or "has been shut down" in blob:
        return ProviderError("retired_model", status, msg[:200])
    if "model_not_found" in blob or ("model" in blob and ("does not exist" in blob or "not found" in blob)) \
            or (status == 404 and "model" in blob):
        # OpenAI answers 404 model_not_found both for an unknown name and for a
        # model the key may not use; "do not have access" separates the two.
        # "does not exist OR you do not have access" names neither case; saying
        # either would be a guess. The caller that KNOWS the model exists (it is
        # catalogued from the vendor's own docs) narrows it to no_entitlement.
        if "or you do not have access" in blob:
            return ProviderError("model_unavailable", status, msg[:200])
        if "access" in blob or "permission" in blob:
            return ProviderError("no_entitlement", status, msg[:200])
        return ProviderError("unknown_model", status, msg[:200])
    if status == 403 or "permission_denied" in blob or "permission_error" in blob \
            or "do not have access" in blob:
        return ProviderError("no_entitlement", status, msg[:200])
    if status == 429 or "rate_limit" in blob or "resource_exhausted" in blob:
        return ProviderError("rate_limited", status, msg[:200])
    if "only supported in v1/responses" in blob or "use the responses api" in blob \
            or "not supported in the v1/chat/completions" in blob or "endpoint" in blob and "not supported" in blob:
        return ProviderError("unsupported_endpoint", status, msg[:200])
    if ("tool" in blob or "function" in blob) and ("not supported" in blob or "unsupported" in blob):
        return ProviderError("unsupported_tools", status, msg[:200])
    if "unsupported_parameter" in blob or "unsupported parameter" in blob or "unsupported_value" in blob \
            or "unrecognized request argument" in blob or "is not supported with this model" in blob \
            or "extra inputs are not permitted" in blob:
        return ProviderError("unsupported_parameter", status, msg[:200])
    if status in (408, 504):
        return ProviderError("timeout", status, msg[:200])
    if status >= 500 or status == 529:
        return ProviderError("provider_outage", status, msg[:200])
    return ProviderError("bad_request", status, msg[:200])
