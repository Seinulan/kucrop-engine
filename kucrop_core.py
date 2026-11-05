"""
kucrop_core.py - физическое ядро KUCrop.

Как в настольном AquaCrop, расчёт собирается из выбранных файлов:
  климат     .CLI (ссылается на .Tnx / .ETo / .PLU)
  культура   .CRO (цикл в календарных днях или в градусо-днях)
  почва      .SOL (горизонты, CRa/CRb) - или встроенный профиль aquacrop для сравнения
  грунт.воды .GWT (нет / постоянный уровень / переменный уровень)
  поле       .MAN (мульча, валики; плодородие и сорняки движок не моделирует - это показывается)
Файлы лежат в папке проекта (встроенные) и в user_files/ (загруженные через сайт).
Всё передаётся в AquaCrop-OSPy (Python-реализация методики ФАО AquaCrop).

Один simulate() используют и сайт (run_aquacrop.py), и обучение ИИ (generate_model.py).
Выдуманных «запасных» чисел нет: нет данных - понятная ошибка.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import warnings
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from aquacrop_files import read_cli, read_climate_series, read_cro, read_gwt, read_man, read_sol

warnings.filterwarnings("ignore")

BASE_DIR = Path(__file__).resolve().parent
USER_DIR = BASE_DIR / "user_files"
META_PATH = BASE_DIR / "model_meta.json"

TARGET_YEAR = 2024
REGION = "Северо-Казахстанская область (СКО), Казахстан"

KIND_EXT = {"cli": ".cli", "crop": ".cro", "soil": ".sol", "gwt": ".gwt", "man": ".man",
            "tnx": ".tnx", "eto": ".eto", "plu": ".plu"}
EXT_KIND = {v: k for k, v in KIND_EXT.items()}
KIND_LABEL = {"cli": "Климат", "crop": "Культура", "soil": "Почва", "gwt": "Грунтовые воды", "man": "Управление полем",
              "tnx": "Температура", "eto": "ETo", "plu": "Осадки"}

DEFAULTS = {"cli": "Poltavka.CLI", "crop": "final.CRO", "soil": "Poltavka_NKA.SOL",
            "gwt": "Poltavka_0712.GWT", "man": "final_2.MAN"}
# культуры, на которых обучается ИИ (и старый параметр crop=Sunflower/Wheat/Barley)
TRAIN_CROPS = {"Sunflower": "final.CRO", "Wheat": "Wheat.CRO", "Barley": "Barley.CRO"}
# встроенные профили aquacrop - для сравнения с вашей почвой
BUILTIN_SOILS = {"aquacrop:Loam": "Суглинок (встроенный профиль aquacrop)",
                 "aquacrop:SandyLoam": "Супесь (встроенный профиль aquacrop)"}
TRAIN_SOILS = {"Poltavka_NKA": "Poltavka_NKA.SOL", "Loam": "aquacrop:Loam", "SandyLoam": "aquacrop:SandyLoam"}
SOIL_ALIASES = {"ClayLoam": "Poltavka_NKA.SOL", "Poltavka_NKA": "Poltavka_NKA.SOL",
                "Loam": "aquacrop:Loam", "SandyLoam": "aquacrop:SandyLoam"}

IRRIGATION = ("Rainfed", "Irrigated")
INIT_WATER = ("FC", "WP")
GW_VALID_RANGE = (0.5, 15.0)          # допустимо для расчёта, м
GW_TRAIN_RANGE = (1.0, 10.0)          # диапазон обучения ИИ, м
PLANTING_UI = ((4, 1), (7, 31))       # посев можно выбрать в этих пределах целевого года
PLANTING_TRAIN = ((4, 25), (6, 15))   # окно посева при обучении ИИ
HARVEST_MARGIN_DAYS = 10
IRRIGATION_SMT = 70
MAX_UPLOAD_BYTES = 2 * 1024 * 1024


# --------------------------------------------------------------------------- #
# утилиты
# --------------------------------------------------------------------------- #
def to_jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return to_jsonable(obj.tolist())
    if isinstance(obj, (np.floating, float)):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, (pd.Timestamp, datetime, date)):
        return obj.strftime("%Y-%m-%d")
    return obj


def _stamp(p: Path):
    st = p.stat()
    return str(p), st.st_mtime_ns, st.st_size


@lru_cache(maxsize=512)
def _sha_cached(path, mtime, size):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sha256(p: Path) -> str:
    return _sha_cached(*_stamp(Path(p)))


# --------------------------------------------------------------------------- #
# библиотека файлов
# --------------------------------------------------------------------------- #
def kind_of(name: str):
    return EXT_KIND.get(Path(name).suffix.lower())


def all_files() -> dict:
    """{id: Path}. id встроенного файла - имя, загруженного - 'user_files/имя'."""
    out = {}
    for p in sorted(BASE_DIR.iterdir()):
        if p.is_file() and kind_of(p.name):
            out[p.name] = p
    if USER_DIR.is_dir():
        for p in sorted(USER_DIR.iterdir()):
            if p.is_file() and kind_of(p.name):
                out["user_files/" + p.name] = p
    return out


def resolve(file_id: str, kind: str) -> Path:
    files = all_files()
    if file_id not in files:
        raise ValueError(f"{KIND_LABEL[kind]}: файл '{file_id}' не найден")
    if kind_of(file_id) != kind:
        raise ValueError(f"{KIND_LABEL[kind]}: '{file_id}' - не файл {KIND_EXT[kind].upper()}")
    return files[file_id]


_READERS = {
    "crop": read_cro, "soil": read_sol, "gwt": read_gwt, "man": read_man, "cli": read_cli,
    "tnx": lambda p: read_climate_series(p, 2),
    "eto": lambda p: read_climate_series(p, 1),
    "plu": lambda p: read_climate_series(p, 1),
}


@lru_cache(maxsize=256)
def _parse_cached(kind, path, mtime, size):
    return _READERS[kind](Path(path))


def parse(kind: str, path: Path):
    return _parse_cached(kind, *_stamp(Path(path)))


def _find_sibling(name: str, near: Path) -> Path:
    """Файл, на который ссылается .CLI: сначала рядом с .CLI, потом в другой папке (без учёта регистра)."""
    dirs = [near.parent] + [d for d in (BASE_DIR, USER_DIR) if d != near.parent and d.is_dir()]
    for d in dirs:
        for p in d.iterdir():
            if p.is_file() and p.name.lower() == name.lower():
                return p
    raise ValueError(f"{near.name}: не найден файл {name} - загрузите его вместе с .CLI")


def climate_paths(cli_id: str) -> dict:
    cli_path = resolve(cli_id, "cli")
    refs = parse("cli", cli_path)
    return {k: _find_sibling(refs[k], cli_path) for k in ("tnx", "eto", "plu")}


@lru_cache(maxsize=8)
def _weather_cached(tnx_s, eto_s, plu_s):
    tnx = parse("tnx", Path(tnx_s[0]))
    eto = parse("eto", Path(eto_s[0]))
    plu = parse("plu", Path(plu_s[0]))
    if not (tnx.first_date == eto.first_date == plu.first_date):
        raise ValueError(f"Разные даты начала рядов погоды: Tnx {tnx.first_date}, ETo {eto.first_date}, PLU {plu.first_date}")
    if not (len(tnx.rows) == len(eto.rows) == len(plu.rows)):
        raise ValueError(f"Разная длина рядов погоды: Tnx={len(tnx.rows)}, ETo={len(eto.rows)}, PLU={len(plu.rows)}")
    start = pd.Timestamp(year=tnx.first_date[0], month=tnx.first_date[1], day=tnx.first_date[2])
    dates = pd.date_range(start, periods=len(tnx.rows), freq="D")
    tn = np.array([r[0] for r in tnx.rows])
    tx = np.array([r[1] for r in tnx.rows])
    if np.any(tn > tx + 1e-9):
        bad = int(np.argmax(tn > tx + 1e-9))
        raise ValueError(f"{Path(tnx_s[0]).name}: Tmin > Tmax на дату {dates[bad]:%Y-%m-%d}")
    # тот же формат, что у aquacrop.utils.prepare_weather (включая ETo >= 0.1)
    df = pd.DataFrame({
        "MinTemp": tn, "MaxTemp": tx,
        "Precipitation": [r[0] for r in plu.rows],
        "ReferenceET": np.clip([r[0] for r in eto.rows], 0.1, None),
        "Date": dates,
    })
    station = tnx.title.split(":")[0].strip() or Path(tnx_s[0]).stem
    info = {
        "start": dates[0].strftime("%Y-%m-%d"), "end": dates[-1].strftime("%Y-%m-%d"), "days": len(dates),
        "station": station, "files": {k: Path(s[0]).name for k, s in (("tnx", tnx_s), ("eto", eto_s), ("plu", plu_s))},
        "years": sorted({int(y) for y in dates.year if (dates.year == y).sum() >= 365}),
    }
    return df, info


def load_weather(cli_id: str = None):
    paths = climate_paths(cli_id or DEFAULTS["cli"])
    df, info = _weather_cached(*(_stamp(paths[k]) for k in ("tnx", "eto", "plu")))
    return df.copy(), dict(info)


# --------------------------------------------------------------------------- #
# сводки файлов (для интерфейса, как окна характеристик в AquaCrop)
# --------------------------------------------------------------------------- #
def _numbers(text: str):
    return [float(x) for x in re.findall(r"\d+(?:[.,]\d+)?", text.replace(",", "."))]


def summarize(kind: str, file_id: str) -> dict:
    p = resolve(file_id, kind)
    obj = parse(kind, p)
    if kind == "crop":
        q = obj.params
        cal = int(q["CalendarType"]) == 1
        return {
            "title": obj.title, "calendar": "календарные дни" if cal else "градусо-дни (GDD)",
            "cycle_days": obj.maturity_days, "emergence": q["EmergenceCD"], "flowering": q["HIstartCD"],
            "senescence": q["SenescenceCD"], "tbase": q["Tbase"], "tupp": q["Tupp"], "ccx": q["CCx"],
            "cgc": q["CGC_CD"], "hi0_pct": q["HI0"] * 100, "wp": q["WP"], "zmax": q["Zmax"],
            "text": f"цикл {obj.maturity_days} дн. ({'дни' if cal else 'GDD'}), Tbase {q['Tbase']:g} °C, "
                    f"CCx {q['CCx']:g}, HI0 {q['HI0'] * 100:g}%, WP* {q['WP']:g}",
        }
    if kind == "soil":
        hs = [{"thickness": h.thickness, "description": h.description, "sat": h.sat, "fc": h.fc, "wp": h.wp,
               "ksat": h.ksat, "cra": h.cra, "crb": h.crb} for h in obj.horizons]
        return {"cn": obj.cn, "rew": obj.rew, "depth": obj.depth, "horizons": hs,
                "text": f"{len(hs)} гор., {obj.depth:g} м, CN {obj.cn:g}: "
                        + "; ".join(f"{h['description']} {h['thickness']:g} м" for h in hs)}
    if kind == "gwt":
        mode_text = {0: "нет грунтовых вод", 1: "постоянный уровень", 2: "переменный уровень"}[obj.mode]
        out = {"title": obj.title, "mode": obj.mode, "mode_text": mode_text, "records": len(obj.records)}
        if obj.mode == 1:
            d = obj.constant_depth
            out["depth"] = d
            nums = [n for n in _numbers(obj.title) if 0 < n <= 30]
            out["title_mismatch"] = bool(nums) and all(abs(n - d) > 1e-6 for n in nums)
            out["text"] = f"{mode_text}: {d:g} м" + (" (в заголовке файла другое число!)" if out["title_mismatch"] else "")
        elif obj.mode == 2:
            depths = [r[1] for r in obj.records]
            out["text"] = f"{mode_text}: {min(depths):g}-{max(depths):g} м, {len(depths)} наблюдений"
        else:
            out["text"] = mode_text
        return out
    if kind == "man":
        return {"mulch_pct": obj.mulch_pct, "fertility_stress_pct": obj.fertility_stress_pct,
                "weed_cover_pct": obj.weed_cover_pct, "bund_height_m": obj.bund_height_m,
                "text": f"мульча {obj.mulch_pct:g}%, плодородие {obj.fertility_stress_pct:g}%, "
                        f"сорняки {obj.weed_cover_pct:g}%, валики {obj.bund_height_m:g} м"}
    if kind == "cli":
        df, w = load_weather(file_id)
        out = {"station": w["station"], "start": w["start"], "end": w["end"], "years": w["years"], "files": w["files"],
               "has_target_year": TARGET_YEAR in w["years"]}
        if out["has_target_year"]:
            s = df[(df.Date >= f"{TARGET_YEAR}-04-01") & (df.Date <= f"{TARGET_YEAR}-09-30")]
            out["season"] = {"rain": round(float(s.Precipitation.sum()), 1), "eto": round(float(s.ReferenceET.sum()), 1),
                             "tmean": round(float(((s.MinTemp + s.MaxTemp) / 2).mean()), 1)}
            out["text"] = (f"{w['station']}, {w['start']} .. {w['end']}; {TARGET_YEAR}, апр-сен: осадки "
                           f"{out['season']['rain']:g} мм, ETo {out['season']['eto']:g} мм, Tср {out['season']['tmean']:g} °C")
        else:
            out["text"] = f"{w['station']}, {w['start']} .. {w['end']} - НЕТ {TARGET_YEAR} года"
        return out
    # отдельные ряды погоды
    return {"start": "%04d-%02d-%02d" % obj.first_date, "days": len(obj.rows),
            "text": f"с {obj.first_date[2]:02d}.{obj.first_date[1]:02d}.{obj.first_date[0]}, {len(obj.rows)} дн."}


def library() -> dict:
    """Все файлы по видам: id, источник, корректен ли, сводка или ошибка."""
    out = {k: [] for k in KIND_EXT}
    for fid, p in all_files().items():
        kind = kind_of(fid)
        entry = {"id": fid, "name": p.name, "source": "user" if fid.startswith("user_files/") else "builtin"}
        try:
            entry["summary"] = to_jsonable(summarize(kind, fid))
            entry["ok"] = True
        except Exception as exc:          # битый файл показываем в списке с причиной, выбрать его нельзя
            entry["ok"] = False
            entry["error"] = str(exc)
        out[kind].append(entry)
    return out


def validate_upload(path: Path) -> dict:
    """Проверка загруженного файла: разбор + сводка. ValueError - если файл не годится."""
    kind = kind_of(path.name)
    if not kind:
        raise ValueError(f"Неподдерживаемое расширение: {path.suffix}")
    if path.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError("Файл больше 2 МБ")
    parse(kind, path)
    fid = ("user_files/" + path.name) if path.parent == USER_DIR else path.name
    if kind in ("cli",):
        try:
            return {"kind": kind, "id": fid, "summary": to_jsonable(summarize(kind, fid)), "complete": True}
        except ValueError as exc:         # .CLI загружен раньше своих рядов погоды - это нормально
            return {"kind": kind, "id": fid, "summary": None, "complete": False, "note": str(exc)}
    return {"kind": kind, "id": fid, "summary": to_jsonable(summarize(kind, fid)), "complete": True}


# --------------------------------------------------------------------------- #
# параметры запроса
# --------------------------------------------------------------------------- #
def _parse_date(value) -> datetime:
    s = str(value).strip().replace("-", "/")
    try:
        return datetime.strptime(s, "%Y/%m/%d")
    except ValueError as exc:
        raise ValueError(f"Неверная дата '{value}' (нужен формат ГГГГ/ММ/ДД)") from exc


def _choose(raw: dict) -> dict:
    """Какие файлы выбраны (новые ключи cropFile/... или старые crop/soil)."""
    files = {k: str(raw.get(f"{k}File") or "") for k in ("cli", "crop", "soil", "gwt", "man")}
    if not files["crop"]:
        name = raw.get("crop")
        if name and name not in TRAIN_CROPS:
            raise ValueError(f"Неизвестная культура '{name}'")
        files["crop"] = TRAIN_CROPS.get(name, DEFAULTS["crop"])
    if not files["soil"]:
        soil = raw.get("soil")
        if soil and soil not in SOIL_ALIASES:
            raise ValueError(f"Неизвестная почва '{soil}'")
        files["soil"] = SOIL_ALIASES.get(soil, DEFAULTS["soil"])
    for k in ("cli", "gwt", "man"):
        files[k] = files[k] or DEFAULTS[k]
    return files


def normalize_params(raw: dict) -> dict:
    """Проверка входа. Бросает ValueError с понятным пользователю текстом."""
    p = {"files": _choose(raw)}
    f = p["files"]
    # каждый файл должен существовать и читаться
    p["crop_file"] = parse("crop", resolve(f["crop"], "crop"))
    if f["soil"] in BUILTIN_SOILS:
        p["soil_file"] = None
    else:
        p["soil_file"] = parse("soil", resolve(f["soil"], "soil"))
    p["gwt_file"] = parse("gwt", resolve(f["gwt"], "gwt"))
    p["man_file"] = parse("man", resolve(f["man"], "man"))
    _, w = load_weather(f["cli"])
    p["weather_info"] = w

    p["irrigation"] = str(raw.get("irrigation", "Rainfed"))
    if p["irrigation"] not in IRRIGATION:
        raise ValueError(f"Неизвестное управление '{p['irrigation']}'. Доступно: {', '.join(IRRIGATION)}")
    p["init_water"] = str(raw.get("initWater", "FC"))
    if p["init_water"] not in INIT_WATER:
        raise ValueError("Начальная влажность: FC или WP")

    p["start"] = _parse_date(raw.get("startDate") or f"{TARGET_YEAR}/05/25")
    if p["start"].year != TARGET_YEAR:
        raise ValueError(f"Целевой год расчёта - {TARGET_YEAR}: выберите дату посева в {TARGET_YEAR} году")
    (m1, d1), (m2, d2) = PLANTING_UI
    if not (date(TARGET_YEAR, m1, d1) <= p["start"].date() <= date(TARGET_YEAR, m2, d2)):
        raise ValueError(f"Дата посева должна быть между {d1:02d}.{m1:02d} и {d2:02d}.{m2:02d}.{TARGET_YEAR}")

    cf = p["crop_file"]
    year_end = datetime(TARGET_YEAR, 12, 31)
    p["maturity_date"] = p["start"] + timedelta(days=cf.maturity_days)
    if cf.calendar_days:
        if p["maturity_date"] > year_end:
            raise ValueError(f"{Path(f['crop']).name}: цикл {cf.maturity_days} дн. при посеве {p['start']:%d.%m} "
                             f"заканчивается {p['maturity_date']:%d.%m.%Y} - в следующем году. Выберите более ранний посев.")
        p["end"] = min(p["maturity_date"] + timedelta(days=HARVEST_MARGIN_DAYS), year_end)
    else:   # в градусо-днях длина цикла зависит от погоды - последняя дата уборки 31 декабря
        p["end"] = year_end

    wstart, wend = pd.Timestamp(w["start"]), pd.Timestamp(w["end"])
    if p["start"] < wstart or p["end"] > wend:
        raise ValueError(f"Сезон {p['start']:%Y-%m-%d} .. {p['end']:%Y-%m-%d} выходит за пределы погоды "
                         f"{f['cli']} ({w['start']} .. {w['end']}).")

    g = p["gwt_file"]
    gw_raw = raw.get("gwDepth")
    p["gw_mode"] = g.mode
    p["gw_depth"] = None
    if g.mode == 1:
        try:
            gw = g.constant_depth if gw_raw in (None, "") else float(gw_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("Глубина грунтовых вод должна быть числом") from exc
        if not math.isfinite(gw) or not (GW_VALID_RANGE[0] <= gw <= GW_VALID_RANGE[1]):
            raise ValueError(f"Глубина грунтовых вод должна быть от {GW_VALID_RANGE[0]} до {GW_VALID_RANGE[1]} м")
        p["gw_depth"] = round(gw, 3)
    return p


# --------------------------------------------------------------------------- #
# ИИ-суррогат: признаки и применимость
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=4)
def _meta_cached(path, mtime, size):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_meta():
    return _meta_cached(*_stamp(META_PATH)) if META_PATH.exists() else None


def training_fingerprint() -> dict:
    """Хеши файлов, на которых обучается ИИ (пишутся в model_meta.json)."""
    clim = climate_paths(DEFAULTS["cli"])
    return {
        "climate": {k: sha256(v) for k, v in clim.items()},
        "man": sha256(resolve(DEFAULTS["man"], "man")),
        "gwt_mode": 1,
        "crop": {name: sha256(resolve(fid, "crop")) for name, fid in TRAIN_CROPS.items()},
        "soil": {name: (fid if fid in BUILTIN_SOILS else sha256(resolve(fid, "soil"))) for name, fid in TRAIN_SOILS.items()},
    }


def ai_block(p: dict, meta: dict = None) -> dict:
    """Применим ли ИИ к этому расчёту, и с какими признаками."""
    meta = meta if meta is not None else load_meta()
    if not meta or "training_files" not in meta:
        return {"applicable": False, "reason": "ИИ-модель не обучена (нет model_meta.json) - запустите python generate_model.py"}
    tf, f = meta["training_files"], p["files"]
    clim = climate_paths(f["cli"])
    if p["start"].year != meta.get("target_year"):
        return {"applicable": False, "reason": f"ИИ обучен на {meta.get('target_year')} годе"}
    if {k: sha256(v) for k, v in clim.items()} != tf["climate"]:
        return {"applicable": False, "reason": "выбран другой климат - ИИ обучен на Poltavka.CLI"}
    if sha256(resolve(f["man"], "man")) != tf["man"]:
        return {"applicable": False, "reason": "выбран другой .MAN - ИИ обучен на final_2.MAN"}
    if p["gw_mode"] != tf.get("gwt_mode", 1):
        return {"applicable": False, "reason": "ИИ обучен с постоянным уровнем грунтовых вод"}
    crop_hash = sha256(resolve(f["crop"], "crop"))
    crop = next((n for n, h in tf["crop"].items() if h == crop_hash), None)
    if crop is None:
        return {"applicable": False, "reason": f"культура {Path(f['crop']).name} не участвовала в обучении ИИ"}
    soil_key = f["soil"] if f["soil"] in BUILTIN_SOILS else sha256(resolve(f["soil"], "soil"))
    soil = next((n for n, h in tf["soil"].items() if h == soil_key), None)
    if soil is None:
        return {"applicable": False, "reason": f"почва {Path(f['soil']).name} не участвовала в обучении ИИ"}

    row = {"gw_depth": p["gw_depth"], "init_fc": 1.0 if p["init_water"] == "FC" else 0.0,
           "irrigated": 1.0 if p["irrigation"] == "Irrigated" else 0.0,
           "planting_doy": float(p["start"].timetuple().tm_yday)}
    for c in meta["categories"]["crop"]:
        row[f"crop_{c}"] = 1.0 if c == crop else 0.0
    for s in meta["categories"]["soil"]:
        row[f"soil_{s}"] = 1.0 if s == soil else 0.0
    missing = [n for n in meta["feature_names"] if n not in row]
    if missing:
        return {"applicable": False, "reason": "модель обучена с другими признаками: " + ", ".join(missing)}
    notes = []
    r = meta.get("ranges", {})
    if r.get("gw_depth") and not (r["gw_depth"][0] <= p["gw_depth"] <= r["gw_depth"][1]):
        notes.append(f"глубина грунтовых вод вне диапазона обучения ({r['gw_depth'][0]}-{r['gw_depth'][1]} м)")
    if r.get("planting_doy") and not (r["planting_doy"][0] <= row["planting_doy"] <= r["planting_doy"][1]):
        notes.append("дата посева вне окна обучения")
    return {"applicable": True, "features": [float(row[n]) for n in meta["feature_names"]],
            "crop": crop, "soil": soil, "notes": notes}


def make_features(p: dict, feature_order: list) -> list:
    """Признаки для обучения (тот же расчёт, что в ai_block, без проверки хешей)."""
    crop = next(n for n, fid in TRAIN_CROPS.items() if fid == p["files"]["crop"])
    soil = next(n for n, fid in TRAIN_SOILS.items() if fid == p["files"]["soil"])
    row = {"gw_depth": p["gw_depth"], "init_fc": 1.0 if p["init_water"] == "FC" else 0.0,
           "irrigated": 1.0 if p["irrigation"] == "Irrigated" else 0.0,
           "planting_doy": float(p["start"].timetuple().tm_yday)}
    row.update({f"crop_{c}": 1.0 if c == crop else 0.0 for c in TRAIN_CROPS})
    row.update({f"soil_{s}": 1.0 if s == soil else 0.0 for s in TRAIN_SOILS})
    return [float(row[n]) for n in feature_order]


def feature_names() -> list:
    return (["gw_depth", "init_fc", "irrigated", "planting_doy"]
            + [f"crop_{c}" for c in TRAIN_CROPS] + [f"soil_{s}" for s in TRAIN_SOILS])


# --------------------------------------------------------------------------- #
# объекты AquaCrop-OSPy
# --------------------------------------------------------------------------- #
def _compartments(depth: float) -> list:
    dz = [0.1] * 12
    while sum(dz) < depth - 1e-6:
        dz.append(0.2)
    return dz


def build_soil(soil_id: str, sf, fwcc: float):
    from aquacrop import Soil
    if soil_id in BUILTIN_SOILS:
        return Soil(soil_id.split(":", 1)[1], fwcc=fwcc)
    cr_override = {i + 1: (h.cra, h.crb) for i, h in enumerate(sf.horizons)}

    class FileSoil(Soil):
        """Почва из .SOL: CRa/CRb (капиллярный подъём) берутся из файла."""
        def add_capillary_rise_params(self):
            super().add_capillary_rise_params()
            for layer, (a, b) in cr_override.items():
                self.profile.loc[self.profile.Layer == layer, "aCR"] = a
                self.profile.loc[self.profile.Layer == layer, "bCR"] = b

    soil = FileSoil("custom", dz=_compartments(sf.depth), cn=sf.cn, rew=sf.rew, calc_cn=0, adj_rew=1, fwcc=fwcc)
    for i, h in enumerate(sf.horizons):
        thick = h.thickness + (1e-6 if i else 0.0)   # защита от 0.3+0.6=0.8999999
        soil.add_layer(thick, h.wp / 100.0, h.fc / 100.0, h.sat / 100.0, h.ksat, h.penetrability)
    layers = soil.profile.dropna(subset=["Layer"]).Layer.nunique()
    if layers != len(sf.horizons):
        raise RuntimeError(f"Почва: из {len(sf.horizons)} горизонтов в профиль попало {layers}")
    return soil


def _same(a, b) -> bool:
    try:
        return abs(float(a) - float(b)) < 1e-9
    except (TypeError, ValueError):
        return a == b


def build_crop(cf, start: datetime, end: datetime):
    from aquacrop import Crop
    crop = Crop("custom", planting_date=start.strftime("%m/%d"), harvest_date=end.strftime("%m/%d"), **cf.params)
    # Движок создаёт «межсезонную» культуру как Crop(crop.Name) и затем копирует в неё ВСЕ наши параметры.
    # Crop("custom") без параметров у него падает, поэтому имя - встроенное "Default"; на расчёт оно не влияет.
    crop.Name = "Default"
    not_applied = [k for k, v in cf.params.items() if not _same(getattr(crop, k, None), v)]
    if not_applied:
        raise RuntimeError("Параметры культуры не применились в aquacrop: " + ", ".join(not_applied))
    return crop


def build_groundwater(p: dict):
    from aquacrop import GroundWater
    g = p["gwt_file"]
    if g.mode == 0:
        return GroundWater(water_table="N")
    if g.mode == 1:
        return GroundWater(water_table="Y", method="Constant", dates=[p["start"].strftime("%Y/%m/%d")], values=[p["gw_depth"]])
    # переменный уровень: глубина на каждый день сезона (ступенькой по дням = точная интерполяция)
    days = (p["end"] - p["start"]).days + 1
    depths = g.daily_depths(p["start"], days)
    dates = [(p["start"] + timedelta(days=i)).strftime("%Y/%m/%d") for i in range(days)]
    return GroundWater(water_table="Y", method="Constant", dates=dates, values=depths)


def build_initial_water(p: dict):
    """Начальная влажность для КАЖДОГО горизонта. По умолчанию aquacrop задаёт её только слою 1,
    а нижние слои остаются с влажностью 0 (ниже точки увядания) - это искажало расчёт с WP и без грунтовых вод."""
    from aquacrop import InitialWaterContent
    n = len(p["soil_file"].horizons) if p["soil_file"] is not None else 1
    return InitialWaterContent(wc_type="Prop", method="Layer", depth_layer=list(range(1, n + 1)), value=[p["init_water"]] * n)


def build_field_management(m):
    from aquacrop import FieldMngt
    kw = {}
    if m.mulch_pct > 0:
        kw.update(mulches=True, mulch_pct=m.mulch_pct, f_mulch=m.mulch_effect_pct / 100.0)
    if m.bund_height_m > 0:
        kw.update(bunds=True, z_bund=m.bund_height_m)
    return FieldMngt(**kw)


def not_modeled_notes(p: dict) -> list:
    m, g = p["man_file"], p["gwt_file"]
    notes = []
    if m.fertility_stress_pct > 0:
        notes.append(f"Стресс плодородия {m.fertility_stress_pct:g}% (.MAN) - в AquaCrop-OSPy не моделируется, "
                     "поэтому урожай может быть выше, чем в настольном AquaCrop.")
    if m.weed_cover_pct > 0:
        notes.append(f"Сорняки {m.weed_cover_pct:g}% (.MAN) - в AquaCrop-OSPy не моделируются.")
    if g.records and max(r[2] for r in g.records) > 0:
        notes.append(f"Засолённость грунтовых вод ECw={max(r[2] for r in g.records):g} dS/m (.GWT) - солевой режим в OSPy не моделируется.")
    return notes


# --------------------------------------------------------------------------- #
# чтение результатов
# --------------------------------------------------------------------------- #
def _col(df: pd.DataFrame, name: str) -> np.ndarray:
    if name not in df.columns:
        raise RuntimeError(f"В выводе aquacrop нет колонки '{name}'. Есть: {list(df.columns)}")
    return pd.to_numeric(df[name], errors="coerce").to_numpy(dtype=float)


def _season_rows(df: pd.DataFrame) -> pd.DataFrame:
    sub = df[(df["season_counter"] >= 0) & (df["dap"] > 0)]
    if sub.empty:
        raise RuntimeError("aquacrop не вернул ни одного дня вегетации")
    return sub.reset_index(drop=True)


# --------------------------------------------------------------------------- #
# один физический расчёт
# --------------------------------------------------------------------------- #
def simulate(raw_params: dict, detail: bool = True) -> dict:
    from aquacrop import AquaCropModel

    p = normalize_params(raw_params)
    f = p["files"]
    weather, w = load_weather(f["cli"])
    warns: list = []
    cf = p["crop_file"]

    crop = build_crop(cf, p["start"], p["end"])
    soil = build_soil(f["soil"], p["soil_file"], fwcc=cf.extra["fwcc"])
    kwargs = {}
    if p["irrigation"] == "Irrigated":
        from aquacrop import IrrigationManagement
        kwargs["irrigation_management"] = IrrigationManagement(irrigation_method=1, SMT=[IRRIGATION_SMT] * 4)

    model = AquaCropModel(
        sim_start_time=p["start"].strftime("%Y/%m/%d"), sim_end_time=p["end"].strftime("%Y/%m/%d"),
        weather_df=weather, soil=soil, crop=crop,
        initial_water_content=build_initial_water(p),
        groundwater=build_groundwater(p), field_management=build_field_management(p["man_file"]), **kwargs,
    )
    try:
        model.run_model(till_termination=True)
    except AssertionError as exc:   # проверки внутри движка -> понятное сообщение
        msg = str(exc)
        m = re.search(r"growing degree days in simulation \(([\d.]+)\) to reach maturity \(([\d.]+)\)", msg)
        if m:
            raise ValueError(f"{Path(f['crop']).name}: за сезон {p['start']:%d.%m}-{p['end']:%d.%m.%Y} набирается "
                             f"{float(m.group(1)):.0f} градусо-дней, а для созревания нужно {float(m.group(2)):.0f}. "
                             "Нужен более ранний посев или другая культура.") from exc
        raise RuntimeError(f"Движок AquaCrop отклонил входные данные: {msg[:300]}") from exc

    stats = model.get_simulation_results()
    if stats is None or stats.empty or "Dry yield (tonne/ha)" not in stats.columns:
        raise RuntimeError("aquacrop не вернул итог сезона (культура не дошла до уборки)")
    yield_val = float(stats["Dry yield (tonne/ha)"].iloc[0])
    yield_pot = float(stats["Yield potential (tonne/ha)"].iloc[0]) if "Yield potential (tonne/ha)" in stats else None
    if not math.isfinite(yield_val):
        raise RuntimeError("aquacrop вернул нечисловой урожай")
    harvest = str(stats["Harvest Date (YYYY/MM/DD)"].iloc[0])[:10] if "Harvest Date (YYYY/MM/DD)" in stats else None

    cg = _season_rows(model.get_crop_growth())
    wf = _season_rows(model.get_water_flux())
    n = min(len(cg), len(wf))
    cg, wf = cg.iloc[:n], wf.iloc[:n]

    sf = p["soil_file"]
    prof = model._param_struct.Soil.profile
    if sf is not None and "aCR" in prof.columns:      # CRa/CRb есть только при включённых грунтовых водах
        for i, h in enumerate(sf.horizons, start=1):
            row = prof[prof.Layer == i]
            if not row.empty and (abs(float(row.aCR.iloc[0]) - h.cra) > 1e-6 or abs(float(row.bCR.iloc[0]) - h.crb) > 1e-6):
                warns.append(f"CRa/CRb горизонта {i} в движке отличаются от .SOL")
    if not cf.calendar_days and harvest and pd.Timestamp(harvest) >= pd.Timestamp(p["end"]):
        warns.append("Культура в градусо-днях не успела созреть до последней даты уборки - урожай может быть занижен.")

    g = p["gwt_file"]
    if g.mode == 0:
        gw_text = f"{Path(f['gwt']).name}: грунтовых вод нет"
    elif g.mode == 1:
        gw_text = (f"{Path(f['gwt']).name}: {p['gw_depth']:.2f} м, постоянный уровень"
                   + ("" if abs(p["gw_depth"] - g.constant_depth) < 1e-6 else f" (в файле {g.constant_depth:g} м)"))
    else:
        gw_text = f"{Path(f['gwt']).name}: переменный уровень, {len(g.records)} наблюдений"
    man = p["man_file"]
    out = {
        "success": True,
        "yield_tonne_ha": round(yield_val, 2),
        "location": f"{w['station']} · {REGION}",
        "target_year": TARGET_YEAR,
        "files": f,
        "period": f"{p['start']:%Y/%m/%d} - {harvest or p['end'].strftime('%Y/%m/%d')}",
        "irrigation": p["irrigation"],
        "warnings": warns,
        "environment": {
            "engine": "AquaCrop-OSPy (Python-реализация методики ФАО AquaCrop)",
            "climate": f"{Path(f['cli']).name}: {w['files']['tnx']}, {w['files']['eto']}, {w['files']['plu']} "
                       f"(станция {w['station']}, {w['start']} .. {w['end']})",
            "crop": f"{Path(f['crop']).name}: цикл {cf.maturity_days} дн. "
                    f"({'календарные дни' if cf.calendar_days else 'градусо-дни'}), HI0={cf.params['HI0'] * 100:g}%, "
                    f"CCx={cf.params['CCx']:g}, WP*={cf.params['WP']:g} г/м2",
            "soil": (f"{Path(f['soil']).name}: " + "; ".join(f"{h.thickness:g} м {h.description} (FC {h.fc:g}%, WP {h.wp:g}%)" for h in sf.horizons)
                     if sf is not None else BUILTIN_SOILS[f["soil"]]),
            "groundwater": gw_text,
            "management": f"{Path(f['man']).name}: мульча {man.mulch_pct:g}%, валики {man.bund_height_m:g} м; "
                          + (f"орошение по порогу {IRRIGATION_SMT}% TAW (сценарий)" if p["irrigation"] == "Irrigated" else "богара"),
            "initial_water": "полевая влагоёмкость (FC)" if p["init_water"] == "FC" else "точка увядания (WP)",
            "not_modeled": not_modeled_notes(p),
        },
        "ai": ai_block(p),
    }
    if not detail:
        return to_jsonable(out)

    dates = pd.date_range(p["start"], periods=n, freq="D")
    rain = weather.set_index("Date")["Precipitation"].reindex(dates).fillna(0.0).to_numpy(dtype=float)
    cc = _col(cg, "canopy_cover") * 100.0
    tr = _col(wf, "Tr")
    cr = _col(wf, "CR")

    def total(a):
        return round(float(np.nansum(a)), 1)

    out["water_balance"] = {
        "rain": total(rain), "irrigation": total(_col(wf, "IrrDay")), "infiltrated": total(_col(wf, "Infl")),
        "runoff": total(_col(wf, "Runoff")), "deep_percolation": total(_col(wf, "DeepPerc")),
        "capillary_rise": total(cr), "transpiration": total(tr), "evaporation": total(_col(wf, "Es")),
    }
    out["production_details"] = {
        "actual_biomass": round(float(_col(cg, "biomass")[-1]) / 100.0, 2),     # г/м2 -> т/га
        "harvest_index": round(float(_col(cg, "harvest_index_adj")[-1]) * 100.0, 1),
        "yield_potential": None if yield_pot is None else round(yield_pot, 2),
        "max_canopy_cover": round(float(np.nanmax(cc)), 1),
    }
    out["charts"] = {
        "days": list(range(1, n + 1)), "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "canopy_cover": [round(float(v), 1) for v in cc], "transpiration": [round(float(v), 2) for v in tr],
        "rain": [round(float(v), 1) for v in rain], "capillary_rise": [round(float(v), 2) for v in cr],
    }
    return to_jsonable(out)


def config_info() -> dict:
    """Для /api/config: библиотека файлов, значения по умолчанию, допустимые даты."""
    (m1, d1), (m2, d2) = PLANTING_UI
    return to_jsonable({
        "region": REGION,
        "target_year": TARGET_YEAR,
        "defaults": DEFAULTS,
        "library": library(),
        "builtin_soils": BUILTIN_SOILS,
        "planting": {"min": date(TARGET_YEAR, m1, d1).isoformat(), "max": date(TARGET_YEAR, m2, d2).isoformat(),
                     "default": date(TARGET_YEAR, 5, 25).isoformat()},
        "groundwater": {"min": GW_TRAIN_RANGE[0], "max": GW_TRAIN_RANGE[1],
                        "valid": list(GW_VALID_RANGE)},
        "upload": {"max_bytes": MAX_UPLOAD_BYTES, "extensions": sorted(KIND_EXT.values())},
    })
