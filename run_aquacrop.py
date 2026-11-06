"""
run_aquacrop.py - физический расчёт KUCrop (AquaCrop-OSPy), вызывается из server.js.

  python run_aquacrop.py '{"cropFile":"final.CRO","soilFile":"Poltavka_NKA.SOL","gwtFile":"Poltavka_0712.GWT",
                           "manFile":"final_2.MAN","cliFile":"Poltavka.CLI","startDate":"2024/05/25",
                           "initWater":"FC","irrigation":"Rainfed"}'
  python run_aquacrop.py --config     # справочники и значения по умолчанию из файлов (для /api/config)
  python run_aquacrop.py --inspect    # все файлы AquaCrop в проекте и что из них прочитано
  python run_aquacrop.py --validate user_files/X.CRO   # проверка загруженного файла (вызывает сервер)
  ... --lang kk                                        # язык сообщений: ru (по умолчанию), kk, en

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
    from kucrop_core import TARGET_YEAR, kind_label, library, region

    print("Пакет aquacrop:", getattr(aquacrop, "__version__", "версия не указана (см. pip show aquacrop)"))
    print(f"Регион: {region()}; целевой год {TARGET_YEAR}\n")
    for kind, entries in library().items():
        for e in entries:
            src = "загружен" if e["source"] == "user" else "встроен"
            text = e["summary"]["text"] if e["ok"] else "ОШИБКА: " + e["error"]
            print(f"{kind_label(kind):16s} {e['id']:28s} [{src}] {text}")


def _take_lang(args: list) -> list:
    """--lang xx в любом месте аргументов; язык из JSON-запроса ("lang") - тоже."""
    from i18n import set_lang
    if "--lang" in args:
        i = args.index("--lang")
        set_lang(args[i + 1] if i + 1 < len(args) else "ru")
        args = args[:i] + args[i + 2:]
    return args


def main():
    args = _take_lang(sys.argv[1:])
    from i18n import set_lang, t
    try:
        if args and args[0] == "--config":
            from kucrop_core import config_info
            emit({"success": True, **config_info()})
        if args and args[0] == "--inspect":
            inspect()
            return
        if args and args[0] == "--validate":
            from pathlib import Path
            from kucrop_core import validate_upload
            emit({"success": True, **validate_upload(Path(args[1]))})
        raw = json.loads(args[0]) if args else {}
        if not isinstance(raw, dict):
            raise ValueError(t("e.json_object"))
        if raw.get("lang"):
            set_lang(str(raw["lang"]))
        from kucrop_core import simulate
        emit(simulate(raw, detail=True))
    except SystemExit:
        raise
    except json.JSONDecodeError:
        emit({"success": False, "error": t("e.json")}, 1)
    except (ValueError, FileNotFoundError) as exc:       # ошибки ввода / данных: без трейсбэка
        emit({"success": False, "error": str(exc)}, 1)
    except Exception as exc:                              # неожиданное: трейсбэк в stderr, суть в JSON
        traceback.print_exc(file=sys.stderr)
        emit({"success": False, "error": f"{type(exc).__name__}: {exc}"}, 1)


if __name__ == "__main__":
    main()
