"""
generate_model.py - обучение ИИ-суррогата поверх физического ядра.

  1. Прогоняет N симуляций AquaCrop через ТОТ ЖЕ simulate(), что и сайт:
     культура x почва x орошение x влажность x год погоды, плюс случайные глубина грунтовых вод и дата посева.
  2. Обучает ExtraTrees (по умолчанию) или RandomForest; честная оценка: отложенная выборка (R2, RMSE, MAE),
     кросс-валидация и проверка на целиком отложенном годе погоды.
  3. Пишет aquacrop_model.onnx, model_meta.json (порядок признаков, диапазоны, метрики) и training_data.csv.

  python generate_model.py            # ~720 симуляций (несколько минут)
  python generate_model.py --n 150    # быстрый пробный прогон
"""
import argparse
import itertools
import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from kucrop_core import (BASE_DIR, CROPS, GW_TRAIN_RANGE, INIT_WATER, IRRIGATION, PLANTING_TRAIN, SOILS,
                         feature_names, load_weather, make_features, normalize_params, simulate)
from onnx_export import export, verify

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

MODELS = {
    # ExtraTrees - «сверхслучайный лес»: та же структура деревьев, что у RandomForest, на наших данных точнее
    "et": ("ExtraTreesRegressor", dict(n_estimators=200, min_samples_leaf=1, random_state=42, n_jobs=-1)),
    "rf": ("RandomForestRegressor", dict(n_estimators=200, min_samples_leaf=2, random_state=42, n_jobs=-1)),
}


def make_model(kind: str, **override):
    import sklearn.ensemble as ens
    cls_name, params = MODELS[kind]
    return getattr(ens, cls_name)(**{**params, **override})


def sample_configs(n: int, seed: int, years: list):
    rng = np.random.default_rng(seed)
    combos = list(itertools.product(CROPS, SOILS, IRRIGATION, INIT_WATER, years))
    reps = max(1, math.ceil(n / len(combos)))
    (m1, d1), (m2, d2) = PLANTING_TRAIN
    configs = []
    for crop, soil, irr, iw, year in combos:
        lo, hi = datetime(year, m1, d1), datetime(year, m2, d2)
        for _ in range(reps):
            start = lo + timedelta(days=int(rng.integers(0, (hi - lo).days + 1)))
            configs.append({"crop": crop, "soil": soil, "irrigation": irr, "initWater": iw,
                            "gwDepth": round(float(rng.uniform(*GW_TRAIN_RANGE)), 2),
                            "startDate": start.strftime("%Y/%m/%d")})
    rng.shuffle(configs)
    return configs


