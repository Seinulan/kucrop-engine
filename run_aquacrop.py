"""
run_aquacrop.py - физический расчёт KUCrop (AquaCrop-OSPy), вызывается из server.js.

  python run_aquacrop.py '{"crop":"Sunflower","startDate":"2024/05/25","soil":"Poltavka_NKA",
                           "gwDepth":"1.9","initWater":"FC","irrigation":"Rainfed"}'
  python run_aquacrop.py --config     # справочники и значения по умолчанию из файлов (для /api/config)
  python run_aquacrop.py --inspect    # что прочитано из ваших файлов AquaCrop + версия пакета aquacrop

Ответ - JSON между маркерами ---JSON_OUTPUT_START--- / ---JSON_OUTPUT_END---.
При ошибке: {"success": false, "error": "..."} и код выхода 1. Выдуманных значений нет.
"""
import json
import sys
import traceback

MARK_START = "---JSON_OUTPUT_START---"
MARK_END = "---JSON_OUTPUT_END---"


def emit(obj, code=0):
    print(MARK_START)
    print(json.dumps(obj))          # ASCII-экранирование: не ломается на консолях Windows
    print(MARK_END)
    sys.stdout.flush()
    sys.exit(code)


def inspect():
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    import aquacrop
    from kucrop_core import CROPS, FILES, crop_file, gw_file, load_weather, man_file, not_modeled_notes, soil_file

    print("Пакет aquacrop:", getattr(aquacrop, "__version__", "версия не указана"), "-", aquacrop.__file__)
    _, w = load_weather()
    print(f"Погода: {w['files']}  {w['start']} .. {w['end']} ({w['days']} дн.), полные годы {w['years']}")
    for name, spec in CROPS.items():
        cf = crop_file(name)
        p = cf.params
        print(f"{spec['file']:11s} {name:9s} цикл {cf.maturity_days} дн., всходы {p['EmergenceCD']}, цветение {p['HIstartCD']}, "
              f"Tbase {p['Tbase']:g}, Tupp {p['Tupp']:g}, CCx {p['CCx']:g}, CGC {p['CGC_CD']:g}, HI0 {p['HI0']:g}, WP* {p['WP']:g}")
    s = soil_file()
    print(f"{FILES['sol']}: CN {s.cn:g}, REW {s.rew:g} мм, глубина {s.depth:g} м")
    for h in s.horizons:
        print(f"   {h.thickness:g} м {h.description}: SAT {h.sat:g}  FC {h.fc:g}  WP {h.wp:g}  Ksat {h.ksat:g}  CRa {h.cra:g}  CRb {h.crb:g}")
    g = gw_file()
    print(f"{FILES['gwt']}: '{g.title}', режим {g.mode}, записи {g.records}")
    if g.constant_depth is not None and str(g.constant_depth) not in g.title:
        print(f"   ВНИМАНИЕ: в заголовке файла одна глубина, а в данных {g.constant_depth} м - используется значение из данных")
    m = man_file()
    print(f"{FILES['man']}: мульча {m.mulch_pct:g}%, плодородие {m.fertility_stress_pct:g}%, сорняки {m.weed_cover_pct:g}%")
    for n in not_modeled_notes():
        print("   НЕ МОДЕЛИРУЕТСЯ:", n)


def main():
    args = sys.argv[1:]
    try:
        if args and args[0] == "--config":
            from kucrop_core import config_info
            emit({"success": True, **config_info()})
        if args and args[0] == "--inspect":
            inspect()
            return
        raw = json.loads(args[0]) if args else {}
        if not isinstance(raw, dict):
            raise ValueError("Параметры должны быть JSON-объектом")
        from kucrop_core import simulate
        emit(simulate(raw, detail=True))
    except SystemExit:
        raise
    except json.JSONDecodeError:
        emit({"success": False, "error": "Параметры запроса - некорректный JSON"}, 1)
    except (ValueError, FileNotFoundError) as exc:       # ошибки ввода / данных: без трейсбэка
        emit({"success": False, "error": str(exc)}, 1)
    except Exception as exc:                              # неожиданное: трейсбэк в stderr, суть в JSON
        traceback.print_exc(file=sys.stderr)
        emit({"success": False, "error": f"{type(exc).__name__}: {exc}"}, 1)


if __name__ == "__main__":
    main()
