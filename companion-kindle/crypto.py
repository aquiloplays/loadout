"""Windows DPAPI encryption for at-rest secrets (session cookies, the ingest
secret). Uses CryptProtectData / CryptUnprotectData via ctypes so we add no
pywin32 dependency. Data is bound to the current Windows user account, it
cannot be decrypted by another user or on another machine.

Off Windows (dev / CI) it falls back to an obfuscation-only base64 wrap so the
modules import and unit tests run; real secrets are only ever stored on Clay's
Windows box where DPAPI is active.
"""
import base64
import os

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.windll.crypt32
    _kernel32 = ctypes.windll.kernel32

    def _blob(data: bytes) -> _DATA_BLOB:
        buf = ctypes.create_string_buffer(data, len(data))
        return _DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))

    def _blob_bytes(blob: _DATA_BLOB) -> bytes:
        return ctypes.string_at(blob.pbData, blob.cbData)

    def encrypt(data: bytes) -> bytes:
        out = _DATA_BLOB()
        if not _crypt32.CryptProtectData(ctypes.byref(_blob(data)), None, None, None, None, 0, ctypes.byref(out)):
            raise OSError("CryptProtectData failed")
        try:
            return _blob_bytes(out)
        finally:
            _kernel32.LocalFree(out.pbData)

    def decrypt(data: bytes) -> bytes:
        out = _DATA_BLOB()
        if not _crypt32.CryptUnprotectData(ctypes.byref(_blob(data)), None, None, None, None, 0, ctypes.byref(out)):
            raise OSError("CryptUnprotectData failed")
        try:
            return _blob_bytes(out)
        finally:
            _kernel32.LocalFree(out.pbData)
else:
    # Non-Windows fallback: NOT real encryption, just keeps the API working
    # off the target platform. The companion only ships for Windows.
    def encrypt(data: bytes) -> bytes:
        return base64.b64encode(data)

    def decrypt(data: bytes) -> bytes:
        return base64.b64decode(data)
