"""
Quality Email Service
=====================
Sends the Quality Report PDF (produced by `quality_report_pdf`) to configured
recipients via SMTP. Uses the stdlib `smtplib` + `email` modules so no extra
dependency is required.

Graceful degradation:
  • When SMTP_HOST is empty, `send_quality_report` is a no-op that returns
    False and logs a warning. This keeps scheduled runs working in local /
    preview environments without an SMTP provider.
  • Any transient SMTP error is caught and logged; it never bubbles up into
    the scheduler thread.
"""
from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Iterable, List, Optional

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _normalize_recipients(values: Iterable[Optional[str]]) -> List[str]:
    seen: set[str] = set()
    out: List[str] = []
    for v in values:
        if not v:
            continue
        email = str(v).strip().lower()
        if not email or email in seen:
            continue
        seen.add(email)
        out.append(email)
    return out


def send_quality_report(
    *,
    subject: str,
    html_body: str,
    text_body: str,
    primary_recipient: Optional[str],
    cc_recipients: Optional[List[str]] = None,
    pdf_bytes: Optional[bytes] = None,
    pdf_filename: str = "quality-report.pdf",
) -> bool:
    """
    Send the quality report via SMTP. Returns True on success, False if the
    email was skipped (missing configuration) or delivery failed.
    """
    to_list = _normalize_recipients([primary_recipient])
    cc_list = [e for e in _normalize_recipients(cc_recipients or []) if e not in to_list]

    if not to_list:
        logger.warning("[quality_email] No primary recipient — skip delivery.")
        return False

    if not settings.smtp_enabled:
        logger.warning(
            "[quality_email] SMTP_HOST is empty — skip delivery to %s (cc=%s).",
            to_list,
            cc_list,
        )
        return False

    from_email = settings.smtp_from_email
    if not from_email:
        logger.error("[quality_email] SMTP_FROM_EMAIL/SMTP_USERNAME is not configured — cannot send.")
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((settings.SMTP_FROM_NAME or "AppBI", from_email))
    msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg["Message-ID"] = make_msgid(domain=from_email.split("@", 1)[-1] or "appbi.local")

    msg.set_content(text_body or "Please view this report in an HTML-capable email client.")
    msg.add_alternative(html_body, subtype="html")

    if pdf_bytes:
        msg.add_attachment(
            pdf_bytes,
            maintype="application",
            subtype="pdf",
            filename=pdf_filename,
        )

    all_rcpts = to_list + cc_list

    try:
        if settings.SMTP_USE_SSL:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(
                settings.SMTP_HOST,
                settings.SMTP_PORT,
                timeout=settings.SMTP_TIMEOUT_SECONDS,
                context=context,
            ) as smtp:
                if settings.SMTP_USERNAME:
                    smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                smtp.send_message(msg, from_addr=from_email, to_addrs=all_rcpts)
        else:
            with smtplib.SMTP(
                settings.SMTP_HOST,
                settings.SMTP_PORT,
                timeout=settings.SMTP_TIMEOUT_SECONDS,
            ) as smtp:
                smtp.ehlo()
                if settings.SMTP_USE_TLS:
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                if settings.SMTP_USERNAME:
                    smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                smtp.send_message(msg, from_addr=from_email, to_addrs=all_rcpts)
    except Exception as exc:  # noqa: BLE001
        logger.error("[quality_email] Failed to send to %s (cc=%s): %s", to_list, cc_list, exc)
        return False

    logger.info(
        "[quality_email] Sent to %s (cc=%s) subject=%r", to_list, cc_list, subject
    )
    return True
