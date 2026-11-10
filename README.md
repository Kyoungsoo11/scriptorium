# Scriptorium

**인터넷 없이 내 PC에서만 돌아가는 강의·회의 전사 도구 (Windows, 명령줄).**
Offline lecture/meeting transcription for Windows — a non-interactive CLI, no server, no account.

- 오디오·비디오 파일 전사, 마이크 + 컴퓨터 소리(시스템 오디오) 실시간 녹음 전사
- 화자 분리 (누가 말했는지 `SPEAKER_00`, `SPEAKER_01` …), 화자 이름 붙이기
- 자막(SRT/VTT), 텍스트, Markdown, JSON 내보내기, 노트·폴더·검색
- **모든 명령이 옵션만으로 끝까지 실행**된다. 묻는 화면이 없어서 스크립트·자동화·AI 에이전트가 호출하기 좋다
- 결과는 stdout에 JSON, 진행 상황은 stderr. 종료 코드 0/1/2
- 실행 중 네트워크 통신 없음. 녹음과 노트는 내 PC에만 저장

> Scriptorium은 강의 노트 앱 [Alt](https://altalt.io)의 전사 기능이 어떻게 동작하는지 분석해, 공개된 오픈소스 부품으로 처음부터 다시 만든 도구입니다. Alt의 코드·바이너리·모델은 전혀 포함하지 않으며, Alt 개발사와 관계가 없습니다.

---

## 목차

1. [빠른 시작](#빠른-시작)
2. [요구 사항](#요구-사항)
3. [명령어](#명령어)
4. [옵션](#옵션)
5. [출력](#출력)
6. [실시간 녹음 다루기](#실시간-녹음-다루기)
7. [다른 프로그램에서 호출하기](#다른-프로그램에서-호출하기)
8. [데이터 위치와 설정](#데이터-위치와-설정)
9. [성능과 품질](#성능과-품질)
10. [문제 해결](#문제-해결)
11. [동작 원리](#동작-원리)
12. [소스에서 빌드](#소스에서-빌드)
13. [라이선스](#라이선스)
14. [알려진 한계](#알려진-한계)

---

## 빠른 시작

1. [Releases](../../releases)에서 `scriptorium-<버전>-win-x64.zip`(약 630 MB)을 받는다.
2. 아무 폴더에 압축을 푼다. 예: `C:\Tools\scriptorium`
3. 그 폴더에서 명령 프롬프트나 PowerShell을 열고 확인한다:

```bash
scriptorium.cmd doctor
```

`"ok":true`가 나오면 준비 끝. 첫 전사:

```bash
scriptorium.cmd transcribe "D:\강의\3주차.mp4" --lang ko --out 3주차.srt
```

어디서나 `scriptorium`으로 부르고 싶으면 압축 푼 폴더를 PATH에 추가한다 (설정 → 시스템 → 정보 → 고급 시스템 설정 → 환경 변수 → Path). 아래 예시는 PATH에 추가했다고 가정하고 `scriptorium`으로 적는다.

> 처음 실행할 때 Windows SmartScreen이 "알 수 없는 게시자" 경고를 띄울 수 있다. 직접 빌드한 `scriptorium-core.exe`에 코드 서명이 없기 때문이다. "추가 정보 → 실행"으로 넘어가면 된다.

## 요구 사항

- Windows 10/11 64비트 (x64 CPU. 속도를 위해 AVX2 이상 권장, CPU에 맞는 코드가 자동 선택된다)
- 메모리: 4 GB 이상 권장 (Whisper 모델 약 1 GB + 녹음 1시간당 약 230 MB)
- 디스크: 압축 해제 후 약 760 MB
- 따로 설치할 것 없음: Node.js 런타임, Visual C++ 런타임, 모델이 모두 들어 있다

---

## 명령어

```
scriptorium <명령> [옵션]
```

| 명령 | 하는 일 |
|---|---|
| `transcribe <파일> [<파일> …]` | 오디오·비디오 파일 전사 |
| `record` | 마이크 + 시스템 오디오 녹음하며 실시간 전사 |
| `stop` | 실행 중인 녹음을 멈추고 결과가 나올 때까지 기다림 |
| `status` | 실행 중인 녹음 목록 |
| `notes …` | 노트 목록·보기·내보내기·이름 변경·이동·삭제 |
| `folders …` | 폴더 목록·만들기·삭제 |
| `speakers rename …` | 화자 이름 붙이기 |
| `devices` | 오디오 장치 목록 |
| `doctor` | 엔진·모델·오디오 장치 점검 |
| `help`, `version` | 도움말, 버전 |

### transcribe — 파일 전사

```bash
scriptorium transcribe <파일> [<파일> …] [옵션]
```

- 지원 형식: Windows가 열 수 있는 대부분의 오디오·비디오 (mp3, m4a, aac, wav, flac, wma, mp4, mov 등). 비디오는 소리만 쓴다.
- 기본으로 노트를 저장하고, 결과 JSON을 출력한다.

```bash
# 한국어 강의, "운영체제" 폴더에 저장 (폴더가 없으면 만든다)
scriptorium transcribe 3주차.m4a --lang ko --folder 운영체제

# 노트 저장 없이 자막 파일만
scriptorium transcribe 3주차.mp4 --lang ko --no-save --out 3주차.srt

# 2명이 나누는 회의, 화자 수를 알려 주면 더 정확
scriptorium transcribe 회의.m4a --speakers 2 --out 회의.md

# 여러 파일을 차례로 (각각 노트가 된다)
scriptorium transcribe 1주차.m4a 2주차.m4a 3주차.m4a --lang ko --folder 자료구조

# 텍스트만 화면에 출력
scriptorium transcribe 메모.m4a --format txt --no-save

# 전문 용어가 많을 때: 단어 힌트 주기
scriptorium transcribe 강의.m4a --lang ko --prompt "페이지 교체, LRU, 스래싱, 세마포어"
```

### record — 실시간 녹음 전사

```bash
scriptorium record [옵션]
```

마이크와 컴퓨터에서 나는 소리(온라인 강의, 화상 회의 상대방 목소리 등)를 함께 녹음하면서 전사한다. 멈추는 방법은 [실시간 녹음 다루기](#실시간-녹음-다루기) 참고.

```bash
# 50분 동안 녹음 (마이크 + 시스템 오디오)
scriptorium record --duration 50m --lang ko --title "자료구조 7주차" --folder 자료구조

# 온라인 강의: 컴퓨터 소리만 (마이크 끔)
scriptorium record --mic none --lang ko --duration 1h30m

# 대면 강의: 마이크만
scriptorium record --no-system --lang ko --duration 75m

# 특정 마이크 쓰기 (id는 devices 명령으로 확인)
scriptorium record --mic "{0.0.1.00000000}.{xxxxxxxx-xxxx-...}" --duration 30m

# 백그라운드로 시작하고 바로 돌아오기 → 나중에 stop
scriptorium record --detach --lang ko --title "주간 회의"
scriptorium stop

# 진행 중 문장을 한 줄씩 받기
scriptorium record --duration 10m --stream
```

녹음은 16 kHz WAV로 데이터 폴더에 남는다 (`--audio-out`으로 위치 지정, `--no-audio`로 저장 안 함).

### stop / status

```bash
scriptorium status                 # 실행 중인 녹음 (noteId, pid, 경과 시간)
scriptorium stop                   # 하나만 실행 중이면 그것을 멈춤
scriptorium stop --id <noteId>     # 여러 개일 때 하나 지정
scriptorium stop --all             # 모두
scriptorium stop --no-wait         # 멈추라고만 하고 바로 돌아옴
scriptorium stop --timeout 20m     # 마무리를 기다리는 최대 시간 (기본 10분)
```

`stop`은 녹음을 끝낸 뒤 남은 전사와 화자 분리가 끝날 때까지 기다렸다가 노트 요약을 출력한다.

### notes / folders / speakers

```bash
scriptorium notes list                              # 최근 노트 50개
scriptorium notes list --search 스케줄링 --limit 10  # 제목·전사 내용 검색
scriptorium notes list --folder 운영체제             # 폴더 안 노트 (--folder null: 폴더 없는 노트)
scriptorium notes show <noteId>                     # 노트 + 문장 전체 (JSON)
scriptorium notes show <noteId> --format md         # Markdown으로 보기
scriptorium notes export <noteId> --out 강의.srt    # 형식은 확장자로 (srt, vtt, txt, md, json)
scriptorium notes export <noteId> --format vtt --out 강의.vtt
scriptorium notes rename <noteId> "운영체제 7주차"
scriptorium notes move <noteId> 운영체제            # 폴더 이름 또는 id, 폴더에서 빼려면 null
scriptorium notes delete <noteId>                   # 노트와 Scriptorium이 만든 녹음 파일 삭제
scriptorium notes delete <noteId> --keep-audio      # 녹음 파일은 남김

scriptorium folders list
scriptorium folders create 운영체제 [--parent <폴더id>]
scriptorium folders delete 운영체제                 # 노트는 지워지지 않고 폴더 밖으로 나옴

scriptorium speakers rename <noteId> SPEAKER_00 "김교수"   # 이후 내보내기에 이름으로 표시
```

### devices / doctor

```bash
scriptorium devices    # 마이크·스피커 목록 (id, 이름, 기본 장치 여부)
scriptorium doctor     # 엔진, 모델 4개, 기본 마이크·스피커, 데이터 폴더 점검
```

---

## 옵션

### 전사 옵션 (transcribe, record 공통)

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `--lang <코드>` | 언어 (`ko`, `en`, `ja` …, `auto`) | `auto` |
| `--speakers <n>` | 화자 수를 알면 지정 | 자동 추정 |
| `--no-diarize` | 화자 분리 안 함 (더 빠름) | 함 |
| `--prompt <텍스트>` | 용어·이름 힌트 | 없음 |
| `--vad-threshold <0~1>` | 말소리 감지 민감도. 작은 목소리를 놓치면 낮추고(0.1), 잡음을 말로 착각하면 높인다(0.3) | `0.15` |
| `--beam <n>` | 탐색 폭. 1이면 빠르지만 정확도가 조금 떨어짐 | `5` |
| `--threads <n>` | CPU 스레드 수 | 코어 수, 최대 16 |
| `--backend <auto\|cpu\|gpu>` | GPU 빌드에서 GPU 사용 여부 | `auto` |
| `--gpu <n>` | 사용할 GPU 번호 | 0 |
| `--title <제목>` | 노트 제목 | 파일 이름 / 녹음 시각 |
| `--folder <이름\|id>` | 노트를 넣을 폴더 (없으면 만듦) | 없음 |
| `--no-save` | 노트로 저장하지 않음 | 저장 |
| `--format <json\|srt\|vtt\|txt\|md>` | 결과 JSON 대신 이 형식을 stdout에 | 결과 JSON |
| `--out <파일>` | 전사를 파일로 저장 (형식은 `--format` 또는 확장자) | 없음 |
| `--stream` | 진행 중 이벤트를 JSON Lines로 출력 | 끔 |

`--lang`을 정해 주면 더 정확하고 빠르다. 한 묶음 안에서 다른 언어 문장이 빠지면 자동으로 언어 감지로 다시 전사해 메운다.

### 녹음 옵션 (record)

| 옵션 | 설명 |
|---|---|
| `--duration <시간>` | 이만큼 녹음하고 멈춤. `90s`, `45m`, `1h30m`, `1:30:00`, 숫자만 쓰면 초 |
| `--mic <id\|default\|none>` | 마이크. `none`이면 시스템 오디오만 |
| `--no-system` | 시스템 오디오 끔 (마이크만) |
| `--stop-file <경로>` | 이 파일이 생기면 멈춤 |
| `--audio-out <파일.wav>` | 녹음 파일 위치 |
| `--no-audio` | 녹음 파일을 남기지 않음 |
| `--detach` | 백그라운드로 시작하고 noteId를 출력한 뒤 바로 종료 |
| `--log-file <파일>` | `--detach` 때 로그 위치 |

### 전역 옵션

| 옵션 | 설명 |
|---|---|
| `--data-dir <폴더>` | 노트 DB와 녹음 위치 (기본 `%APPDATA%\scriptorium`) |
| `--models-dir <폴더>` | 모델 폴더 (기본: 프로그램 폴더의 `models`) |
| `--whisper-model <파일>` | 다른 ggml Whisper 모델 (예: 더 작고 빠른 모델) |
| `--quiet` | stderr 진행 로그 끄기 |

---

## 출력

### 결과 JSON (transcribe, record)

```json
{
  "noteId": "66fa1bc8-f65a-46e7-8580-ab930c1d5398",
  "title": "3주차",
  "backend": "cpu",
  "language": "ko",
  "audioSeconds": 4229.5,
  "retriedPieces": 0,
  "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "segments": [
    { "start": 0, "end": 5574, "text": "안녕하세요. 오늘은 …", "speaker": "SPEAKER_00" }
  ],
  "sourcePath": "D:\\강의\\3주차.m4a",
  "elapsedSeconds": 1890.2,
  "saved": "C:\\…\\3주차.srt"
}
```

- `start`, `end`: 녹음/파일 시작부터의 밀리초
- `noteId`: `--no-save`면 `null`
- `retriedPieces`: 놓친 말소리를 다시 전사한 횟수
- record는 `audioPath`, `startedAt`, `stopReason`(`duration`, `stop-file`, `signal`, `error`)이 더 붙는다
- `saved`: `--out`을 줬을 때 저장한 파일

### 형식

| 형식 | 내용 |
|---|---|
| `srt` | 자막. `[화자] 문장` |
| `vtt` | 웹 자막. `<v 화자>문장` |
| `txt` | 문장만 한 줄씩 |
| `md` | 제목 + 화자별 문단 + 시각 |
| `json` | 문장 배열 |

화자 이름을 붙였으면(`speakers rename`) `notes export`/`notes show --format`에서 이름으로 나온다.

### `--stream` 이벤트

한 줄에 JSON 하나:

```
{"event":"started","noteId":"…","backend":"cpu"}
{"event":"segment","index":0,"start":4500,"end":9100,"text":"이번 주제는 …"}
{"event":"segment","index":1,…}
{"event":"update","index":0,"start":4500,"end":9100,"text":"…","speaker":"SPEAKER_00"}
{"event":"remove","index":7}
{"event":"done","noteId":"…","segmentCount":12,…}
```

- `segment`: 새 문장. `index`는 0부터 시간 순서
- `update`: 이미 보낸 문장이 바뀜. 화자 라벨은 끝날 때 한꺼번에 `update`로 붙는다
- `remove`: 문장이 사라짐 (드묾)
- `done`: 결과 JSON에서 `segments`를 뺀 것 + `segmentCount`

### 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 성공 |
| 1 | 실행 중 실패 (파일을 못 읽음, 장치 오류 등). stderr에 `scriptorium: <이유>` |
| 2 | 잘못된 사용법 (모르는 옵션, 빠진 인자 등) |

---

## 실시간 녹음 다루기

멈추는 방법 네 가지 (아무거나):

1. `--duration 50m`: 시간이 되면 멈춤
2. `scriptorium stop`: 다른 창이나 스크립트에서
3. `--stop-file C:\tmp\stop`: 그 파일이 생기면 멈춤 (`type nul > C:\tmp\stop`)
4. 녹음 중인 콘솔에서 Ctrl+C

녹음이 멈추면 남은 문장 전사 → 화자 분리 → 노트 저장 순으로 마무리한다 (1시간 녹음이면 화자 분리에 몇 분 걸린다).

- 문장은 말이 잠깐 쉴 때마다 묶음으로 나온다 (말한 뒤 약 10~30초). 단어 단위 자막은 아니다.
- 녹음 중에도 몇 초마다 부분 전사가 저장되므로, 프로그램이 죽어도 그때까지의 전사와 WAV 파일은 남는다.
- 같은 데이터 폴더에서 여러 녹음을 동시에 돌릴 수 있다 (`stop --id`로 구분).

---

## 다른 프로그램에서 호출하기

모든 명령이 대화 없이 끝나고, 결과를 stdout JSON 한 덩어리로 주므로 그대로 파싱하면 된다.

**PowerShell**

```powershell
$r = scriptorium transcribe .\lecture.m4a --lang ko --quiet | ConvertFrom-Json
$r.segments | ForEach-Object { "{0,8:N1}s  {1}" -f ($_.start / 1000), $_.text }
```

**Python**

```python
import json, subprocess
out = subprocess.run(
    ["scriptorium", "transcribe", "lecture.m4a", "--lang", "ko", "--quiet"],
    capture_output=True, text=True, encoding="utf-8", check=True,
)
result = json.loads(out.stdout)
print(result["noteId"], len(result["segments"]))
```

**실시간 이벤트 받기 (Python)**

```python
p = subprocess.Popen(["scriptorium", "record", "--duration", "10m", "--stream", "--quiet"],
                     stdout=subprocess.PIPE, text=True, encoding="utf-8")
for line in p.stdout:
    e = json.loads(line)
    if e["event"] == "segment":
        print(e["start"] // 1000, e["text"])
```

**백그라운드 녹음 (에이전트 등)**

```bash
scriptorium record --detach --lang ko --title "회의"   # noteId를 JSON으로 돌려줌
scriptorium status
scriptorium stop                                       # 끝나면 노트 요약 JSON
scriptorium notes export <noteId> --out 회의.md
```

---

## 데이터 위치와 설정

| 무엇 | 위치 |
|---|---|
| 노트 DB (SQLite) | `%APPDATA%\scriptorium\scriptorium.db` |
| 녹음 WAV | `%APPDATA%\scriptorium\recordings\<noteId>.wav` |
| 실행 중 녹음 상태·로그 | `%APPDATA%\scriptorium\run\` |
| 모델 | 프로그램 폴더 `models\` |

환경 변수 (옵션과 같은 역할, 옵션이 우선):

| 변수 | 역할 |
|---|---|
| `SCRIPTORIUM_HOME` | 데이터 폴더 |
| `SCRIPTORIUM_MODELS` | 모델 폴더 |
| `SCRIPTORIUM_NATIVE` | `scriptorium-core.exe`가 있는 폴더 |
| `SCRIPTORIUM_VAD_THRESHOLD` | 말소리 감지 민감도 기본값 |

노트 DB는 일반 SQLite 파일이다. 표: `lecture_notes`(노트), `folders`, `note_components`(전사·녹음 파일). 전사는 `component_type = 'transcript'`인 행의 `content_text`에 JSON(`[{speaker, segments:[{start,end,text,speaker}]}]`, ms)으로, 화자 이름은 `metadata.speakerNames`에 들어 있다.

---

## 성능과 품질

측정 환경: AMD Ryzen 7 8845HS (8코어 16스레드), CPU 빌드, `--lang ko`, 기본 옵션.

| 측정 | 결과 |
|---|---|
| 70분 30초 강의 녹음(m4a) 전사 + 화자 분리 | 28분 30초 (녹음 길이의 0.40배) |
| 그중 화자 분리 | 6분 26초 |
| 실시간 녹음에서 문장이 나오기까지 | 말한 뒤 약 10~30초 |

**Alt와 비교** (같은 70분 강의를 Alt로 전사한 텍스트와 대조, 공백·문장부호 제외):

- 글자 기준 89% 일치 (18,697자 중 편집 거리 2,018). 5분 단위로 나눠도 구간마다 비슷하고, 통째로 빠진 구간은 없었다.
- 둘 다 정답은 아니다. 어긋난 곳을 몇 군데 읽어 보면 대부분 같은 말을 다르게 적은 것이고(영어 용어를 한글로 적느냐 영문으로 적느냐 등), 어느 쪽이 맞는지는 곳마다 달랐다.
- 화자 분리는 비교하지 못했다 (Alt 텍스트에 화자 표시가 없음). 이 강의에서 7명으로 나눴고 두 화자가 약 92%를 차지했는데, 강의자 한 명의 목소리가 둘로 갈렸을 가능성이 높다. 화자 수를 알면 `--speakers`로 지정하는 것이 좋다.

그 밖에 확인한 것: 유튜브 영상을 틀어 놓고 시스템 오디오만 90초 녹음 → 12문장 정상 전사, 잡음만 있는 30초 → 문장 0개, 한·영을 번갈아 말하는 대화 → 4문장 모두 전사.

---

## 문제 해결

| 증상 | 해결 |
|---|---|
| `doctor`가 모델이 없다고 함 | 압축을 다 풀었는지 확인 (`models\` 폴더 4개 파일). zip 안에서 바로 실행하면 안 된다 |
| 작은 목소리가 빠진다 | `--vad-threshold 0.1` |
| 잡음·음악이 이상한 문장으로 나온다 | `--vad-threshold 0.3`, 또는 `--lang`을 지정 |
| 전문 용어가 틀린다 | `--prompt "용어1, 용어2, …"` |
| 영어 문장이 섞인 강의에서 문장이 빠진다 | 자동으로 다시 전사하지만, 많이 섞이면 `--lang auto` |
| 화자 수가 틀린다 | `--speakers 2`처럼 지정, 한 명이면 `--no-diarize` |
| 시스템 오디오가 녹음 안 된다 | 소리가 기본 출력 장치(`devices`의 `"default":true` 스피커)로 나는지 확인. 블루투스 장치를 바꾸면 다시 시작 |
| 마이크가 녹음 안 된다 | Windows 설정 → 개인 정보 → 마이크에서 데스크톱 앱 접근 허용 |
| 느리다 | `--beam 1`, `--no-diarize`, 또는 더 작은 Whisper 모델(`--whisper-model`) |
| 실행하자마자 DLL 오류 | 압축을 푼 폴더 구조를 바꾸지 말 것 (`native\`, `app\`, `runtime\`, `models\`가 같은 곳에 있어야 함) |

---

## 동작 원리

```
scriptorium.cmd ─ runtime\node.exe ─ app\src\cli.js
                                       ├─ native.js ── scriptorium-core.exe (C++)
                                       │                 ├ decode : Media Foundation → 16 kHz mono
                                       │                 ├ capture: WASAPI 마이크 + 시스템 오디오(loopback) 믹스
                                       │                 └ whisper: whisper.cpp 상주 프로세스 (stdin/stdout 파이프)
                                       ├─ speech.js ── sherpa-onnx (ONNX Runtime)
                                       │                 ├ Silero VAD: 말소리 구간 검출
                                       │                 └ pyannote segmentation + 3D-Speaker 임베딩: 화자 분리
                                       └─ store.js ─── node:sqlite (노트 DB)
```

1. 오디오를 16 kHz mono로 바꾼다 (파일은 Media Foundation, 녹음은 WASAPI. 마이크와 시스템 오디오는 더해서 [-1, 1]로 자른다)
2. Silero VAD로 말소리 구간을 찾고 앞뒤 0.3초를 붙인다
3. 무음을 빼고 말소리 구간들을 최대 28초 묶음으로 포장한다 (구간 사이 1초 무음). Whisper는 묶음 길이와 상관없이 한 번에 약 6초(CPU)가 걸리므로 꽉 채우는 게 빠르다
4. whisper.cpp(large-v3-turbo, q5_0)로 전사하고, 묶음 안의 시간을 원래 녹음 시간으로 되돌린다
5. 말소리인데 문장이 없는 곳, 길이에 비해 글자가 너무 적은 문장을 찾아 언어 자동 감지로 한 번 더 전사한다 (다른 언어 문장이 빠지는 Whisper 특성 보완). 중복은 버린다
6. 끝나면 전체 오디오로 화자 분리를 하고, 각 문장에 가장 많이 겹치는 화자를 붙인다
7. 노트로 저장한다

실시간 녹음은 말이 쉬었을 때 8초 이상 모였거나, 25초가 찼거나, 15초를 기다렸으면 묶음을 보낸다. 실시간보다 빠르게 처리되므로 밀리지 않는다.

---

## 소스에서 빌드

필요: Windows 10/11, Visual Studio 2022 Build Tools ("C++를 사용한 데스크톱 개발"), Node.js 22.13+, git.

```bash
git clone https://github.com/Kyoungsoo11/scriptorium
```
```bash
cd scriptorium
```
```bash
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
```
```bash
npm install
```
```bash
scripts\build-whisper.cmd cpu
```
```bash
scripts\build-core.cmd cpu
```

모델 4개를 `models\`에 둔다:

| 파일 | 받는 곳 |
|---|---|
| `ggml-large-v3-turbo-q5_0.bin` | https://huggingface.co/ggerganov/whisper.cpp (`ggml-large-v3-turbo-q5_0.bin`) |
| `silero_vad.onnx` | https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models |
| `pyannote-segmentation-3.0.onnx` | 같은 곳 `speaker-segmentation-models` 의 `sherpa-onnx-pyannote-segmentation-3-0.tar.bz2` 안 `model.onnx` |
| `3dspeaker_eres2net_base_16k.onnx` | 같은 곳 `speaker-recongition-models` 의 `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` |

```bash
npm test
```
```bash
node bin/scriptorium.js doctor
```

배포용 폴더와 zip 만들기:

```bash
node scripts/package.js
```

→ `dist\scriptorium-<버전>-win-x64\`, `dist\scriptorium-<버전>-win-x64.zip`

GPU(Vulkan) 빌드는 [Vulkan SDK](https://vulkan.lunarg.com/)를 설치한 뒤 `scripts\build-whisper.cmd vulkan` → `scripts\build-core.cmd vulkan` → `node scripts/package.js --build vulkan` (아직 검증하지 않았다).

---

## 라이선스

배포판에 들어 있는 부품과 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있다 (whisper.cpp·ggml MIT, Whisper 모델 MIT, sherpa-onnx Apache-2.0, ONNX Runtime MIT, Silero VAD MIT, pyannote segmentation MIT, 3D-Speaker Apache-2.0, Node.js MIT, Visual C++ 런타임). 배포 zip의 `LICENSES\` 폴더에 원문이 있다.

---

## 알려진 한계

- **CPU 전용 배포판**: GPU를 쓰지 않는다. 1시간 강의에 약 25분 걸린다.
- **다른 언어 문장**: Whisper는 한 묶음을 한 언어로 전사해서 다른 언어 문장을 빼먹을 수 있다. 다시 전사해 메우지만 1.5초보다 짧은 문장은 놓칠 수 있다.
- **화자 분리**: 짧은 녹음, 비슷한 목소리, 한 사람 강의에서도 화자를 더 많이 나누는 일이 있다. `--speakers`로 고정하거나 `--no-diarize`.
- **실시간 녹음**: 묶음이 짧아 같은 소리를 파일로 전사할 때보다 약간 부정확할 수 있다. 화자 라벨은 녹음이 끝난 뒤에 붙는다.
- **MP3**: 앞부분 인코더 지연(약 50 ms)만큼 시간이 늦게 찍힌다.
- 메모리: 화자 분리를 위해 전체 오디오를 메모리에 둔다 (1시간에 약 230 MB).
- 검증 안 함: Windows 10, 다른 PC(AVX2 없는 CPU 등), 3시간 이상 녹음.
