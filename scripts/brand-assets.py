# Regenerates every size of the Cold logo from public/coldlogo.png (the source artwork): square, transparent, resized with Lanczos.
# Needs Pillow (python3 -m pip install pillow). Run from the repo root; commit the PNGs it writes.
from PIL import Image
src = Image.open("public/coldlogo.png").convert("RGBA")
side = max(src.size)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(src, ((side - src.width) // 2, (side - src.height) // 2))
def out(path, size, pad=0.0):
    inner = round(size * (1 - 2 * pad)); img = sq.resize((inner, inner), Image.LANCZOS)
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0)); c.paste(img, ((size - inner) // 2, (size - inner) // 2)); c.save(path, optimize=True)
out("public/brand/logo-96.png", 96)                  # the web/desktop header mark (shown at about 32 px)
for s in (16, 32, 48, 128): out(f"extension/icons/icon{s}.png", s)
out("public/brand/favicon-32.png", 32); out("public/brand/apple-touch-icon.png", 180, 0.08); out("public/brand/logo-512.png", 512)
