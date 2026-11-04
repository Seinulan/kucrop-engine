const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const ort = require('onnxruntime-node');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let aiSession = null;

// Загрузка ONNX модели при старте
async function loadAIModel() {
    try {
        const modelPath = path.join(__dirname, 'aquacrop_model.onnx');
        aiSession = await ort.InferenceSession.create(modelPath);
        console.log('🤖 AI Model (ONNX) успешно загружена!');
    } catch (e) {
        console.warn('⚠️ AI Model не загружена:', e.message);
    }
}
loadAIModel();

app.post('/api/predict', (req, res) => {
    const params = req.body;
    const pythonProcess = spawn('python', ['run_aquacrop.py', JSON.stringify(params)]);

    let resultData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => { resultData += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { errorData += data.toString(); });

    pythonProcess.on('close', async (code) => {
        try {
            // Вырезаем строку строго между метками
            const startTag = '---JSON_OUTPUT_START---';
            const endTag = '---JSON_OUTPUT_END---';
            
            const startIndex = resultData.indexOf(startTag);
            const endIndex = resultData.indexOf(endTag);

            if (startIndex === -1 || endIndex === -1) {
                console.error('Python Output Raw:', resultData);
                console.error('Python Error Raw:', errorData);
                return res.status(500).json({ success: false, error: 'Не удалось извлечь результат симуляции' });
            }

            const jsonString = resultData.substring(startIndex + startTag.length, endIndex).trim();
            const parsedResult = JSON.parse(jsonString);

            // Инференс ИИ-модели ONNX (5 признаков)
            let aiYield = null;
            if (aiSession) {
                try {
                    const gw = parseFloat(params.gwDepth) || 1.7;
                    const isFC = params.initWater === 'FC' ? 1.0 : 0.0;
                    const isSunflower = params.crop === 'Sunflower' ? 1.0 : 0.0;
                    const isWheat = params.crop === 'Wheat' ? 1.0 : 0.0;
                    const isBarley = params.crop === 'Barley' ? 1.0 : 0.0;

                    const inputTensor = new ort.Tensor('float32', new Float32Array([gw, isFC, isSunflower, isWheat, isBarley]), [1, 5]);
                    const feeds = {};
                    feeds[aiSession.inputNames[0]] = inputTensor;

                    const outputMap = await aiSession.run(feeds);
                    const outputTensor = outputMap[aiSession.outputNames[0]];
                    
                    if (outputTensor && outputTensor.data) {
                        aiYield = Number(outputTensor.data[0]).toFixed(2);
                    }
                } catch (err) {
                    console.log('AI Inference warning:', err.message);
                }
            }

            parsedResult.ai_yield = aiYield || parsedResult.yield_tonne_ha;
            res.json(parsedResult);

        } catch (e) {
            console.error('Parsing error:', e);
            res.status(500).json({ success: false, error: 'Ошибка обработчика KUCrop Engine: ' + e.message });
        }
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 KUCrop Engine запущен на http://localhost:${PORT}`);
});