"""Fetch the few small files the Ohio butterfly trends need from the 1 GB Dryad deposit, without downloading it.

Source: Wepprich, Adrion, Ries, Wiedmann & Haddad (2019) "Butterfly abundance declines over 20 years of systematic
monitoring in Ohio, USA", PLoS ONE 14(7): e0216270, doi:10.1371/journal.pone.0216270. Data: Dryad
doi:10.5061/dryad.cf78420 (CC0), one zip of 1,041,221,812 bytes. Dryad's own download API now needs a bearer token
and its web download answers 403 to scripts, so this reads Dryad's Zenodo copy of the same deposit (record 4993851,
same DOI, same md5 976799bca220a8356354e113d5672288) with HTTP range requests: the zip's central directory (the last
~70 KB), then each wanted member's bytes. About 8 MB in all, cached in notebooks/data/ohio/ (git-ignored).

  python3 pipeline/atlas/ohio_fetch.py        # fills the cache; no-op when it is already there
"""
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "notebooks/data/ohio"
URL = "https://zenodo.org/api/records/4993851/files/dryad_butterfly_trends.zip/content"
SIZE = 1_041_221_812
WANTED = ("allpops.csv", "species_names.csv", "speciesTrends.csv", "unique_surveys.csv", "sampling_covariates.csv",
          "OHsites2018update.txt")


def _get(start: int, end: int) -> bytes:
    req = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}", "User-Agent": "hatch-pipeline"})
    with urllib.request.urlopen(req, timeout=120) as r:
        if r.status != 206:
            raise RuntimeError(f"expected a partial response, got {r.status}")
        return r.read()


def central_directory(tail: bytes, tail_start: int) -> dict:
    """Member name -> (local header offset, compressed size, method), from the zip's last bytes (zip64 aware)."""
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
        csize, usize = struct.unpack("<II", cd[p + 20:p + 28])
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
        out[name] = (off, csize, method)
        p += 46 + nlen + xlen + clen
    return out


def member(off: int, csize: int, method: int) -> bytes:
    head = _get(off, off + 29)
    nlen, xlen = struct.unpack("<HH", head[26:30])
    raw = _get(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize - 1)
    if method == 0:
        return raw
    if method == 8:
        return zlib.decompress(raw, -15)
    raise ValueError(f"zip method {method}")


def fetch(force: bool = False) -> Path:
    if not force and all((CACHE / w).exists() for w in WANTED):
        return CACHE
    CACHE.mkdir(parents=True, exist_ok=True)
    tail_start = SIZE - 400_000
    entries = central_directory(_get(tail_start, SIZE - 1), tail_start)
    for w in WANTED:
        hits = [k for k in entries if k.endswith("data/" + w) and "__MACOSX" not in k]
        if not hits:
            raise FileNotFoundError(w)
        (CACHE / w).write_bytes(member(*entries[hits[0]]))
        print(f"  {w}: {(CACHE / w).stat().st_size:,} bytes", file=sys.stderr)
    return CACHE


if __name__ == "__main__":
    print(fetch(force="--force" in sys.argv))
