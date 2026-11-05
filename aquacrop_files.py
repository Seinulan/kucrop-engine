"""
aquacrop_files.py - чтение файлов настольного AquaCrop (версии 7.x).

Поддерживается: .CRO (культура), .SOL (почва), .GWT (грунтовые воды), .MAN (управление полем),
.CLI (список климатических файлов), .Tnx / .ETo / .PLU (суточная погода).

Только чтение и разбор текста, без зависимостей от пакета aquacrop - поэтому модуль легко проверить
отдельно (см. tests/test_files.py). Перевод в объекты AquaCrop-OSPy делает kucrop_core.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


def _read(path: Path) -> list[str]:
    if not Path(path).exists():
        raise FileNotFoundError(f"Не найден файл AquaCrop: {Path(path).name}")
    # файлы AquaCrop пишутся в Windows-кодировке (знак градуса), строки с CRLF
    return Path(path).read_bytes().decode("latin-1").replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _value_lines(lines: list[str]) -> list[tuple[float, str]]:
    """Строки вида '   0.25   : описание' -> (0.25, 'описание'). Нумерация как в файле (строка 1 = описание)."""
    out = []
    for line in lines:
        if ":" not in line:
            out.append((None, line.strip()))
            continue
        head, _, desc = line.partition(":")
        try:
            out.append((float(head.split()[0]), desc.strip()))
        except (ValueError, IndexError):
            out.append((None, line.strip()))
    return out


# --------------------------------------------------------------------------- #
# .CRO - культура
# --------------------------------------------------------------------------- #
# номер строки в файле (1 = заголовок) -> (атрибут Crop в AquaCrop-OSPy, ключевое слово описания, перевод)
# Перевод нужен там, где единицы в файле и в OSPy различаются (проценты -> доли и т.п.).
CRO_MAP = {
    6: ("CalendarType", "crop cycle", None),
    7: ("ETadj", "adjusted by eto", None),
    8: ("Tbase", "base temperature", None),
    9: ("Tupp", "upper temperature", None),
    11: ("p_up1", "canopy expansion", None),
    12: ("p_lo1", "canopy expansion", None),
    13: ("fshape_w1", "canopy expansion", None),
    14: ("p_up2", "stomatal control", None),
    15: ("fshape_w2", "stomatal control", None),
    16: ("p_up3", "canopy senescence", None),
    17: ("fshape_w3", "canopy senescence", None),
    19: ("p_up4", "pollination", None),
    20: ("Aer", "anaerobiotic", None),
    27: ("Tmin_up", "minimum air temperature", None),
    28: ("Tmax_up", "maximum air temperature", None),
    29: ("GDD_up", "minimum growing degrees", None),
    35: ("Kcb", "crop coefficient when canopy is complete", None),
    36: ("fage", "decline of crop coefficient", None),
    37: ("Zmin", "minimum effective rooting depth", None),
    38: ("Zmax", "maximum effective rooting depth", None),
    39: ("fshape_r", "root zone expansion", lambda v: v / 10.0),     # в файле 15 = 1.5
    40: ("SxTopQ", "top quarter", None),
    41: ("SxBotQ", "bottom quarter", None),
    43: ("SeedSize", "seedling", None),
    45: ("PlantPop", "plants per hectare", None),
    46: ("CGC_CD", "canopy growth coefficient", None),
    50: ("CCx", "maximum canopy cover", None),
    51: ("CDC_CD", "canopy decline coefficient", None),
    52: ("EmergenceCD", "to emergence", None),
    53: ("MaxRootingCD", "maximum rooting depth", None),
    54: ("SenescenceCD", "start senescence", None),
    55: ("MaturityCD", "to maturity", None),
    56: ("HIstartCD", "to flowering", None),
    57: ("FloweringCD", "length of the flowering", None),
    58: ("Determinant", "determinancy", None),
    59: ("exc", "excess of potential fruits", None),
    60: ("YldFormCD", "building up of harvest index", None),
    61: ("WP", "water productivity normalized", None),
    62: ("WPy", "during yield formation", None),
    63: ("fsink", "co2", lambda v: v / 100.0),                       # % -> доля
    64: ("HI0", "reference harvest index", lambda v: v / 100.0),     # % -> доля
    65: ("dHI_pre", "before flowering", None),
    66: ("a_HI", "positive impact", None),
    67: ("b_HI", "negative impact", None),
    68: ("dHI0", "allowable maximum increase", None),
}
# фенология в градусо-днях (используется, если цикл задан в GDD: строка 6 = 2)
CRO_GDD_MAP = {
    69: ("Emergence", "gddays: from sowing to emergence"),
    70: ("MaxRooting", "gddays: from sowing to maximum rooting"),
    71: ("Senescence", "gddays: from sowing to start senescence"),
    72: ("Maturity", "gddays: from sowing to maturity"),
    73: ("HIstart", "gddays: from sowing to flowering"),
    74: ("Flowering", "length of the flowering stage"),
    75: ("CGC", "cgc for ggdays"),
    76: ("CDC", "cdc for ggdays"),
    77: ("YldForm", "gddays: building-up of harvest index"),
}
# строки, которые читаются, но не являются параметрами Crop
CRO_EXTRA = {
    4: ("crop_type_file", "crop"),                  # 1 листовые, 2 зерновые/плодовые, 3 корнеплоды
    5: ("plant_method_file", "sown"),               # 1 посев, 0 рассада
    21: ("fertility_calibration_pct", "soil fertility stress"),
    42: ("fwcc", "reducing soil evaporation"),      # в OSPy это параметр почвы (Soil.fwcc)
    78: ("dry_matter_pct", "dry matter content"),
}
# тип культуры: код настольного AquaCrop -> код OSPy (OSPy: 1 листовые, 2 корнеплоды, 3 зерновые)
CROP_TYPE_TO_OSPY = {1: 1, 2: 3, 3: 2}


@dataclass
class CropFile:
    path: str
    title: str
    version: float
    params: dict            # готовые аргументы для aquacrop.Crop(...)
    extra: dict             # прочее из файла (fwcc, калибровка плодородия, сухое вещество)
    calendar_days: bool     # True - фенология в календарных днях

    @property
    def maturity_days(self) -> int:
        return int(self.params["MaturityCD"])


def read_cro(path) -> CropFile:
    lines = _value_lines(_read(path))
    title = lines[0][1] if lines else ""

    def get(n, kw):
        if n > len(lines):
            raise ValueError(f"{Path(path).name}: в файле меньше {n} строк - формат не AquaCrop 7.x")
        val, desc = lines[n - 1]
        if val is None or kw not in desc.lower():
            raise ValueError(f"{Path(path).name}, строка {n}: ожидалось '{kw}', найдено '{desc[:70]}'")
        return val

    version = get(2, "aquacrop version")
    params, extra = {}, {}
    for n, (attr, kw, conv) in CRO_MAP.items():
        v = get(n, kw)
        params[attr] = conv(v) if conv else v
    for n, (key, kw) in CRO_EXTRA.items():
        extra[key] = get(n, kw)

    calendar = int(params["CalendarType"]) == 1
    if int(params["CalendarType"]) not in (1, 2):
        raise ValueError(f"{Path(path).name}: неизвестный тип цикла {params['CalendarType']} (1 - дни, 2 - градусо-дни)")

    # целые значения - целыми
    for k in ("CalendarType", "ETadj", "EmergenceCD", "MaxRootingCD", "SenescenceCD", "MaturityCD",
              "HIstartCD", "FloweringCD", "YldFormCD", "Determinant"):
        params[k] = int(params[k])
    params["PlantPop"] = float(params["PlantPop"])

    # параметры, которые AquaCrop выводит из файла сам (как во встроенных культурах OSPy)
    params["Tmin_lo"] = params["Tmin_up"] - 5.0     # полный отказ опыления на 5 °C ниже порога
    params["Tmax_lo"] = params["Tmax_up"] + 5.0
    params["GDD_lo"] = 0
    params["p_lo2"] = params["p_lo3"] = params["p_lo4"] = 1
    params["fshape_w4"] = 1
    params["CropType"] = CROP_TYPE_TO_OSPY.get(int(extra["crop_type_file"]), 3)
    params["PlantMethod"] = int(extra["plant_method_file"])
    params["GDDmethod"] = 3
    params["SwitchGDD"] = 0
    if extra["dry_matter_pct"] > 0:
        params["YldWC"] = extra["dry_matter_pct"]
    if calendar:
        # при календарном цикле значения в GDD не используются (как у встроенных культур OSPy)
        for k in ("Emergence", "MaxRooting", "Senescence", "Maturity", "HIstart", "Flowering", "YldForm", "CGC", "CDC"):
            params[k] = -9.0
    else:
        for n, (attr, kw) in CRO_GDD_MAP.items():
            v = get(n, kw)
            if v <= 0:
                raise ValueError(f"{Path(path).name}, строка {n}: цикл в градусо-днях, но значение не задано ({v:g})")
            params[attr] = v
        params["CalendarType"] = 2
    if params["MaturityCD"] <= 0:
        raise ValueError(f"{Path(path).name}: не задана длина цикла в днях (строка 55) - нужна для выбора даты уборки")

    return CropFile(path=str(path), title=title, version=version, params=params, extra=extra,
                    calendar_days=calendar)


# --------------------------------------------------------------------------- #
# .SOL - почва
# --------------------------------------------------------------------------- #
@dataclass
class SoilHorizon:
    thickness: float    # м
    sat: float          # объёмн. %
    fc: float
    wp: float
    ksat: float         # мм/сут
    penetrability: float
    gravel: float
    cra: float
    crb: float
    description: str


@dataclass
class SoilFile:
    path: str
    cn: float
    rew: float
    horizons: list = field(default_factory=list)

    @property
    def depth(self) -> float:
        return round(sum(h.thickness for h in self.horizons), 3)


def read_sol(path) -> SoilFile:
    raw = _read(path)
    vals = _value_lines(raw)
    cn = rew = n = None
    for v, desc in vals[:8]:
        d = desc.lower()
        if v is None:
            continue
        if "curve number" in d:
            cn = v
        elif "readily evaporable" in d:
            rew = v
        elif "number of soil horizons" in d:
            n = int(v)
    if cn is None or rew is None or n is None:
        raise ValueError(f"{Path(path).name}: не найдены CN / REW / число горизонтов")

    horizons = []
    for line in raw:
        parts = line.split()
        if len(parts) < 9:
            continue
        try:
            nums = [float(x) for x in parts[:9]]
        except ValueError:
            continue
        horizons.append(SoilHorizon(*nums, description=" ".join(parts[9:])))
    if len(horizons) != n:
        raise ValueError(f"{Path(path).name}: заявлено горизонтов {n}, прочитано {len(horizons)}")
    for h in horizons:
        if not (0 < h.wp < h.fc < h.sat <= 100):
            raise ValueError(f"{Path(path).name}: неверные влажности в горизонте '{h.description}'")
    return SoilFile(path=str(path), cn=cn, rew=rew, horizons=horizons)


# --------------------------------------------------------------------------- #
# .GWT - грунтовые воды
# --------------------------------------------------------------------------- #
@dataclass
class GroundwaterFile:
    path: str
    title: str
    mode: int            # 0 - нет грунтовых вод, 1 - постоянная глубина, 2 - переменная
    records: list        # [(день, глубина м, ECw dS/m)]; день 1 = first_date
    first_date: tuple = None   # (год, месяц, день) для режима 2; год 1901 = не привязан к году

    @property
    def constant_depth(self):
        return self.records[0][1] if self.mode == 1 and self.records else None

    def daily_depths(self, start, days: int) -> list:
        """Глубина на каждый день сезона (режим 2: линейная интерполяция, за краями - крайние значения)."""
        import datetime as _dt
        y, m, d = self.first_date or (start.year, 1, 1)
        if y <= 1901:
            y = start.year
        base = _dt.date(y, m, d)
        xs = [(base + _dt.timedelta(days=r[0] - 1) - start.date()).days for r in self.records]
        ys = [r[1] for r in self.records]
        out = []
        for t in range(days):
            if t <= xs[0]:
                out.append(ys[0])
            elif t >= xs[-1]:
                out.append(ys[-1])
            else:
                i = next(k for k in range(1, len(xs)) if xs[k] >= t)
                f = (t - xs[i - 1]) / (xs[i] - xs[i - 1])
                out.append(ys[i - 1] + f * (ys[i] - ys[i - 1]))
        return out


def read_gwt(path) -> GroundwaterFile:
    raw = _read(path)
    vals = _value_lines(raw)
    title = raw[0].strip() if raw else ""
    mode = None
    for v, desc in vals[1:6]:
        if v is not None and "groundwater" in desc.lower():
            mode = int(v)
            break
    if mode is None:
        raise ValueError(f"{Path(path).name}: не найден режим грунтовых вод")
    if mode not in (0, 1, 2):
        raise ValueError(f"{Path(path).name}: неизвестный режим грунтовых вод {mode} (0 - нет, 1 - постоянный, 2 - переменный)")
    first = {}
    for v, desc in vals[1:10]:
        dl = desc.lower()
        if v is None:
            continue
        for key in ("day", "month", "year"):
            if dl.startswith(f"first {key}"):
                first[key] = int(v)
    first_date = (first["year"], first["month"], first["day"]) if len(first) == 3 else None
    records = []
    sep = next((i for i, l in enumerate(raw) if l.strip().startswith("=")), None)
    if sep is not None:
        for line in raw[sep + 1:]:
            p = line.split()
            if len(p) >= 3:
                try:
                    records.append((int(float(p[0])), float(p[1]), float(p[2])))
                except ValueError:
                    pass
    if mode in (1, 2) and not records:
        raise ValueError(f"{Path(path).name}: нет строк с глубиной грунтовых вод")
    for _, depth, _ in records:
        if not (0 < depth <= 30):
            raise ValueError(f"{Path(path).name}: глубина {depth} м вне разумных пределов (0-30 м)")
    if mode == 2:
        days = [r[0] for r in records]
        if days != sorted(days) or len(set(days)) != len(days):
            raise ValueError(f"{Path(path).name}: дни наблюдений должны идти по возрастанию без повторов")
    return GroundwaterFile(path=str(path), title=title, mode=mode, records=records, first_date=first_date)


# --------------------------------------------------------------------------- #
# .MAN - управление полем
# --------------------------------------------------------------------------- #
@dataclass
class ManagementFile:
    path: str
    mulch_pct: float
    mulch_effect_pct: float
    fertility_stress_pct: float
    bund_height_m: float
    weed_cover_pct: float
    weed_increase_pct: float


def read_man(path) -> ManagementFile:
    vals = _value_lines(_read(path))

    def find(kw, nth=0):
        hits = [v for v, d in vals if v is not None and kw in d.lower()]
        if len(hits) <= nth:
            raise ValueError(f"{Path(path).name}: не найдена строка '{kw}'")
        return hits[nth]

    return ManagementFile(
        path=str(path),
        mulch_pct=find("covered by mulches"),
        mulch_effect_pct=find("effect (%) of mulches"),
        fertility_stress_pct=find("soil fertility stress"),
        bund_height_m=find("soil bunds"),
        weed_cover_pct=find("relative cover of weeds at canopy closure"),
        weed_increase_pct=find("increase of relative cover of weeds"),
    )


# --------------------------------------------------------------------------- #
# .CLI и погода
# --------------------------------------------------------------------------- #
def read_cli(path) -> dict:
    """Возвращает {'tnx': ..., 'eto': ..., 'plu': ..., 'co2': ...} - имена файлов из .CLI."""
    names = [l.strip() for l in _read(path) if l.strip() and ":" not in l]
    by_ext = {Path(n).suffix.lower(): n for n in names}
    missing = [e for e in (".tnx", ".eto", ".plu") if e not in by_ext]
    if missing:
        raise ValueError(f"{Path(path).name}: нет ссылок на {', '.join(missing)}")
    return {"tnx": by_ext[".tnx"], "eto": by_ext[".eto"], "plu": by_ext[".plu"], "co2": by_ext.get(".co2")}


@dataclass
class ClimateSeries:
    path: str
    title: str
    first_date: tuple      # (год, месяц, день)
    rows: list             # списки чисел по дням


def read_climate_series(path, ncols: int) -> ClimateSeries:
    raw = _read(path)
    title = raw[0].strip() if raw else ""
    vals = _value_lines(raw[:8])
    head = {}
    for v, d in vals:
        d = d.lower()
        if v is None:
            continue
        if d.startswith("daily records"):
            head["kind"] = int(v)
        elif d.startswith("first day"):
            head["day"] = int(v)
        elif d.startswith("first month"):
            head["month"] = int(v)
        elif d.startswith("first year"):
            head["year"] = int(v)
    if head.get("kind") != 1:
        raise ValueError(f"{Path(path).name}: поддерживаются только суточные данные (Daily records = 1)")
    if head.get("year", 1901) <= 1901:
        raise ValueError(f"{Path(path).name}: ряд не привязан к году (First year = 1901) - нужен реальный год")
    sep = next((i for i, l in enumerate(raw[:30]) if l.strip().startswith("=")), None)
    if sep is None:
        raise ValueError(f"{Path(path).name}: не найдена строка-разделитель '====='")
    rows = []
    for i, line in enumerate(raw[sep + 1:], start=sep + 2):
        if not line.strip():
            continue
        p = line.split()
        try:
            rows.append([float(x) for x in p[:ncols]])
        except ValueError as exc:
            raise ValueError(f"{Path(path).name}, строка {i}: не число: '{line.strip()}'") from exc
        if len(rows[-1]) != ncols:
            raise ValueError(f"{Path(path).name}, строка {i}: ожидалось {ncols} чисел")
    return ClimateSeries(path=str(path), title=title, first_date=(head["year"], head["month"], head["day"]), rows=rows)
