"""
onnx_export.py - экспорт RandomForestRegressor (scikit-learn) в ONNX.

Если установлен skl2onnx - используется он (стандартный путь).
Если нет - встроенный минимальный экспортёр: один узел TreeEnsembleRegressor (ai.onnx.ml),
протобуф собирается вручную (без пакета onnx). Результат в любом случае проверяется
через onnxruntime: предсказания ONNX обязаны совпасть с sklearn (см. verify()).
"""
from __future__ import annotations

import struct

import numpy as np


# ---- минимальный кодировщик protobuf ------------------------------------------
def _varint(n: int) -> bytes:
    n &= (1 << 64) - 1                       # отрицательные int64 -> дополнительный код
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _key(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _len(field: int, payload: bytes) -> bytes:
    return _key(field, 2) + _varint(len(payload)) + payload


def _str(field: int, s: str) -> bytes:
    return _len(field, s.encode("utf-8"))


def _int(field: int, v: int) -> bytes:
    return _key(field, 0) + _varint(int(v))


# AttributeProto: name=1, f=2, i=3, s=4, floats=7, ints=8, strings=9, type=20
_A_FLOAT, _A_INT, _A_STRING, _A_FLOATS, _A_INTS, _A_STRINGS = 1, 2, 3, 6, 7, 8


def _attr_int(name, v):
    return _str(1, name) + _int(3, v) + _int(20, _A_INT)


def _attr_str(name, v):
    return _str(1, name) + _len(4, v.encode()) + _int(20, _A_STRING)


def _attr_ints(name, vals):
    packed = b"".join(_varint(int(v)) for v in vals)
    return _str(1, name) + _len(8, packed) + _int(20, _A_INTS)


def _attr_floats(name, vals):
    packed = struct.pack(f"<{len(vals)}f", *[float(v) for v in vals])
    return _str(1, name) + _len(7, packed) + _int(20, _A_FLOATS)


def _attr_strings(name, vals):
    return _str(1, name) + b"".join(_len(9, v.encode()) for v in vals) + _int(20, _A_STRINGS)


def _value_info(name: str, dims: list) -> bytes:
    # ValueInfoProto{name=1, type=2{tensor_type=1{elem_type=1, shape=2{dim=1{dim_value=1|dim_param=2}}}}}
    shape = b"".join(_len(1, _str(2, d) if isinstance(d, str) else _int(1, d)) for d in dims)
    tensor = _int(1, 1) + _len(2, shape)                 # elem_type 1 = FLOAT
    return _str(1, name) + _len(2, _len(1, tensor))


def _floor_f32(t: float) -> float:
    """Наибольшее float32 <= t. Для float32-входа x: (x <= t) == (x <= floor32(t)) - ветвление точно как в sklearn.
    Простое округление до float32 может поднять порог выше t и отправить x в другую ветку."""
    t32 = np.float32(t)
    if float(t32) > float(t):
        t32 = np.nextafter(t32, np.float32(-np.inf))
    return float(t32)


def _rf_attributes(model) -> bytes:
    tids, nids, feats, vals, modes, tnode, fnode = [], [], [], [], [], [], []
    t_tids, t_nids, t_ids, t_w = [], [], [], []
    for t, est in enumerate(model.estimators_):
        tree = est.tree_
        for node in range(tree.node_count):
            left, right = tree.children_left[node], tree.children_right[node]
            tids.append(t)
            nids.append(node)
            if left == -1:                                   # лист
                feats.append(0); vals.append(0.0); modes.append("LEAF"); tnode.append(0); fnode.append(0)
                t_tids.append(t); t_nids.append(node); t_ids.append(0)
                t_w.append(float(tree.value[node].ravel()[0]))
            else:                                            # x <= порог -> влево (как в sklearn)
                feats.append(int(tree.feature[node])); vals.append(_floor_f32(tree.threshold[node]))
                modes.append("BRANCH_LEQ"); tnode.append(int(left)); fnode.append(int(right))
    return b"".join(_len(5, a) for a in [
        _attr_int("n_targets", 1),
        _attr_ints("nodes_treeids", tids), _attr_ints("nodes_nodeids", nids),
        _attr_ints("nodes_featureids", feats), _attr_floats("nodes_values", vals),
        _attr_strings("nodes_modes", modes),
        _attr_ints("nodes_truenodeids", tnode), _attr_ints("nodes_falsenodeids", fnode),
        _attr_ints("target_treeids", t_tids), _attr_ints("target_nodeids", t_nids),
        _attr_ints("target_ids", t_ids), _attr_floats("target_weights", t_w),
        _attr_str("aggregate_function", "AVERAGE"), _attr_str("post_transform", "NONE"),
    ])


def export_minimal(model, n_features: int, input_name: str = "float_input") -> bytes:
    node = (_str(1, input_name) + _str(2, "variable") + _str(3, "TreeEnsembleRegressor")
            + _str(4, "TreeEnsembleRegressor") + _str(7, "ai.onnx.ml") + _rf_attributes(model))
    graph = (_len(1, node) + _str(2, "kucrop_rf")
             + _len(11, _value_info(input_name, ["N", n_features]))
             + _len(12, _value_info("variable", ["N", 1])))
    opsets = _len(8, _str(1, "") + _int(2, 17)) + _len(8, _str(1, "ai.onnx.ml") + _int(2, 3))
    return _int(1, 8) + _str(2, "kucrop") + _str(3, "1.0") + _len(7, graph) + opsets


def export(model, n_features: int, input_name: str = "float_input"):
    """-> (bytes, имя экспортёра)."""
    try:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
        onx = convert_sklearn(model, initial_types=[(input_name, FloatTensorType([None, n_features]))])
        return onx.SerializeToString(), "skl2onnx"
    except ImportError:
        return export_minimal(model, n_features, input_name), "встроенный (onnx_export.py)"


def verify(onnx_bytes: bytes, model, X: np.ndarray) -> float:
    """Макс. |ONNX - sklearn| на X. Нужен onnxruntime."""
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    got = sess.run(None, {sess.get_inputs()[0].name: X.astype(np.float32)})[0].ravel()
    return float(np.max(np.abs(got - model.predict(X.astype(np.float32)))))
