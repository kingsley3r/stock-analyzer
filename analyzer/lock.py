"""Encrypts the dashboard data with your password, so only you can read it.

The website is public, but the files on it are scrambled (AES-256-GCM).
Your phone unscrambles them after you type the password. The password itself
is never stored on the website: a key is derived from it with PBKDF2."""
from __future__ import annotations

import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 310_000  # makes guessing passwords slow


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class Locker:
    def __init__(self, password: str, salt: bytes | None = None):
        self.salt = salt or os.urandom(16)
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=self.salt, iterations=ITERATIONS)
        self.key = kdf.derive(password.encode("utf-8"))

    def seal(self, obj) -> dict:
        iv = os.urandom(12)
        ct = AESGCM(self.key).encrypt(iv, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), None)
        return {"v": 1, "iv": b64(iv), "ct": b64(ct)}

    def header(self) -> dict:
        return {"v": 1, "kdf": "PBKDF2-SHA256", "iterations": ITERATIONS, "salt": b64(self.salt)}

    def open(self, sealed: dict):  # used by the tests
        data = AESGCM(self.key).decrypt(base64.b64decode(sealed["iv"]), base64.b64decode(sealed["ct"]), None)
        return json.loads(data)
