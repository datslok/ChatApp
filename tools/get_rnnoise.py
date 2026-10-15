"""Puts RNNoise (Xiph's AI noise suppression, the C library) into the phone app's call-service module.

The web page runs RNNoise as WebAssembly (static/rnnoise-0.4.1/); the phone app compiles the C library into
its own native code instead (mobile/modules/call-service/android/src/main/cpp, see CMakeLists.txt there).
This downloads Xiph's release, checks it against the hash below and copies only the library's files and
its licence, into mobile/modules/call-service/android/src/main/cpp/rnnoise-<version>/ (committed, like the
web page's copies). Run it again only to change the version (and the hash: see below).

    python tools/get_rnnoise.py

Xiph publishes no checksum for the release file, so the hash was pinned on 2026-10-15 after checking the
file by hand: its sources are the same as git's at the release tag v0.2, which Xiph signed (GitHub shows
it "verified"). Any later download has to be exactly that file. (Plus five fixed headers: see FIXES.)
"""
import hashlib
import io
import tarfile
import urllib.request
from pathlib import Path

VERSION = "0.2"
URL = f"https://github.com/xiph/rnnoise/releases/download/v{VERSION}/rnnoise-{VERSION}.tar.gz"
SHA256 = "90fce4b00b9ff24c08dbfe31b82ffd43bae383d85c5535676d28b0a2b11c0d37"

# The library's C files (RNNoise's Makefile.am, RNNOISE_SOURCES: not the x86-only ones, the tools or the
# examples), every header in src/ and src/x86/ (vec.h includes an x86 one on every processor), the public
# header, and the licence.
SOURCES = [
    "denoise.c", "rnn.c", "pitch.c", "kiss_fft.c", "celt_lpc.c", "nnet.c", "nnet_default.c",
    "parse_lpcnet_weights.c", "rnnoise_data.c", "rnnoise_tables.c",
]
FILES = [f"src/{name}" for name in SOURCES] + ["include/rnnoise.h", "COPYING", "AUTHORS"]

# Five headers from Xiph's commit right after the release ("Fix compilation errors", GitHub issue #222): in
# 0.2 itself the ARM code includes os_support.h, a file that doesn't exist, so it can't be built for phones.
# Taken whole from that commit (its parent is the release), each checked against its hash.
FIX_COMMIT = "372f7b4b76cde4ca1ec4605353dd17898a99de38"
FIXES = {
    "src/common.h": "f4975c4ee283a030b08dff4fe26847cc84e2fae340794922fae32aba5cc8e4e6",
    "src/vec.h": "54b02c6922e5180e040b8be28cf878783f550efc0e425d1d90b081e8c50932f5",
    "src/vec_avx.h": "1ec412cd21043f8533dc52373b21436bc871eee8c3061deadbaa3ee184afa919",
    "src/vec_neon.h": "4e943966503518091da521d406e2627f044d3752d4aaa400bdd584571330006c",
    "src/x86/x86cpu.h": "84897794ee10e1ee34f8d9aa5926629fcd95d72c15767fb3d0770ff39c054db0",
}

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "mobile" / "modules" / "call-service" / "android" / "src" / "main" / "cpp" / f"rnnoise-{VERSION}"

package = urllib.request.urlopen(URL).read()
if hashlib.sha256(package).hexdigest() != SHA256:
    raise SystemExit("The download isn't the file we checked (its SHA-256 differs): stopped.")

with tarfile.open(fileobj=io.BytesIO(package)) as archive:
    prefix = f"rnnoise-{VERSION}/"
    headers = [member.name[len(prefix):] for member in archive.getmembers()
               if member.name.endswith(".h") and member.name.startswith((prefix + "src/", ))]
    FILES += headers
    for name in FILES:
        data = archive.extractfile(f"rnnoise-{VERSION}/{name}").read()
        path = TARGET / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)  # (bytes as they are: no line endings changed)

for name, expected in FIXES.items():
    data = urllib.request.urlopen(f"https://raw.githubusercontent.com/xiph/rnnoise/{FIX_COMMIT}/{name}").read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise SystemExit(f"{name} from the fix isn't the file we checked: stopped.")
    (TARGET / name).write_bytes(data)
print(f"Wrote {len(FILES)} files to {TARGET} ({len(FIXES)} of them from the fix after the release)")
