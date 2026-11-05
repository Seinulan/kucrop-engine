"""
generate_model.py - обучение ИИ-суррогата поверх физического ядра (целевой год TARGET_YEAR = 2024).

  1. Прогоняет N симуляций AquaCrop через ТОТ ЖЕ simulate(), что и сайт:
     культура (final/Wheat/Barley.CRO) x почва x орошение x начальная влажность,
     плюс случайные глубина грунтовых вод и дата посева в окне целевого года.
     Климат, .MAN и тип грунтовых вод - файлы по умолчанию (kucrop_core.DEFAULTS).
  2. Обучает ExtraTrees (или RandomForest); честная оценка: отложенная выборка 20%, кросс-валидация,
     ошибка по каждой культуре; замер скорости физики и ИИ.
  3. Пишет aquacrop_model.onnx, model_meta.json (признаки, диапазоны, метрики, хеши файлов обучения)
     и training_data.csv. Хеши нужны сайту: ИИ показывается только для тех файлов, на которых он обучен.

  python generate_model.py            # ~1440 симуляций (несколько минут)
  python generate_model.py --n 200    # быстрый пробный прогон
  python generate_model.py --spec spec.json --out-dir tmp/   # обучение на выбранных файлах (так запускает сайт)
      spec.json: {"cli": "Poltavka.CLI", "man": "final_2.MAN", "gwt": "Poltavka_0712.GWT",
                  "crops": ["final.CRO", "user_files/my.CRO"], "soils": ["Poltavka_NKA.SOL", "aquacrop:Loam"]}
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

from kucrop_core import (BASE_DIR, DEFAULTS, GW_TRAIN_RANGE, INIT_WATER, IRRIGATION, META_PATH, PLANTING_TRAIN,
                         TARGET_YEAR, TRAIN_CROPS, TRAIN_SOILS, apply_training_spec, feature_names, make_features,
                         normalize_params, simulate, training_fingerprint)
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


def sample_gw(rng) -> float:
    """Глубина грунтовых вод: 60% в зоне влияния (1-3 м), 40% - глубже (3-10 м).
    При равномерной выборке мелких глубин мало, и ИИ хуже ловит эффект капиллярного подъёма."""
    lo, hi = GW_TRAIN_RANGE
    if rng.random() < 0.6:
        return round(float(rng.uniform(lo, 3.0)), 2)
    return round(float(rng.uniform(3.0, hi)), 2)


def sample_configs(n: int, seed: int):
    rng = np.random.default_rng(seed)
    combos = list(itertools.product(TRAIN_CROPS.items(), TRAIN_SOILS.items(), IRRIGATION, INIT_WATER))
    reps = max(1, math.ceil(n / len(combos)))
    (m1, d1), (m2, d2) = PLANTING_TRAIN
    lo, hi = datetime(TARGET_YEAR, m1, d1), datetime(TARGET_YEAR, m2, d2)
    configs = []
    for (crop, crop_file), (soil, soil_file), irr, iw in combos:
        for _ in range(reps):
            start = lo + timedelta(days=int(rng.integers(0, (hi - lo).days + 1)))
            configs.append({"cropFile": crop_file, "soilFile": soil_file, "cliFile": DEFAULTS["cli"],
                            "gwtFile": DEFAULTS["gwt"], "manFile": DEFAULTS["man"],
                            "irrigation": irr, "initWater": iw,
                            "gwDepth": sample_gw(rng),
                            "startDate": start.strftime("%Y/%m/%d"),
                            "_crop": crop, "_soil": soil})
    rng.shuffle(configs)
    return configs


def metrics(y_true, y_pred):
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    return {"r2": round(float(r2_score(y_true, y_pred)), 4),
            "rmse_t_ha": round(float(math.sqrt(mean_squared_error(y_true, y_pred))), 4),
            "mae_t_ha": round(float(mean_absolute_error(y_true, y_pred)), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1440, help="примерное число симуляций")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=None, help="куда писать .onnx (по умолчанию рядом с проектом)")
    ap.add_argument("--spec", default=None, help="JSON с файлами для обучения (по умолчанию - файлы из kucrop_core)")
    ap.add_argument("--out-dir", default=None, help="папка для .onnx, model_meta.json и training_data.csv")
    ap.add_argument("--model", choices=list(MODELS), default="et", help="et = ExtraTrees (по умолчанию), rf = RandomForest")
    ap.add_argument("--reuse-data", action="store_true",
                    help="не запускать симуляции заново, взять training_data.csv (если признаки совпадают)")
    args = ap.parse_args()

    from sklearn.model_selection import cross_val_score, train_test_split

    if args.spec:
        try:
            applied = apply_training_spec(json.loads(Path(args.spec).read_text(encoding="utf-8")))
        except ValueError as exc:
            raise SystemExit(f"ОШИБКА: {exc}")
        print("Обучение на выбранных файлах:", applied, flush=True)
    out_dir = Path(args.out_dir) if args.out_dir else BASE_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = Path(args.out) if args.out else out_dir / "aquacrop_model.onnx"
    meta_path = out_dir / "model_meta.json" if args.out_dir else META_PATH
    names = feature_names()
    data_csv = out_dir / "training_data.csv"
    sim_seconds = None
    if args.reuse_data:
        if not data_csv.exists():
            raise SystemExit("Нет training_data.csv - запустите без --reuse-data")
        df = pd.read_csv(data_csv)
        if [c for c in names if c not in df.columns]:
            raise SystemExit("training_data.csv собран с другими признаками - запустите без --reuse-data")
        print(f"Используются готовые данные: {len(df)} симуляций из training_data.csv")
    else:
        configs = sample_configs(args.n, args.seed)
        print(f"Обучение ИИ-суррогата: {len(configs)} симуляций AquaCrop, целевой год {TARGET_YEAR}")
        rows, failures, t0 = [], [], time.time()
        for i, cfg in enumerate(configs, 1):
            req = {k: v for k, v in cfg.items() if not k.startswith("_")}
            try:
                p = normalize_params(req)
                res = simulate(req, detail=False)
                rows.append({**dict(zip(names, make_features(p, names))), "yield": res["yield_tonne_ha"],
                             "crop": cfg["_crop"], "soil": cfg["_soil"], "irrigation": cfg["irrigation"],
                             "init_water": cfg["initWater"], "start": cfg["startDate"]})
            except Exception as exc:
                failures.append((req, f"{type(exc).__name__}: {exc}"))
            if i % 20 == 0 or i == len(configs):
                el = time.time() - t0
                print(f"  {i}/{len(configs)}  ok={len(rows)} ошибок={len(failures)}  {el:.0f} с, "
                      f"осталось ~{el / i * (len(configs) - i):.0f} с", flush=True)
        sim_seconds = (time.time() - t0) / max(1, len(configs))
        if failures:
            print(f"\nНеудачных симуляций: {len(failures)}. Первые:")
            for cfg, msg in failures[:3]:
                print("  ", cfg, "->", msg)
        if len(failures) > 0.05 * len(configs) or len(rows) < min(50, 0.5 * len(configs)):
            raise SystemExit("Слишком много неудачных симуляций - обучение остановлено (метки нельзя придумывать).")
        df = pd.DataFrame(rows)
        df.to_csv(data_csv, index=False)

    X = df[names].to_numpy(dtype=np.float32)
    y = df["yield"].to_numpy(dtype=np.float32)
    if float(np.std(y)) < 1e-3:
        raise SystemExit("Все урожаи одинаковы - физическая модель не реагирует на входы. Запустите python selfcheck.py")

    print("\nСредний урожай по факторам (т/га):")
    for col in ("crop", "soil", "irrigation", "init_water"):
        print(f"   {col:11s}", df.groupby(col)["yield"].mean().round(2).to_dict())

    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=args.seed)
    model = make_model(args.model).fit(Xtr, ytr)
    m_test = metrics(yte, model.predict(Xte))
    te = pd.DataFrame(Xte, columns=names)
    per_crop = {c: metrics(yte[te[f"crop_{c}"].to_numpy() == 1], model.predict(Xte[te[f"crop_{c}"].to_numpy() == 1]))
                for c in TRAIN_CROPS if (te[f"crop_{c}"] == 1).sum() > 2}
    cv = cross_val_score(make_model(args.model, n_estimators=100), X, y, cv=5, scoring="r2")

    print(f"\nОтложенная выборка 20%: R2={m_test['r2']}  RMSE={m_test['rmse_t_ha']} т/га  MAE={m_test['mae_t_ha']} т/га")
    for c, m in per_crop.items():
        print(f"   {c:10s} R2={m['r2']}  RMSE={m['rmse_t_ha']} т/га  MAE={m['mae_t_ha']} т/га")
    print(f"Кросс-валидация (5): R2={cv.mean():.4f} +/- {cv.std():.4f}")

    final = make_model(args.model).fit(X, y)
    importances = sorted(zip(names, final.feature_importances_), key=lambda t: -t[1])
    print("Важность признаков:", ", ".join(f"{n}={v:.2f}" for n, v in importances[:8]))

    onnx_bytes, exporter = export(final, len(names))
    diff = verify(onnx_bytes, final, X)
    if diff > 1e-3:
        raise SystemExit(f"ONNX расходится со sklearn (макс. {diff:.5f}) - файл не записан")
    onnx_path.write_bytes(onnx_bytes)

    # скорость: один прогноз ONNX против одного расчёта физики
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    one = X[:1].astype(np.float32)
    sess.run(None, {"float_input": one})
    t = time.perf_counter()
    for _ in range(200):
        sess.run(None, {"float_input": one})
    onnx_ms = (time.perf_counter() - t) / 200 * 1000

    meta = {
        "input_name": "float_input",
        "feature_names": names,
        "target_year": TARGET_YEAR,
        "categories": {"crop": list(TRAIN_CROPS), "soil": list(TRAIN_SOILS)},
        "training_files": training_fingerprint(),
        "training_file_names": {**DEFAULTS, "crops": TRAIN_CROPS, "soils": TRAIN_SOILS},
        "ranges": {"gw_depth": list(GW_TRAIN_RANGE),
                   "planting_doy": [int(df["planting_doy"].min()), int(df["planting_doy"].max())]},
        "model": MODELS[args.model][0],
        "metrics": {
            "test_random_20pct": m_test, "per_crop_test": per_crop,
            "cv5_r2_mean": round(float(cv.mean()), 4), "cv5_r2_std": round(float(cv.std()), 4),
            "yield_mean_t_ha": round(float(np.mean(y)), 3), "yield_std_t_ha": round(float(np.std(y)), 3),
            "n_train": int(len(ytr)), "n_test": int(len(yte)),
            "r2_test": m_test["r2"], "rmse_test_t_ha": m_test["rmse_t_ha"], "mae_test_t_ha": m_test["mae_t_ha"],
        },
        "speed": {"physics_s_per_run": None if sim_seconds is None else round(sim_seconds, 3),
                  "onnx_ms_per_prediction": round(onnx_ms, 3)},
        "feature_importance": {n: round(float(v), 4) for n, v in importances},
        "n_samples": int(len(df)),
        "exporter": exporter,
        "onnx_vs_sklearn_max_diff": diff,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": f"Суррогат воспроизводит AquaCrop для {TARGET_YEAR} года и файлов из training_file_names. "
                "Для других файлов сайт ИИ не показывает.",
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    speed = meta["speed"]
    print(f"\nСкорость: физика {speed['physics_s_per_run']} с/расчёт, ИИ (ONNX) {speed['onnx_ms_per_prediction']} мс/прогноз")
    print(f"Готово: {onnx_path.name} ({onnx_path.stat().st_size / 1024:.0f} КБ, экспорт: {exporter}, "
          f"ONNX vs sklearn: {diff:.1e}), model_meta.json, training_data.csv")


if __name__ == "__main__":
    main()
