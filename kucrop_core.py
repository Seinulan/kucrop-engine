"""
kucrop_core.py - физическое ядро KUCrop.

Все параметры берутся из ваших файлов AquaCrop (см. aquacrop_files.py):
  культура   final.CRO / Wheat.CRO / Barley.CRO
  почва      Poltavka_NKA.SOL (3 горизонта, CRa/CRb из файла)
  грунт.воды Poltavka_0712.GWT (глубина по умолчанию из файла, можно изменить)
  поле       final_2.MAN (мульча, валики; плодородие и сорняки движок не моделирует - это показывается)
  климат     Poltavka.CLI -> Tnx / ETo / PLU (даты - из шапки файлов)
и передаются в AquaCrop-OSPy (Python-реализация методики ФАО AquaCrop).

Один simulate() используют и веб-запрос (run_aquacrop.py), и обучение ИИ (generate_model.py).
Выдуманных «запасных» чисел нет: нет данных - понятная ошибка.
"""
from __future__ import annotations

import math
import warnings
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from aquacrop_files import read_cli, read_climate_series, read_cro, read_gwt, read_man, read_sol

warnings.filterwarnings("ignore")

BASE_DIR = Path(__file__).resolve().parent
LOCATION = "Полтавка (СКО)"

FILES = {
    "cli": "Poltavka.CLI",
    "sol": "Poltavka_NKA.SOL",
    "gwt": "Poltavka_0712.GWT",
    "man": "final_2.MAN",
}
CROPS = {
    "Sunflower": {"label": "Подсолнечник", "file": "final.CRO"},
    "Wheat": {"label": "Пшеница", "file": "Wheat.CRO"},
    "Barley": {"label": "Ячмень", "file": "Barley.CRO"},
}
FILE_SOIL = "Poltavka_NKA"
SOILS = {
    FILE_SOIL: "Poltavka_NKA.SOL (ваш файл, 3 горизонта)",
    "Loam": "Суглинок (встроенный профиль aquacrop, для сравнения)",
    "SandyLoam": "Супесь (встроенный профиль aquacrop, для сравнения)",
}
SOIL_ALIASES = {"ClayLoam": FILE_SOIL}          # старое значение из прежнего интерфейса
IRRIGATION = ("Rainfed", "Irrigated")
INIT_WATER = ("FC", "WP")

GW_VALID_RANGE = (0.5, 15.0)          # допустимо для расчёта, м
GW_TRAIN_RANGE = (1.0, 10.0)          # диапазон обучения ИИ, м
PLANTING_UI = ((4, 1), (7, 31))       # (месяц, день): в интерфейсе можно выбрать посев в этих пределах
PLANTING_TRAIN = ((4, 25), (6, 15))   # окно посева, на котором обучается ИИ
HARVEST_MARGIN_DAYS = 10              # запас после созревания до «последней даты уборки»
IRRIGATION_SMT = 70                   # орошение-сценарий: поддерживать влажность >= 70% TAW


# --------------------------------------------------------------------------- #
# утилиты
# --------------------------------------------------------------------------- #
def to_jsonable(obj):
    """numpy -> python, NaN/inf -> None (валидный JSON)."""
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


def _path(name: str) -> Path:
    return BASE_DIR / name


# --------------------------------------------------------------------------- #
# данные из файлов (кешируются на процесс)
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def _weather_cached():
    cli = read_cli(_path(FILES["cli"]))
    tnx = read_climate_series(_path(cli["tnx"]), 2)
    eto = read_climate_series(_path(cli["eto"]), 1)
    plu = read_climate_series(_path(cli["plu"]), 1)
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
        raise ValueError(f"{cli['tnx']}: Tmin > Tmax на дату {dates[bad]:%Y-%m-%d}")
    # тот же формат, что делает aquacrop.utils.prepare_weather (включая ограничение ETo >= 0.1)
    df = pd.DataFrame({
        "MinTemp": tn, "MaxTemp": tx,
        "Precipitation": [r[0] for r in plu.rows],
        "ReferenceET": np.clip([r[0] for r in eto.rows], 0.1, None),
        "Date": dates,
    })
    info = {
        "start": dates[0].strftime("%Y-%m-%d"), "end": dates[-1].strftime("%Y-%m-%d"),
        "days": len(dates), "files": cli, "title": tnx.title,
        "years": sorted({int(y) for y in dates.year if (dates.year == y).sum() >= 365}),
    }
    return df, info


