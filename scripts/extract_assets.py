# scripts/extract_assets.py
# -*- coding: utf-8 -*-
"""从 RimWorld 游戏资源包提取 UI 纹理并生成紧急度染色信。"""
import os
import UnityPy
from PIL import Image

GAME = r"D:/SteamLibrary/steamapps/common/RimWorld/RimWorldWin64_Data"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "assets", "raw")
LETTER = os.path.join(ROOT, "assets", "letter")
os.makedirs(RAW, exist_ok=True)
os.makedirs(LETTER, exist_ok=True)

# 需要提取的纹理（短名 = 资源内 Texture2D.m_Name）
TARGETS = [
    "LetterUnopened", "ButtonBG", "ButtonBGClick", "ButtonBGMouseover",
    "GrayTextBG", "TextBGBlack", "FloatMenuOptionBG",
    "CheckOn", "CheckOff", "CheckPartial", "RadioButOn", "RadioButOff",
    "SliderRail", "SliderHandle", "ButtonSubtleAtlas",
    "PlainFlash", "CircleFlash", "Flash", "AlertFlashArrow",
    "Warning", "YellowWarning", "InfoButton",
]

# 紧急度染色（LetterDefs/StandardLetters.xml）
SEV_COLORS = {
    "ThreatBig":       (204, 115, 115),
    "ThreatSmall":     (204, 155, 125),
    "NegativeEvent":   (204, 196, 135),
    "NeutralEvent":    (175, 176, 185),
    "PositiveEvent":   (120, 176, 216),
}

# 信件到达音效：资源内实际名（驼峰） -> 输出文件名（带下划线，与 letterdefs.js 引用一致）
SOUND_MAP = {
    "LetterArrive": "LetterArrive",
    "LetterArriveBadUrgent": "LetterArrive_BadUrgent",
    "LetterArriveBadUrgentBig": "LetterArrive_BadUrgentBig",
    "LetterArriveBadUrgentSmall": "LetterArrive_BadUrgentSmall",
    "LetterArriveGood": "LetterArrive_Good",
    "Click": "Click",
}


def extract_textures():
    saved = {}
    for f in ["resources.assets", "sharedassets0.assets", "sharedassets1.assets"]:
        env = UnityPy.load(os.path.join(GAME, f))
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                d = obj.read()
                if d.m_Name in TARGETS and d.m_Name not in saved:
                    d.image.save(os.path.join(RAW, d.m_Name + ".png"))
                    saved[d.m_Name] = (d.m_Width, d.m_Height)
            except Exception:
                pass
    return saved


def make_tinted():
    src = os.path.join(RAW, "LetterUnopened.png")
    if not os.path.exists(src):
        print("!! LetterUnopened.png 缺失，跳过染色信生成")
        return
    im = Image.open(src).convert("RGBA")
    for sev, (r, g, b) in SEV_COLORS.items():
        px = im.load()
        w, h = im.size
        out = Image.new("RGBA", (w, h))
        op = out.load()
        for y in range(h):
            for x in range(w):
                pr, pg, pb, pa = px[x, y]
                s = 0.85 * (pa / 255.0)
                op[x, y] = (int(pr * (1 - s) + r * s),
                            int(pg * (1 - s) + g * s),
                            int(pb * (1 - s) + b * s), pa)
        out = out.resize((w * 2, h * 2), Image.LANCZOS)
        out.save(os.path.join(LETTER, f"letter-{sev}.png"))
        print("  tinted", sev)


def extract_sounds():
    """提取信件到达音效。游戏音频是 FMOD .fsb，用 UnityPy 的 samples 属性解码为 WAV 字节。"""
    SOUNDS_DIR = os.path.join(ROOT, "assets", "sounds")
    os.makedirs(SOUNDS_DIR, exist_ok=True)
    remaining = dict(SOUND_MAP)
    got = 0
    for f in ["resources.assets", "sharedassets0.assets", "sharedassets1.assets"]:
        env = UnityPy.load(os.path.join(GAME, f))
        for obj in env.objects:
            if obj.type.name != "AudioClip":
                continue
            try:
                d = obj.read()
                base = os.path.splitext(d.m_Name)[0]
                if base in remaining:
                    samples = d.samples  # { "Name.wav": bytes }
                    for fname, data in samples.items():
                        b = os.path.splitext(fname)[0]
                        if b in remaining:
                            out = os.path.join(SOUNDS_DIR, remaining.pop(b) + ".wav")
                            with open(out, "wb") as fh:
                                fh.write(data)
                            got += 1
            except Exception:
                pass
    return got


if __name__ == "__main__":
    s = extract_textures()
    print(f"extracted {len(s)} textures -> assets/raw/")
    make_tinted()
    print("tinted letters -> assets/letter/")
    got = extract_sounds()
    print(f"extracted {got} sounds -> assets/sounds/ (尽力而为，可空)")
