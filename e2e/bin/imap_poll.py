#!/usr/bin/env python3

import argparse
import email
import imaplib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime
from typing import Dict, List, Optional, Tuple


LINK_RE = re.compile(r"https?://[^\s<>\"]+")
HREF_RE = re.compile(r'href=[\"\']([^\"\']+)[\"\']', re.IGNORECASE)
EMAIL_AFTER_GRACE_SECONDS = 15


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def decode_value(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipient", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--subject", action="append", default=[])
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--poll-seconds", type=int, default=5)
    parser.add_argument("--mailbox", default="INBOX")
    return parser.parse_args()


def normalize_dt(value: Optional[datetime]) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def extract_parts(message: Message) -> Tuple[str, str]:
    texts: List[str] = []
    html_parts: List[str] = []

    if message.is_multipart():
        parts = message.walk()
    else:
        parts = [message]

    for part in parts:
        if part.get_content_maintype() == "multipart":
            continue
        if part.get_content_disposition() == "attachment":
            continue

        content_type = part.get_content_type()
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"

        try:
            decoded = payload.decode(charset, errors="replace")
        except LookupError:
            decoded = payload.decode("utf-8", errors="replace")

        if content_type == "text/plain":
            texts.append(decoded)
        elif content_type == "text/html":
            html_parts.append(decoded)

    return "\n".join(texts), "\n".join(html_parts)


def clean_link(link: str) -> str:
    return link.rstrip(").,>;\"'")


def extract_links(text: str, html: str) -> List[str]:
    links: List[str] = []
    for raw_link in LINK_RE.findall(text):
        links.append(clean_link(raw_link))
    for raw_link in HREF_RE.findall(html):
        links.append(clean_link(raw_link))

    deduped: List[str] = []
    seen = set()
    for link in links:
        if link not in seen:
            deduped.append(link)
            seen.add(link)
    return deduped


def candidate_matches(
    msg: Message,
    raw_bytes: bytes,
    recipient: str,
    subject_filters: list[str],
    after_dt: datetime,
) -> Tuple[bool, Dict]:
    subject = decode_value(msg.get("Subject"))
    headers_to_check = []

    for header_name in [
        "To",
        "Delivered-To",
        "X-Original-To",
        "Envelope-To",
        "Original-Recipient",
        "Cc",
    ]:
        header_value = decode_value(msg.get(header_name))
        if header_value:
            headers_to_check.append(header_value)

    raw_lower = raw_bytes.decode("utf-8", errors="replace").lower()
    recipient_lower = recipient.lower()
    headers_blob = "\n".join(headers_to_check).lower()

    if recipient_lower not in headers_blob and recipient_lower not in raw_lower:
        return False, {}

    if subject_filters and not any(filter_value.lower() in subject.lower() for filter_value in subject_filters):
        return False, {}

    msg_date = normalize_dt(parsedate_to_datetime(msg.get("Date")) if msg.get("Date") else None)
    if msg_date < after_dt - timedelta(seconds=EMAIL_AFTER_GRACE_SECONDS):
        return False, {}

    text, html = extract_parts(msg)
    links = extract_links(text, html)
    from_values = [addr for _, addr in getaddresses(msg.get_all("From", []))]
    to_values = [addr for _, addr in getaddresses(msg.get_all("To", []))]

    return True, {
        "subject": subject,
        "date": msg_date.isoformat(),
        "from": from_values,
        "to": to_values,
        "links": links,
        "text": text,
        "html": html,
    }


def connect_imap() -> imaplib.IMAP4:
    host = require_env("IMAP_HOST")
    port = int(os.getenv("IMAP_PORT", "993"))
    user = require_env("IMAP_USER")
    password = require_env("IMAP_PASS")
    use_tls = os.getenv("IMAP_TLS", "true").lower() in {"1", "true", "yes", "on"}

    if use_tls:
        connection = imaplib.IMAP4_SSL(host, port)
    else:
        connection = imaplib.IMAP4(host, port)
    connection.login(user, password)
    return connection


def fetch_recent_message(args: argparse.Namespace) -> Optional[Dict]:
    recipient = args.recipient
    after_dt = normalize_dt(datetime.fromisoformat(args.after.replace("Z", "+00:00")))

    connection = connect_imap()
    try:
        status, _ = connection.select(args.mailbox)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox {args.mailbox}")

        status, data = connection.uid("search", None, "ALL")
        if status != "OK" or not data or not data[0]:
            return None

        matched_messages: List[Tuple[datetime, int, Dict]] = []
        uids = data[0].split()
        for uid in reversed(uids[-200:]):
            status, message_data = connection.uid("fetch", uid, "(RFC822)")
            if status != "OK" or not message_data:
                continue

            raw_bytes = None
            for item in message_data:
                if isinstance(item, tuple) and len(item) >= 2:
                    raw_bytes = item[1]
                    break

            if not raw_bytes:
                continue

            msg = email.message_from_bytes(raw_bytes)
            matched, payload = candidate_matches(
                msg,
                raw_bytes,
                recipient=recipient,
                subject_filters=args.subject,
                after_dt=after_dt,
            )
            if matched:
                uid_value = int(uid.decode("ascii", errors="ignore") or "0")
                payload_dt = normalize_dt(datetime.fromisoformat(payload["date"]))
                matched_messages.append((payload_dt, uid_value, payload))

        if matched_messages:
            matched_messages.sort(key=lambda item: (item[0], item[1]), reverse=True)
            return matched_messages[0][2]

        return None
    finally:
        try:
            connection.close()
        except Exception:
            pass
        connection.logout()


def main() -> int:
    args = parse_args()
    deadline = time.time() + args.timeout_seconds
    last_error = None

    while time.time() <= deadline:
        try:
            message = fetch_recent_message(args)
            if message:
                print(json.dumps(message))
                return 0
        except Exception as exc:
            last_error = exc

        time.sleep(args.poll_seconds)

    if last_error:
        print(str(last_error), file=sys.stderr)
        return 1

    print(
        f"No email found for {args.recipient} after {args.after} within {args.timeout_seconds} seconds",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