def load_weather():
    df, info = _weather_cached()
    return df.copy(), dict(info)


@lru_cache(maxsize=None)
def crop_file(crop_name: str):
    return read_cro(_path(CROPS[crop_name]["file"]))


@lru_cache(maxsize=1)
def soil_file():
    return read_sol(_path(FILES["sol"]))


@lru_cache(maxsize=1)
def gw_file():
    return read_gwt(_path(FILES["gwt"]))


@lru_cache(maxsize=1)
def man_file():
    return read_man(_path(FILES["man"]))


def default_gw_depth() -> float:
    g = gw_file()
    return float(g.constant_depth) if g.constant_depth is not None else 10.0


# --------------------------------------------------------------------------- #
# параметры запроса
# --------------------------------------------------------------------------- #
def _parse_date(value) -> datetime:
    s = str(value).strip().replace("-", "/")
    try:
        return datetime.strptime(s, "%Y/%m/%d")
    except ValueError as exc:
        raise ValueError(f"Неверная дата '{value}' (нужен формат ГГГГ/ММ/ДД)") from exc


def normalize_params(raw: dict) -> dict:
    """Проверка входа. Бросает ValueError с понятным пользователю текстом."""
    _, w = load_weather()
    p = {}
    p["crop"] = str(raw.get("crop", "Sunflower"))
    if p["crop"] not in CROPS:
        raise ValueError(f"Неизвестная культура '{p['crop']}'. Доступно: {', '.join(CROPS)}")
    soil = str(raw.get("soil", FILE_SOIL))
    p["soil"] = SOIL_ALIASES.get(soil, soil)
    if p["soil"] not in SOILS:
        raise ValueError(f"Неизвестная почва '{soil}'. Доступно: {', '.join(SOILS)}")
    p["irrigation"] = str(raw.get("irrigation", "Rainfed"))
    if p["irrigation"] not in IRRIGATION:
        raise ValueError(f"Неизвестное управление '{p['irrigation']}'. Доступно: {', '.join(IRRIGATION)}")
    p["init_water"] = str(raw.get("initWater", "FC"))
    if p["init_water"] not in INIT_WATER:
        raise ValueError(f"Неизвестная начальная влажность '{p['init_water']}'. Доступно: FC, WP")

    gw_raw = raw.get("gwDepth", None)
    try:
        gw = default_gw_depth() if gw_raw in (None, "") else float(gw_raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("Глубина грунтовых вод должна быть числом") from exc
    if not math.isfinite(gw) or not (GW_VALID_RANGE[0] <= gw <= GW_VALID_RANGE[1]):
        raise ValueError(f"Глубина грунтовых вод должна быть от {GW_VALID_RANGE[0]} до {GW_VALID_RANGE[1]} м")
    p["gw_depth"] = round(gw, 3)

    default_start = f"{w['years'][-1]}/05/25" if w["years"] else w["start"]
    p["start"] = _parse_date(raw.get("startDate") or default_start)
    (m1, d1), (m2, d2) = PLANTING_UI
    if not (date(p["start"].year, m1, d1) <= p["start"].date() <= date(p["start"].year, m2, d2)):
        raise ValueError(f"Дата посева должна быть между {d1:02d}.{m1:02d} и {d2:02d}.{m2:02d}")

    maturity = crop_file(p["crop"]).maturity_days
    p["maturity_date"] = p["start"] + timedelta(days=maturity)
    if p["maturity_date"].year != p["start"].year:
        raise ValueError(f"{CROPS[p['crop']]['label']}: цикл {maturity} дн. при посеве {p['start']:%d.%m} "
                         f"заканчивается {p['maturity_date']:%d.%m.%Y} - в следующем году. Выберите более ранний посев.")
    year_end = datetime(p["start"].year, 12, 31)
    p["end"] = min(p["maturity_date"] + timedelta(days=HARVEST_MARGIN_DAYS), year_end)

    wstart, wend = pd.Timestamp(w["start"]), pd.Timestamp(w["end"])
    if p["start"] < wstart or p["end"] > wend:
        raise ValueError(f"Сезон {p['start']:%Y-%m-%d} .. {p['end']:%Y-%m-%d} выходит за пределы погоды "
                         f"({w['start']} .. {w['end']}).")
    return p


# --------------------------------------------------------------------------- #
# признаки ИИ-суррогата (порядок важен: тот же в server.js через model_meta.json)
# --------------------------------------------------------------------------- #
def feature_names() -> list[str]:
    _, w = load_weather()
    return (["gw_depth", "init_fc", "irrigated", "planting_doy"]
            + [f"year_{y}" for y in w["years"]]
            + [f"crop_{c}" for c in CROPS] + [f"soil_{s}" for s in SOILS])


def make_features(p: dict) -> list[float]:
    _, w = load_weather()
    row = {
        "gw_depth": p["gw_depth"],
        "init_fc": 1.0 if p["init_water"] == "FC" else 0.0,
        "irrigated": 1.0 if p["irrigation"] == "Irrigated" else 0.0,
        "planting_doy": float(p["start"].timetuple().tm_yday),
    }
    for y in w["years"]:
        row[f"year_{y}"] = 1.0 if p["start"].year == y else 0.0
    for c in CROPS:
        row[f"crop_{c}"] = 1.0 if p["crop"] == c else 0.0
    for s in SOILS:
        row[f"soil_{s}"] = 1.0 if p["soil"] == s else 0.0
    return [float(row[n]) for n in feature_names()]


# --------------------------------------------------------------------------- #
# объекты AquaCrop-OSPy
# --------------------------------------------------------------------------- #
def _compartments(depth: float) -> list[float]:
    """12 слоёв по 0.1 м, дальше по 0.2 м до глубины профиля."""
    dz = [0.1] * 12
    while sum(dz) < depth - 1e-6:
        dz.append(0.2)
    return dz


def build_soil(soil_key: str, fwcc: float, gw_on: bool, warns: list):
    from aquacrop import Soil

    if soil_key != FILE_SOIL:
        return Soil(soil_key, fwcc=fwcc), None

    sf = soil_file()
    cr_override = {i + 1: (h.cra, h.crb) for i, h in enumerate(sf.horizons)}

    class FileSoil(Soil):
        """Почва из .SOL: CRa/CRb (капиллярный подъём) берутся из файла, а не пересчитываются."""
        def add_capillary_rise_params(self):
            super().add_capillary_rise_params()
            for layer, (a, b) in cr_override.items():
                self.profile.loc[self.profile.Layer == layer, "aCR"] = a
                self.profile.loc[self.profile.Layer == layer, "bCR"] = b

    soil = FileSoil("custom", dz=_compartments(sf.depth), cn=sf.cn, rew=sf.rew, calc_cn=0, adj_rew=1, fwcc=fwcc)
    for i, h in enumerate(sf.horizons):
        # +1e-6: защита от 0.3+0.6=0.8999999 при распределении слоёв по 0.1-метровым ячейкам
        thick = h.thickness + (1e-6 if i else 0.0)
        soil.add_layer(thick, h.wp / 100.0, h.fc / 100.0, h.sat / 100.0, h.ksat, h.penetrability)
    layers = soil.profile.dropna(subset=["Layer"]).Layer.nunique()
    if layers != len(sf.horizons):
        raise RuntimeError(f"Почва: из {len(sf.horizons)} горизонтов в профиль попало {layers}")
    return soil, sf


def build_crop(crop_name: str, start: datetime, end: datetime):
    from aquacrop import Crop
    cf = crop_file(crop_name)
    crop = Crop("custom", planting_date=start.strftime("%m/%d"), harvest_date=end.strftime("%m/%d"), **cf.params)
    crop.Name = crop_name
    not_applied = [k for k, v in cf.params.items() if not _same(getattr(crop, k, None), v)]
    if not_applied:
        raise RuntimeError("Параметры культуры не применились в aquacrop: " + ", ".join(not_applied))
    return crop, cf


def _same(a, b) -> bool:
    try:
        return abs(float(a) - float(b)) < 1e-9
    except (TypeError, ValueError):
        return a == b


def build_groundwater(depth: float, start: datetime):
    from aquacrop import GroundWater
    return GroundWater(water_table="Y", method="Constant", dates=[start.strftime("%Y/%m/%d")], values=[depth])


def build_field_management(warns: list):
    from aquacrop import FieldMngt
    m = man_file()
    kw = {}
    if m.mulch_pct > 0:
        kw.update(mulches=True, mulch_pct=m.mulch_pct, f_mulch=m.mulch_effect_pct / 100.0)
    if m.bund_height_m > 0:
        kw.update(bunds=True, z_bund=m.bund_height_m)
    return FieldMngt(**kw), m


def not_modeled_notes() -> list[str]:
    """Что есть в ваших файлах, но не учитывается AquaCrop-OSPy (в настольном AquaCrop учитывается)."""
    m = man_file()
    notes = []
    if m.fertility_stress_pct > 0:
        notes.append(f"Стресс плодородия {m.fertility_stress_pct:g}% (.MAN) - в AquaCrop-OSPy не моделируется, "
                     "поэтому урожай может быть выше, чем в настольном AquaCrop.")
    if m.weed_cover_pct > 0:
        notes.append(f"Сорняки {m.weed_cover_pct:g}% (.MAN) - в AquaCrop-OSPy не моделируются.")
    g = gw_file()
    if g.records and g.records[0][2] > 0:
        notes.append(f"Засолённость грунтовых вод ECw={g.records[0][2]:g} dS/m (.GWT) - солевой режим в OSPy не моделируется.")
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
    from aquacrop import AquaCropModel, InitialWaterContent

    p = normalize_params(raw_params)
    weather, winfo = load_weather()
    warns: list[str] = []

    crop, cf = build_crop(p["crop"], p["start"], p["end"])
    soil, sf = build_soil(p["soil"], fwcc=cf.extra["fwcc"], gw_on=True, warns=warns)
    gw = build_groundwater(p["gw_depth"], p["start"])
    fm, man = build_field_management(warns)
    kwargs = {}
    if p["irrigation"] == "Irrigated":
        from aquacrop import IrrigationManagement
        kwargs["irrigation_management"] = IrrigationManagement(irrigation_method=1, SMT=[IRRIGATION_SMT] * 4)

    model = AquaCropModel(
        sim_start_time=p["start"].strftime("%Y/%m/%d"),
        sim_end_time=p["end"].strftime("%Y/%m/%d"),
        weather_df=weather, soil=soil, crop=crop,
        initial_water_content=InitialWaterContent(value=[p["init_water"]]),
        groundwater=gw, field_management=fm, **kwargs,
    )
    model.run_model(till_termination=True)

    stats = model.get_simulation_results()
    if stats is None or stats.empty or "Dry yield (tonne/ha)" not in stats.columns:
        raise RuntimeError("aquacrop не вернул итог сезона (культура не дошла до уборки)")
    yield_val = float(stats["Dry yield (tonne/ha)"].iloc[0])
    yield_pot = float(stats["Yield potential (tonne/ha)"].iloc[0]) if "Yield potential (tonne/ha)" in stats else None
    if not math.isfinite(yield_val):
        raise RuntimeError("aquacrop вернул нечисловой урожай")

    cg = _season_rows(model.get_crop_growth())
    wf = _season_rows(model.get_water_flux())
    n = min(len(cg), len(wf))
    cg, wf = cg.iloc[:n], wf.iloc[:n]
    biomass_t = float(_col(cg, "biomass")[-1]) / 100.0     # г/м2 -> т/га
    hi = float(_col(cg, "harvest_index_adj")[-1])

    # проверка: CRa/CRb в движке совпадают с файлом
    if sf is not None:
        prof = model._param_struct.Soil.profile
        for i, h in enumerate(sf.horizons, start=1):
            row = prof[prof.Layer == i]
            if not row.empty and (abs(float(row.aCR.iloc[0]) - h.cra) > 1e-6 or abs(float(row.bCR.iloc[0]) - h.crb) > 1e-6):
                warns.append(f"CRa/CRb горизонта {i} в движке отличаются от .SOL")

    harvest_date = str(stats["Harvest Date (YYYY/MM/DD)"].iloc[0])[:10] if "Harvest Date (YYYY/MM/DD)" in stats else None
    out = {
        "success": True,
        "yield_tonne_ha": round(yield_val, 2),
        "location": LOCATION,
        "crop": p["crop"],
        "period": f"{p['start']:%Y/%m/%d} - {harvest_date or p['end'].strftime('%Y/%m/%d')}",
        "irrigation": p["irrigation"],
        "warnings": warns,
        "environment": {
            "engine": "AquaCrop-OSPy (Python-реализация методики ФАО AquaCrop)",
            "climate": f"{FILES['cli']}: {winfo['files']['tnx']}, {winfo['files']['eto']}, {winfo['files']['plu']} "
                       f"({winfo['start']} .. {winfo['end']})",
            "crop": f"{CROPS[p['crop']]['file']}: цикл {cf.maturity_days} дн., HI0={cf.params['HI0']*100:g}%, "
                    f"CCx={cf.params['CCx']:g}, WP*={cf.params['WP']:g} г/м2",
            "soil": (f"{FILES['sol']}: " + "; ".join(f"{h.thickness:g} м {h.description} (FC {h.fc:g}%, WP {h.wp:g}%)" for h in sf.horizons)
                     if sf else SOILS[p["soil"]]),
            "groundwater": f"{p['gw_depth']:.2f} м, постоянный уровень"
                           + (" (как в .GWT)" if abs(p["gw_depth"] - default_gw_depth()) < 1e-6 else f" (в .GWT: {default_gw_depth():.2f} м)"),
            "management": f"{FILES['man']}: мульча {man.mulch_pct:g}%, валики {man.bund_height_m:g} м; "
                          + (f"орошение по порогу {IRRIGATION_SMT}% TAW (сценарий)" if p["irrigation"] == "Irrigated" else "богара"),
            "initial_water": "полевая влагоёмкость (FC)" if p["init_water"] == "FC" else "точка увядания (WP)",
            "not_modeled": not_modeled_notes(),
        },
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
        "rain": total(rain),
        "irrigation": total(_col(wf, "IrrDay")),
        "infiltrated": total(_col(wf, "Infl")),
        "runoff": total(_col(wf, "Runoff")),
        "deep_percolation": total(_col(wf, "DeepPerc")),
        "capillary_rise": total(cr),
        "transpiration": total(tr),
        "evaporation": total(_col(wf, "Es")),
    }
    out["production_details"] = {
        "actual_biomass": round(biomass_t, 2),
        "harvest_index": round(hi * 100.0, 1),
        "yield_potential": None if yield_pot is None else round(yield_pot, 2),
        "max_canopy_cover": round(float(np.nanmax(cc)), 1),
    }
    out["charts"] = {
        "days": list(range(1, n + 1)),
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "canopy_cover": [round(float(v), 1) for v in cc],
        "transpiration": [round(float(v), 2) for v in tr],
        "rain": [round(float(v), 1) for v in rain],
        "capillary_rise": [round(float(v), 2) for v in cr],
    }
    return to_jsonable(out)


def config_info() -> dict:
    """Для /api/config: справочники, допустимые даты, значения по умолчанию из файлов."""
    _, w = load_weather()
    years = w["years"]
    (m1, d1), (m2, d2) = PLANTING_UI
    return to_jsonable({
        "location": LOCATION,
        "crops": {k: {"label": v["label"], "file": v["file"], "maturity": crop_file(k).maturity_days} for k, v in CROPS.items()},
        "soils": SOILS,
        "default_soil": FILE_SOIL,
        "weather": {k: w[k] for k in ("start", "end", "days", "years")},
        "planting": {"min": date(years[0], m1, d1).isoformat(), "max": date(years[-1], m2, d2).isoformat(),
                     "window_md": [f"{m1:02d}-{d1:02d}", f"{m2:02d}-{d2:02d}"],
                     "default": date(years[-1], 5, 25).isoformat()},
        "groundwater": {"min": GW_TRAIN_RANGE[0], "max": GW_TRAIN_RANGE[1], "default": default_gw_depth(),
                        "file": FILES["gwt"], "file_title": gw_file().title},
        "not_modeled": not_modeled_notes(),
    })
