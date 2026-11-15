"""Cut static Regular and Bold files out of Google's variable Noto Sans fonts.

libass (the subtitle renderer inside ffmpeg) cannot choose a weight in a variable font, so the
export would draw every caption at regular weight. This script makes the two static weights it
can use. It is only needed to refresh the fonts; the results are committed in assets/fonts.

    python3 -m venv /tmp/ftvenv && /tmp/ftvenv/bin/pip install fonttools
    /tmp/ftvenv/bin/python scripts/make-static-fonts.py DIR_WITH_VARIABLE_TTFS assets/fonts

Needs the variable files NotoSans[wdth,wght].ttf and friends, renamed NotoSans.ttf,
NotoSansTelugu.ttf and so on. Noto fonts are under the SIL Open Font License (OFL.txt).
"""
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FAMILIES = ['NotoSans', 'NotoSansTelugu', 'NotoSansDevanagari', 'NotoSansBengali', 'NotoSansKannada', 'NotoSansTamil', 'NotoSansMalayalam']
WEIGHTS = {'Regular': 400, 'Bold': 700}

source, target = Path(sys.argv[1]), Path(sys.argv[2])
target.mkdir(parents=True, exist_ok=True)
for family in FAMILIES:
    for style, weight in WEIGHTS.items():
        font = TTFont(source / f'{family}.ttf')
        static = instancer.instantiateVariableFont(font, {'wght': weight, 'wdth': 100}, updateFontNames=True)
        out = target / f'{family}-{style}.ttf'
        static.save(out)
        print(out, out.stat().st_size)
