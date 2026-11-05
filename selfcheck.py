"""
selfcheck.py - проверка, что физическое ядро читает файлы и РЕАЛЬНО реагирует на входы,
а ИИ-суррогат совпадает с физикой.

  python selfcheck.py
"""
import sys

from kucrop_core import DEFAULTS, TARGET_YEAR, simulate

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

BASE = {"startDate": f"{TARGET_YEAR}/05/25", "initWater": "FC", "irrigation": "Rainfed"}   # файлы - по умолчанию


def run(**over):
    return simulate({**BASE, **over}, detail=True)


def ai_predict(res):
    """Прогноз ONNX для этого расчёта (если ИИ применим и установлен onnxruntime)."""
    ai = res["ai"]
    if not ai["applicable"]:
        return None
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError:
        return None
    from kucrop_core import BASE_DIR
    sess = ort.InferenceSession(str(BASE_DIR / "aquacrop_model.onnx"), providers=["CPUExecutionProvider"])
    x = np.array([ai["features"]], dtype=np.float32)
    return float(sess.run(None, {sess.get_inputs()[0].name: x})[0].ravel()[0])


def main():
    base = run()
    wb, pd_ = base["water_balance"], base["production_details"]
    print(f"Базовый сценарий {TARGET_YEAR}: {', '.join(base['files'].values())}")
    print(f"  {base['location']}; {base['environment']['groundwater']}")
    print(f"  урожай {base['yield_tonne_ha']} т/га, биомасса {pd_['actual_biomass']} т/га, HI {pd_['harvest_index']}%")
    print(f"  осадки {wb['rain']} мм, капилл. подъём {wb['capillary_rise']} мм, Tr {wb['transpiration']} мм, Es {wb['evaporation']} мм\n")

    checks = []

    def differ(name, a, b, key=lambda r: r["yield_tonne_ha"]):
        ka, kb = key(a), key(b)
        checks.append((abs(ka - kb) > 0.005, f"{name}: {ka} / {kb}"))

    cr = lambda r: r["water_balance"]["capillary_rise"]
    differ("Грунтовые воды 1.2 м vs 10 м (урожай)", run(gwDepth="1.2"), run(gwDepth="10"))
    differ("Грунтовые воды 1.2 м vs 10 м (капилл. подъём, мм)", run(gwDepth="1.2"), run(gwDepth="10"), key=cr)
    differ("Влажность FC vs WP", run(initWater="FC"), run(initWater="WP"))
    differ("Богара vs орошение", run(irrigation="Rainfed"), run(irrigation="Irrigated"))
    differ("Почва Poltavka_NKA.SOL vs встроенный Loam", run(), run(soilFile="aquacrop:Loam"))
    differ("final.CRO vs Barley.CRO", run(), run(cropFile="Barley.CRO"))
    differ("Посев 01.05 vs 10.06", run(startDate=f"{TARGET_YEAR}/05/01"), run(startDate=f"{TARGET_YEAR}/06/10"))
    wheat = run(cropFile="Wheat.CRO", startDate=f"{TARGET_YEAR}/05/01")
    checks.append((wheat["yield_tonne_ha"] >= 0, f"Пшеница (Wheat.CRO) считается: {wheat['yield_tonne_ha']} т/га"))
    checks.append((max(base["charts"]["canopy_cover"]) > 5, f"Кривая кроны не нулевая: максимум {max(base['charts']['canopy_cover'])}%"))
    bh = pd_["actual_biomass"] * pd_["harvest_index"] / 100.0
    checks.append((abs(bh - base["yield_tonne_ha"]) < 0.05, f"Урожай = биомасса x HI: {bh:.2f} ~ {base['yield_tonne_ha']}"))
    stub = (wb["rain"], wb["infiltrated"], wb["evaporation"]) == (107.9, 105.7, 95.5)
    checks.append((not stub, "Водный баланс не равен старым заглушкам 107.9/105.7/95.5"))

    for name, r in [("базовый", base), ("Barley, орошение", run(cropFile="Barley.CRO", irrigation="Irrigated")),
                    ("грунт. воды 1.2 м", run(gwDepth="1.2"))]:
        ai = ai_predict(r)
        if ai is None:
            checks.append((False, f"ИИ ({name}): недоступен - {r['ai'].get('reason', 'нет onnxruntime')}"))
        else:
            checks.append((abs(ai - r["yield_tonne_ha"]) < 0.3, f"ИИ ≈ физика ({name}): {ai:.2f} / {r['yield_tonne_ha']} т/га"))

    # редактор файлов: правильная правка проходит проверку, физически невозможная - нет
    import tempfile
    from pathlib import Path
    from kucrop_core import BASE_DIR, check_file
    src = (BASE_DIR / DEFAULTS['crop']).read_text(encoding="latin-1")
    with tempfile.TemporaryDirectory() as tmp:
        good, bad_f = Path(tmp) / "good.CRO", Path(tmp) / "bad.CRO"
        good.write_bytes(src.replace("17.0       : Water", "19.0       : Water").encode("latin-1"))
        bad_f.write_bytes(src.replace("0.85      : Maximum canopy", "1.85      : Maximum canopy").encode("latin-1"))
        try:
            ok_text = check_file(good)["summary"]["text"]
        except ValueError as exc:
            ok_text = None
            print("   ", exc)
        try:
            check_file(bad_f)
            rejected = False
        except ValueError:
            rejected = True
    checks.append((bool(ok_text and "WP* 19" in ok_text), f"Редактор: правка WP* принимается ({ok_text})"))
    checks.append((rejected, "Редактор: CCx = 1.85 отклоняется с понятной ошибкой"))

    bad = 0
    for ok, text in checks:
        bad += not ok
        print(f"[{'OK ' if ok else 'ПРОБЛЕМА'}] {text}")
    if base["warnings"]:
        print("\nПредупреждения:", *base["warnings"], sep="\n  - ")
    print("\nНе учитывается движком (есть в файлах):", *base["environment"]["not_modeled"], sep="\n  - ")
    print("\nИТОГ:", "всё в порядке." if not bad else f"проблем: {bad}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