def metrics(y_true, y_pred):
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    return {"r2": round(float(r2_score(y_true, y_pred)), 4),
            "rmse_t_ha": round(float(math.sqrt(mean_squared_error(y_true, y_pred))), 4),
            "mae_t_ha": round(float(mean_absolute_error(y_true, y_pred)), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=720, help="примерное число симуляций")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(BASE_DIR / "aquacrop_model.onnx"))
    ap.add_argument("--model", choices=list(MODELS), default="et", help="et = ExtraTrees (по умолчанию), rf = RandomForest")
    ap.add_argument("--reuse-data", action="store_true",
                    help="не запускать симуляции заново, взять training_data.csv (если признаки совпадают)")
    args = ap.parse_args()

    from sklearn.model_selection import cross_val_score, train_test_split

    _, w = load_weather()
    names = feature_names()
    data_csv = BASE_DIR / "training_data.csv"
    if args.reuse_data:
        if not data_csv.exists():
            raise SystemExit("Нет training_data.csv - запустите без --reuse-data")
        df = pd.read_csv(data_csv)
        if [c for c in names if c not in df.columns]:
            raise SystemExit("training_data.csv собран с другими признаками - запустите без --reuse-data")
        print(f"Используются готовые данные: {len(df)} симуляций из training_data.csv")
        configs = []
    else:
        configs = sample_configs(args.n, args.seed, w["years"])
        print(f"Обучение ИИ-суррогата: {len(configs)} симуляций AquaCrop, годы погоды {w['years']}")

    rows, failures, t0 = [], [], time.time()
    for i, cfg in enumerate(configs, 1):
        try:
            p = normalize_params(cfg)
            res = simulate(cfg, detail=False)
            rows.append({**dict(zip(feature_names(), make_features(p))), "yield": res["yield_tonne_ha"],
                         "crop": cfg["crop"], "soil": cfg["soil"], "irrigation": cfg["irrigation"],
                         "init_water": cfg["initWater"], "year": p["start"].year, "start": cfg["startDate"]})
        except Exception as exc:
            failures.append((cfg, f"{type(exc).__name__}: {exc}"))
        if i % 50 == 0 or i == len(configs):
            el = time.time() - t0
            print(f"  {i}/{len(configs)}  ok={len(rows)} ошибок={len(failures)}  {el:.0f} с, осталось ~{el / i * (len(configs) - i):.0f} с", flush=True)

    if failures:
        print(f"\nНеудачных симуляций: {len(failures)}. Первые:")
        for cfg, msg in failures[:3]:
            print("  ", cfg, "->", msg)
    if configs:
        if len(failures) > 0.05 * len(configs) or len(rows) < 50:
            raise SystemExit("Слишком много неудачных симуляций - обучение остановлено (метки нельзя придумывать).")
        df = pd.DataFrame(rows)
        df.to_csv(data_csv, index=False)
    X = df[names].to_numpy(dtype=np.float32)
    y = df["yield"].to_numpy(dtype=np.float32)
    if float(np.std(y)) < 1e-3:
        raise SystemExit("Все урожаи одинаковы - физическая модель не реагирует на входы. Запустите python selfcheck.py")

    print("\nСредний урожай по факторам (т/га):")
    for col in ("crop", "soil", "irrigation", "init_water", "year"):
        print(f"   {col:11s}", df.groupby(col)["yield"].mean().round(2).to_dict())

    # 1) случайная отложенная выборка 20%
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=args.seed)
    rf = make_model(args.model).fit(Xtr, ytr)
    m_test = metrics(yte, rf.predict(Xte))
    # 2) кросс-валидация
    cv = cross_val_score(make_model(args.model, n_estimators=100), X, y, cv=5, scoring="r2")
    # 3) отложенный год: модель не видела погоду этого года вовсе (честная проверка на новый сезон)
    by_year = {}
    for yr in w["years"]:
        tr, te = df["year"] != yr, df["year"] == yr
        m = make_model(args.model, n_estimators=100).fit(X[tr.values], y[tr.values])
        by_year[str(yr)] = metrics(y[te.values], m.predict(X[te.values]))

    # ошибка по культурам (на отложенной выборке) - видно, где суррогат слабее
    te_crop = pd.DataFrame(Xte, columns=names)
    per_crop = {}
    for c in CROPS:
        mask = te_crop[f"crop_{c}"].to_numpy() == 1
        if mask.sum() > 2:
            per_crop[c] = metrics(yte[mask], rf.predict(Xte[mask]))
    report = {
        "per_crop_test": per_crop,
        "test_random_20pct": m_test,
        "cv5_r2_mean": round(float(cv.mean()), 4), "cv5_r2_std": round(float(cv.std()), 4),
        "leave_one_year_out": by_year,
        "yield_mean_t_ha": round(float(np.mean(y)), 3), "yield_std_t_ha": round(float(np.std(y)), 3),
        "n_train": int(len(ytr)), "n_test": int(len(yte)),
        # плоские поля для интерфейса
        "r2_test": m_test["r2"], "rmse_test_t_ha": m_test["rmse_t_ha"], "mae_test_t_ha": m_test["mae_t_ha"],
    }
    print(f"\nОтложенная выборка 20%: R2={m_test['r2']}  RMSE={m_test['rmse_t_ha']} т/га  MAE={m_test['mae_t_ha']} т/га")
    for c, m in per_crop.items():
        print(f"   {c:10s} R2={m['r2']}  RMSE={m['rmse_t_ha']} т/га")
    print(f"Кросс-валидация (5): R2={report['cv5_r2_mean']} +/- {report['cv5_r2_std']}")
    print("Отложенный год (погода года не участвовала в обучении):")
    for yr, m in by_year.items():
        print(f"   {yr}: R2={m['r2']}  RMSE={m['rmse_t_ha']} т/га")

    final = make_model(args.model).fit(X, y)
    importances = sorted(zip(names, final.feature_importances_), key=lambda t: -t[1])
    print("Важность признаков:", ", ".join(f"{n}={v:.2f}" for n, v in importances[:8]))

    onnx_bytes, exporter = export(final, len(names))
    diff = verify(onnx_bytes, final, X)
    if diff > 1e-3:
        raise SystemExit(f"ONNX расходится со sklearn (макс. {diff:.5f}) - файл не записан")
    Path(args.out).write_bytes(onnx_bytes)

    meta = {
        "input_name": "float_input",
        "feature_names": names,
        "categories": {"crop": list(CROPS), "soil": list(SOILS), "year": w["years"]},
        "ranges": {"gw_depth": list(GW_TRAIN_RANGE),
                   "planting_doy": [int(df["planting_doy"].min()), int(df["planting_doy"].max())],
                   "years": w["years"]},
        "model": MODELS[args.model][0],
        "metrics": report,
        "feature_importance": {n: round(float(v), 4) for n, v in importances},
        "n_samples": int(len(df)),
        "exporter": exporter,
        "onnx_vs_sklearn_max_diff": diff,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "Суррогат воспроизводит AquaCrop только для погоды Полтавки 2021-2024 и диапазонов из 'ranges'.",
    }
    (BASE_DIR / "model_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nГотово: {Path(args.out).name} ({Path(args.out).stat().st_size / 1024:.0f} КБ, экспорт: {exporter}, "
          f"ONNX vs sklearn: {diff:.1e}), model_meta.json, training_data.csv")


if __name__ == "__main__":
    main()
