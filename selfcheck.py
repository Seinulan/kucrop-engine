"""
selfcheck.py - проверка, что физическое ядро читает файлы и РЕАЛЬНО реагирует на входы,
а ИИ-суррогат совпадает с физикой.

  python selfcheck.py
"""
import sys

from kucrop_core import TRAIN_YEAR, simulate

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

BASE = {"startDate": f"{TRAIN_YEAR}/05/25", "initWater": "FC", "irrigation": "Rainfed"}   # файлы - по умолчанию


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
    print(f"Базовый сценарий {TRAIN_YEAR}: {', '.join(base['files'].values())}")
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
    differ("Посев 01.05 vs 10.06", run(startDate=f"{TRAIN_YEAR}/05/01"), run(startDate=f"{TRAIN_YEAR}/06/10"))
    wheat = run(cropFile="Wheat.CRO", startDate=f"{TRAIN_YEAR}/05/01")
    checks.append((wheat["yield_tonne_ha"] >= 0, f"Пшеница (Wheat.CRO) считается: {wheat['yield_tonne_ha']} т/га"))
    checks.append((max(base["charts"]["canopy_cover"]) > 5, f"Кривая кроны не нулевая: максимум {max(base['charts']['canopy_cover'])}%"))
    bh = pd_["actual_biomass"] * pd_["harvest_index"] / 100.0
    checks.append((abs(bh - base["yield_tonne_ha"]) < 0.05, f"Урожай = биомасса x HI: {bh:.2f} ~ {base['yield_tonne_ha']}"))
    stub = (wb["rain"], wb["infiltrated"], wb["evaporation"]) == (107.9, 105.7, 95.5)
    checks.append((not stub, "Водный баланс не равен старым заглушкам 107.9/105.7/95.5"))

    # --- год и даты определяет климатический файл (как в AquaCrop), а не константа
    from kucrop_core import DEFAULTS, library
    cli = next(e for e in library()["cli"] if e["id"] == DEFAULTS["cli"])["summary"]
    years = cli["years"]
    by_year = {y: run(startDate=f"{y}/05/25") for y in years}
    spread = max(r["yield_tonne_ha"] for r in by_year.values()) - min(r["yield_tonne_ha"] for r in by_year.values())
    checks.append((len(years) >= 2 and spread > 0.05,
                   "Каждый год файла считается по своей погоде: " + ", ".join(f"{y}: {r['yield_tonne_ha']}" for y, r in by_year.items())))
    checks.append((all(r["season_year"] == y for y, r in by_year.items()), "Год сезона в ответе = год даты посева"))
    pl = cli["planting"]
    checks.append(((pl["min"], pl["max"]) == (cli["start"], cli["end"]) and pl["min"] <= pl["default"] <= pl["max"],
                   f"Доступные даты посева = период климатического файла: {pl['min']} .. {pl['max']} (по умолчанию {pl['default']})"))
    outside = []
    for d in (f"{years[0] - 1}/05/25", f"{years[-1] + 1}/05/25"):
        try:
            simulate({**BASE, "startDate": d})
            outside.append(f"{d}: посчитан!")
        except ValueError:
            pass
    checks.append((not outside, "Посев вне периода файла отклоняется понятной ошибкой" + (": " + "; ".join(outside) if outside else "")))
    other = [y for y in years if y != TRAIN_YEAR]
    if other:
        na = by_year[other[0]]["ai"]
        checks.append((not na["applicable"] and bool(na.get("reason")) and base["ai"]["applicable"],
                       f"ИИ показывается только для года обучения ({TRAIN_YEAR}); для {other[0]} - отказ: {na.get('reason')}"))

    for name, r in [("базовый", base), ("Barley, орошение", run(cropFile="Barley.CRO", irrigation="Irrigated")),
                    ("грунт. воды 1.2 м", run(gwDepth="1.2"))]:
        ai = ai_predict(r)
        if ai is None:
            checks.append((False, f"ИИ ({name}): недоступен - {r['ai'].get('reason', 'нет onnxruntime')}"))
        else:
            checks.append((abs(ai - r["yield_tonne_ha"]) < 0.3, f"ИИ ≈ физика ({name}): {ai:.2f} / {r['yield_tonne_ha']} т/га"))

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
