const ort = require('onnxruntime-node');

class CropPredictor {
    constructor(modelPath) {
        this.modelPath = modelPath;
        this.session = null;
    }

    async init() {
        if (!this.session) {
            this.session = await ort.InferenceSession.create(this.modelPath);
            console.log('ONNX модель успешно загружена!');
        }
    }

    async predict(cropCode, soilCode, waterCode, gwDepth) {
        await this.init();

        const inputData = Float32Array.from([
            Number(cropCode),
            Number(soilCode),
            Number(waterCode),
            Number(gwDepth)
        ]);
        const tensor = new ort.Tensor('float32', inputData, [1, 4]);

        const feeds = { float_input: tensor };
        const results = await this.session.run(feeds);

        const outputTensor = results.variable || Object.values(results)[0];
        return outputTensor.data[0];
    }
}

module.exports = CropPredictor;