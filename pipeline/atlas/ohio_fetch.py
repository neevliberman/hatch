"""Fetch the few small files the Ohio butterfly trends need from the 1 GB Dryad deposit, without downloading it.

Source: Wepprich, Adrion, Ries, Wiedmann & Haddad (2019) "Butterfly abundance declines over 20 years of systematic
monitoring in Ohio, USA", PLoS ONE 14(7): e0216270, doi:10.1371/journal.pone.0216270. Data: Dryad
doi:10.5061/dryad.cf78420 (CC0), one zip of 1,041,221,812 bytes. Dryad's own download API now needs a bearer token
and its web download answers 403 to scripts, so this reads Dryad's Zenodo copy of the same deposit (record 4993851,
same DOI, same md5 976799bca220a8356354e113d5672288) with HTTP range requests: the zip's central directory (the last
400 KB), then each wanted member's bytes. About 18 MB in all, cached in notebooks/data/ohio/ (git-ignored).

Checked twice: each member's CRC-32 against the zip's directory as it is extracted, and each cached file's SHA-256
against SHA256 below, the files this code was first run on (3 Nov 2026). A cached file that fails is fetched again;
a fetched file that fails is an error. Network calls retry with backoff.

  python3 pipeline/atlas/ohio_fetch.py           # fills the cache; checks and keeps what is already there
  python3 pipeline/atlas/ohio_fetch.py --force   # fetches everything again
"""
import hashlib
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "notebooks/data/ohio"
URL = "https://zenodo.org/api/records/4993851/files/dryad_butterfly_trends.zip/content"
SIZE = 1_041_221_812
SHA256 = {
    "allpops.csv": "6da9f13ca0ceb7691e50b3695880c7316dad66a1c53702cb0416e5ada716c51b",
    "species_names.csv": "fe265849586b8e0a5c253369d16691ab0ffe6328804a5a4aa0243c49fa31ae7e",
    "speciesTrends.csv": "980103f6da135cf43fa2edda0f9361e0ea69ec5031b2494df7362456f8880e5c",
    "unique_surveys.csv": "f9eda2f193f040d0d45a95a8e719e1236baa547e3506a054bffb9b4b579e0a58",
    "sampling_covariates.csv": "1ed00c086de08c8cd54eb2522f6199b52154095051e0dfb617817848beb010ec",
    "OHsites2018update.txt": "a0d38ae8e2f92e8a969afa2c08ef216acd1a61989f6c19adaa5a238b6a6513bb",
}
WANTED = tuple(SHA256)
TRIES = 5


def _get(start: int, end: int, tries: int = TRIES, sleep=time.sleep, opener=urllib.request.urlopen) -> bytes:
    """Bytes start..end (inclusive) of the zip, retried with backoff (1, 2, 4, 8 s) on network errors."""
    req = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}", "User-Agent": "hatch-pipeline"})
    for k in range(tries):
        try:
            with opener(req, timeout=120) as r:
                if r.status != 206:
                    raise RuntimeError(f"expected a partial response, got {r.status}")
                data = r.read()
            if len(data) != end - start + 1:
                raise urllib.error.URLError(f"short read: {len(data)} of {end - start + 1} bytes")
            return data
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if k == tries - 1:
                raise
            print(f"  retrying after: {e}", file=sys.stderr)
            sleep(2 ** k)
    raise AssertionError("unreachable")


def central_directory(tail: bytes, tail_start: int) -> dict:
    """Member name -> (local header offset, compressed size, method, CRC-32), from the zip's last bytes (zip64 aware)."""
    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("no end-of-central-directory record")
    n, cd_size, cd_off = struct.unpack("<HII", tail[eocd + 10:eocd + 20])
    loc = tail.rfind(b"PK\x06\x07", 0, eocd)
    if loc >= 0 and (cd_off == 0xFFFFFFFF or n == 0xFFFF):
        z64 = struct.unpack("<Q", tail[loc + 8:loc + 16])[0] - tail_start
        n, cd_size, cd_off = struct.unpack("<QQQ", tail[z64 + 32:z64 + 56])
    cd = tail[cd_off - tail_start:cd_off - tail_start + cd_size]
    out, p = {}, 0
    while p < len(cd) and cd[p:p + 4] == b"PK\x01\x02":
        method = struct.unpack("<H", cd[p + 10:p + 12])[0]
        crc, csize, usize = struct.unpack("<III", cd[p + 16:p + 28])
        nlen, xlen, clen = struct.unpack("<HHH", cd[p + 28:p + 34])
        off = struct.unpack("<I", cd[p + 42:p + 46])[0]
        name = cd[p + 46:p + 46 + nlen].decode("utf-8", "replace")
        extra = cd[p + 46 + nlen:p + 46 + nlen + xlen]
        q = 0
        while q + 4 <= len(extra):  # zip64 extended information: only the fields that overflowed are present
            tag, ln = struct.unpack("<HH", extra[q:q + 4])
            if tag == 1:
                vals, r = [], q + 4
                for flag in (usize, csize, off):
                    if flag == 0xFFFFFFFF:
                        vals.append(struct.unpack("<Q", extra[r:r + 8])[0])
                        r += 8
                    else:
                        vals.append(flag)
                usize, csize, off = vals
            q += 4 + ln
        out[name] = (off, csize, method, crc)
        p += 46 + nlen + xlen + clen
    return out


def member(off: int, csize: int, method: int, crc: int, get=_get) -> bytes:
    head = get(off, off + 29)
    nlen, xlen = struct.unpack("<HH", head[26:30])
    raw = get(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize - 1)
    if method == 0:
        data = raw
    elif method == 8:
        data = zlib.decompress(raw, -15)
    else:
        raise ValueError(f"zip method {method}")
    if zlib.crc32(data) != crc:
        raise ValueError(f"CRC-32 mismatch at offset {off}")
    return data


def good(path: Path) -> bool:
    return path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == SHA256[path.name]


def fetch(force: bool = False) -> Path:
    todo = [w for w in WANTED if force or not good(CACHE / w)]
    if not todo:
        return CACHE
    CACHE.mkdir(parents=True, exist_ok=True)
    tail_start = SIZE - 400_000
    entries = central_directory(_get(tail_start, SIZE - 1), tail_start)
    for w in todo:
        hits = [k for k in entries if k.endswith("data/" + w) and "__MACOSX" not in k]
        if not hits:
            raise FileNotFoundError(w)
        data = member(*entries[hits[0]])
        if hashlib.sha256(data).hexdigest() != SHA256[w]:
            raise ValueError(f"{w}: SHA-256 differs from the recorded one; the deposit changed?")
        tmp = CACHE / (w + ".part")
        tmp.write_bytes(data)
        tmp.replace(CACHE / w)
        print(f"  {w}: {len(data):,} bytes", file=sys.stderr)
    return CACHE


if __name__ == "__main__":
    print(fetch(force="--force" in sys.argv))
