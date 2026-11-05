"""
selfcheck.py - проверка, что физическое ядро читает ваши файлы и РЕАЛЬНО реагирует на входы.

  python selfcheck.py

В исходной версии проекта урожай не менялся от грунтовых вод, водный баланс и биомасса были
константами-заглушками, график кроны - нулями, а пшеница падала с ошибкой. Здесь это проверяется.
"""
import sys

from kucrop_core import simulate

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

BASE = {"crop": "Sunflower", "startDate": "2024/05/25", "soil": "Poltavka_NKA",
        "initWater": "FC", "irrigation": "Rainfed"}       # глубина грунтовых вод - из .GWT


def run(**over):
    return simulate({**BASE, **over}, detail=True)


def main():
    base = run()
    wb, pd_ = base["water_balance"], base["production_details"]
    print(f"Базовый сценарий: подсолнечник, Poltavka_NKA, {base['environment']['groundwater']}, FC, богара")
    print(f"  урожай {base['yield_tonne_ha']} т/га, биомасса {pd_['actual_biomass']} т/га, HI {pd_['harvest_index']}%")
    print(f"  осадки {wb['rain']} мм, капилл. подъём {wb['capillary_rise']} мм, Tr {wb['transpiration']} мм, Es {wb['evaporation']} мм\n")

    checks = []

    def differ(name, a, b, key=lambda r: r["yield_tonne_ha"]):
        ka, kb = key(a), key(b)
        checks.append((abs(ka - kb) > 0.005, f"{name}: {ka} / {kb}"))

    differ("Грунтовые воды 1.2 м vs 10 м (урожай)", run(gwDepth="1.2"), run(gwDepth="10"))
    differ("Грунтовые воды 1.2 м vs 10 м (капилл. подъём, мм)", run(gwDepth="1.2"), run(gwDepth="10"),
           key=lambda r: r["water_balance"]["capillary_rise"])
    differ("Влажность FC vs WP", run(initWater="FC"), run(initWater="WP"))
    differ("Богара vs орошение", run(irrigation="Rainfed"), run(irrigation="Irrigated"))
    differ("Почва Poltavka_NKA vs Loam", run(soil="Poltavka_NKA"), run(soil="Loam"))
    differ("Подсолнечник vs ячмень", run(crop="Sunflower"), run(crop="Barley"))
    differ("Погода 2021 vs 2024", run(startDate="2021/05/25"), run(startDate="2024/05/25"))
    wheat = run(crop="Wheat", startDate="2024/05/01")
    checks.append((wheat["yield_tonne_ha"] >= 0, f"Пшеница считается без ошибки: {wheat['yield_tonne_ha']} т/га"))

    checks.append((max(base["charts"]["canopy_cover"]) > 5, f"Кривая кроны не нулевая: максимум {max(base['charts']['canopy_cover'])}%"))
    bh = pd_["actual_biomass"] * pd_["harvest_index"] / 100.0
    checks.append((abs(bh - base["yield_tonne_ha"]) < 0.05, f"Урожай = биомасса x HI: {bh:.2f} ~ {base['yield_tonne_ha']}"))
    stub = (wb["rain"], wb["infiltrated"], wb["evaporation"]) == (107.9, 105.7, 95.5)
    checks.append((not stub, "Водный баланс не равен старым заглушкам 107.9/105.7/95.5"))

    bad = 0
    for ok, text in checks:
        bad += not ok
        print(f"[{'OK ' if ok else 'ПРОБЛЕМА'}] {text}")
    if base["warnings"]:
        print("\nПредупреждения:", *base["warnings"], sep="\n  - ")
    print("\nНе учитывается движком (есть в ваших файлах):", *base["environment"]["not_modeled"], sep="\n  - ")
    print("\nИТОГ:", "всё в порядке." if not bad else f"проблем: {bad}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
