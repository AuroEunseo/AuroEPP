"""서버 비밀 키 보관 공용 모듈

- Windows: DPAPI(LocalMachine)로 감싸 저장 → 키 파일을 다른 PC로 복사해도 풀 수 없음
- 그 외(개발 환경): 평문 저장 (경고용 접두어 PLAIN1)
계정 DB 암호화 키(accounts.key)와 프로그램 배포 서명 키(signing.key)가 이 모듈을 사용한다.
"""
import ctypes
import os
import sys


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DataBlob()
    CRYPTPROTECT_LOCAL_MACHINE = 0x4
    CRYPTPROTECT_UI_FORBIDDEN = 0x1
    flags = CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(blob_in), None, None, None, None, flags, ctypes.byref(blob_out))
    if not ok:
        raise OSError(f"DPAPI {'암호화' if protect else '복호화'} 실패 (오류 {ctypes.GetLastError()})")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def wrap_key(key: bytes) -> bytes:
    if sys.platform == "win32":
        return b"DPAPI1" + _dpapi(key, True)
    return b"PLAIN1" + key  # 개발(비 Windows) 환경용


def unwrap_key(blob: bytes) -> bytes:
    if blob.startswith(b"DPAPI1"):
        return _dpapi(blob[6:], False)
    if blob.startswith(b"PLAIN1"):
        return blob[6:]
    raise ValueError("알 수 없는 키 파일 형식")




def load_or_create(path: str, create) -> bytes:
    """path 의 보호된 키를 읽어 반환. 없으면 create() 로 만든 값을 보호해 저장"""
    if os.path.exists(path):
        with open(path, "rb") as f:
            return unwrap_key(f.read())
    value = create()
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(wrap_key(value))
    os.replace(tmp, path)
    return value
