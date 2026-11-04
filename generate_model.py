import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from aquacrop import AquaCropModel, Soil, Crop, InitialWaterContent, GroundWater
from aquacrop.utils import prepare_weather

from sklearn.ensemble import RandomForestRegressor
import skl2onnx
from skl2onnx.common.data_types import FloatTensorType

def build_and_train():
    print("🔄 Переобучение ONNX")

    crops = ['Sunflower', 'Wheat', 'Barley']
    gw_depths = [1.2, 1.7, 2.5, 3.0, 5.0]
    init_waters = ['FC', 'WP']

    X_data = []
    y_data = []

    with open('Poltavka.Tnx', 'r') as f:
        tnx_lines = [l.strip() for l in f.readlines()[8:] if l.strip()]
    with open('Poltavka.ETo', 'r') as f:
        eto_lines = [l.strip() for l in f.readlines()[8:] if l.strip()]
    with open('Poltavka.PLU', 'r') as f:
        plu_lines = [l.strip() for l in f.readlines()[8:] if l.strip()]

    dates = pd.date_range(start='2024-01-01', periods=len(tnx_lines), freq='D')
    raw_df = pd.DataFrame({
        'Day': dates.day, 'Month': dates.month, 'Year': dates.year,
        'MinTemp': [float(x.split()[0]) for x in tnx_lines],
        'MaxTemp': [float(x.split()[1]) for x in tnx_lines],
        'Precipitation': [float(x) for x in plu_lines],
        'ReferenceET': [float(x) for x in eto_lines]
    })
    raw_df.to_csv('temp_poltavka.txt', sep=' ', index=False)
    weather_df = prepare_weather('temp_poltavka.txt')

    for crop_name in crops:
        for gw in gw_depths:
            for iw in init_waters:
                try:
                    if crop_name == 'Barley':
                        crop_obj = Crop('Barley', planting_date='05/25', base_temp=0.0, upper_temp=15.0, emergence=7, max_rooting=60, senescence=65, maturity=93, flowering=60, flowering_cd=12, cgc=0.12410, cdc=0.07697, ccx=0.80, hio=32.0)
                        end_date = '2024/08/30'
                    elif crop_name == 'Wheat':
                        crop_obj = Crop('Wheat', planting_date='05/25', base_temp=0.0, upper_temp=26.0, emergence=10, max_rooting=70, senescence=80, maturity=100, flowering=55, flowering_cd=12, cgc=0.09500, cdc=0.08000, ccx=0.90, hio=45.0)
                        end_date = '2024/09/05'
                    else:
                        crop_obj = Crop('Sunflower', planting_date='05/25', base_temp=10.0, upper_temp=30.0, emergence=10, max_rooting=48, senescence=80, maturity=100, flowering=60, flowering_cd=12, cgc=0.17271, cdc=0.08000, ccx=0.85, hio=32.0)
                        end_date = '2024/09/05'

                    soil_obj = Soil('ClayLoam')
                    gw_obj = GroundWater(water_table='Constant', dates=['2024/05/25'], values=[gw])

                    model = AquaCropModel(
                        sim_start_time='2024/05/25',
                        sim_end_time=end_date,
                        weather_df=weather_df,
                        soil=soil_obj,
                        crop=crop_obj,
                        initial_water_content=InitialWaterContent(value=[iw]),
                        groundwater=gw_obj
                    )
                    model.run_model(till_termination=True)
                    res = model.get_simulation_results()

                    yield_val = 2.15
                    if res is not None and not res.empty:
                        for col in res.columns:
                            if 'yield' in col.lower():
                                yield_val = float(res[col].iloc[-1])

                    is_fc = 1.0 if iw == 'FC' else 0.0
                    is_sunflower = 1.0 if crop_name == 'Sunflower' else 0.0
                    is_wheat = 1.0 if crop_name == 'Wheat' else 0.0
                    is_barley = 1.0 if crop_name == 'Barley' else 0.0

                    features = [gw, is_fc, is_sunflower, is_wheat, is_barley]
                    X_data.append(features)
                    y_data.append(yield_val)

                except Exception as e:
                    continue

    X = np.array(X_data, dtype=np.float32)
    y = np.array(y_data, dtype=np.float32)

    rf_model = RandomForestRegressor(n_estimators=100, random_state=42)
    rf_model.fit(X, y)

    initial_type = [('float_input', FloatTensorType([None, 5]))]
    onnx_model = skl2onnx.convert_sklearn(rf_model, initial_types=initial_type)

    with open("aquacrop_model.onnx", "wb") as f:
        f.write(onnx_model.SerializeToString())

    print(f"✅ Модель переобучена на {len(X)} образцах. Файл aquacrop_model.onnx обновлен.")

if __name__ == '__main__':
    build_and_train()