# Third-party components

Scriptorium bundles the following open-source software and models. Each keeps its own license.
No part of the Alt application (altalt.io / Clap) is included.

| Component | Version | License | Source |
|---|---|---|---|
| whisper.cpp and ggml (speech recognition engine, built from source) | v1.9.5 (`d1be6fde`) | MIT, © The ggml authors | https://github.com/ggml-org/whisper.cpp |
| Whisper large-v3-turbo, ggml q5_0 conversion (`ggml-large-v3-turbo-q5_0.bin`, SHA-256 `394221709cd5…ffa7e2`) | — | MIT (OpenAI Whisper weights; ggml conversion by ggerganov) | https://huggingface.co/ggerganov/whisper.cpp |
| sherpa-onnx Node.js addon (`sherpa-onnx-node`, `sherpa-onnx-win-x64`) | 2.0.1 | Apache-2.0, © Xiaomi Corporation and k2-fsa contributors | https://github.com/k2-fsa/sherpa-onnx |
| ONNX Runtime (`onnxruntime.dll`, inside sherpa-onnx-win-x64) | as shipped with sherpa-onnx 2.0.1 | MIT, © Microsoft Corporation | https://github.com/microsoft/onnxruntime |
| Silero VAD (`silero_vad.onnx`) | as published by k2-fsa (`asr-models` release) | MIT, © Silero Team | https://github.com/snakers4/silero-vad |
| pyannote segmentation-3.0, ONNX export (`pyannote-segmentation-3.0.onnx`) | 3.0 | MIT, © 2022 CNRS | https://huggingface.co/pyannote/segmentation-3.0 |
| 3D-Speaker ERes2Net base speaker embedding (`3dspeaker_eres2net_base_16k.onnx`) | `speech_eres2net_base_sv_zh-cn_3dspeaker_16k` | Apache-2.0, © Alibaba / 3D-Speaker authors | https://github.com/modelscope/3D-Speaker |
| Node.js runtime (`runtime/node.exe`) | the version used to package | MIT, © Node.js contributors (bundled dependencies under their own licenses) | https://github.com/nodejs/node/blob/main/LICENSE |

Full texts: `whisper.cpp-ggml-MIT.txt`, `pyannote-segmentation-3.0-MIT.txt`, `Apache-2.0.txt` in this
folder. The MIT license text of whisper.cpp applies verbatim, with the respective copyright holder,
to the other MIT components listed above.

The Microsoft Visual C++ 2015-2022 runtime DLLs in `native\` and next to the sherpa-onnx module
are redistributed app-locally under the Microsoft Visual Studio license terms for redistributable code.

Windows components used at run time (not bundled): Media Foundation (file decoding) and WASAPI
(audio capture).
