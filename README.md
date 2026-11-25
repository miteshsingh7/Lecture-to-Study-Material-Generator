# Smart Lecture-to-Study Material Generator

Turn recorded lecture transcripts (`.txt` or `.pdf`) into structured study packs (`Summary`, `Topic Notes`, `Key Definitions`, `Revision Questions`), interactive flashcard decks, and a grounded **Chat with this lecture** Q&A assistant.

> **LLM Architecture Note:** Groq replaces Amazon Bedrock *only* for the LLM chat-completion calls (`LLM_PROVIDER=groq`, with `bedrock` and `mock` selectable behind the same provider interface). **S3**, **AWS Lambda**, **API Gateway**, and **AWS Amplify** remain in place for storage, serverless execution, routing, and web hosting.

---

## Architecture

- **Frontend (`src/`)**: React + Vite + Tailwind web app (`Study Generator`, `Library`, `Decks`, and `LectureChatPanel`).
- **Backend (`backend/`)**:
  - `llm_provider.py` — Unified `chat_completion()` interface (`groq | bedrock | mock`) with sliding-window token throttling, HTTP `429` `Retry-After` backoff, and fallback to `GROQ_FALLBACK_MODEL`.
  - `retrieval.py` — Pure-Python chunking (`~1,000–1,500` chars with overlap) and Okapi BM25 retriever (lowercasing, stopword filtering, follow-up query expansion, top-4 chunks).
  - `pipeline.py` — Extracts text, builds `results/<job_id>/chunks.json`, and generates the 4-section Markdown study pack through `llm_provider.py`.
  - `chat_service.py` — Stateless `handle_chat()` (`POST /chat`) validating `job_id`, capping history at `4` turns and questions at `500` chars, enforcing `< 3,000` input tokens and `max_tokens=500`, and citing source excerpt numbers.
  - `app.py` (local Flask server) and `lambda_processor.py` / `lambda_api.py` (AWS Lambda handlers) share the exact same `pipeline.py` and `chat_service.py` core modules.

---

## Groq Free-Tier Rate Limits (Verified at `console.groq.com/docs/rate-limits`)

Rate limits are enforced at the **organization** level:

| Model | Tier | RPM | TPM | RPD | TPD |
|---|---|---:|---:|---:|---:|
| `llama-3.3-70b-versatile` | Free Tier | 30 | 12,000 | 1,000 | 100,000 |
| `llama-3.1-8b-instant` | Free Tier | 30 | 6,000 | 14,400 | 500,000 |

*(Note: Newer/restricted free-tier Groq organizations may have `llama-3.3-70b-versatile` disabled in favor of newer defaults such as `openai/gpt-oss-120b` / `openai/gpt-oss-20b`, which have ~8,000 TPM on-demand limits. Configure `GROQ_MODEL` and `GROQ_FALLBACK_MODEL` accordingly.)*

---

## Setup & Environment Variables

1. **Configure API Key (never commit `.env`!)**:
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env and set GROQ_API_KEY=<your_groq_key>
   ```
   `.env` is listed in `.gitignore`. In AWS Lambda, configure `GROQ_API_KEY` as a Lambda environment variable (or load from SSM Parameter Store SecureString).

2. **Environment Variables**:

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `groq` | Active LLM provider (`groq`, `bedrock`, or `mock`) |
| `GROQ_API_KEY` | *(empty)* | Groq API key (never log or commit) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Primary Groq model (set `openai/gpt-oss-120b` in live Lambdas if Llama is disabled on your org) |
| `GROQ_FALLBACK_MODEL` | `llama-3.1-8b-instant` | Automatic fallback model on daily limit / unavailable model (`openai/gpt-oss-20b` on live Lambdas) |
| `GROQ_ENDPOINT` | `https://api.groq.com/openai/v1/chat/completions` | OpenAI-compatible Groq endpoint |
| `GROQ_TPM_LIMIT` | `12000` | Sliding 60s token throttle budget for consecutive pipeline calls |
| `GROQ_RPM_LIMIT` | `30` | Sliding 60s request throttle budget |
| `BEDROCK_MODEL_ID` | `amazon.nova-micro-v1:0` | Bedrock Converse model used when `LLM_PROVIDER=bedrock` |
| `AWS_REGION` | `ap-southeast-2` | AWS region for S3 and Bedrock |
| `BUCKET_NAME` | `lecture-study-generator-790317642879` | S3 bucket storing uploads, status, results, and `chunks.json` |
| `LOCAL_DATA_DIR` | `local_data` | Local filesystem directory when running Flask `app.py` |

---

## API Endpoints

- `POST /upload-url` *(AWS)* / `POST /upload` *(Flask)* — Upload a `.txt` or `.pdf` lecture transcript.
- `GET /status/{jobId}` — Poll processing status and fetch presigned `study_pack.md` download URL.
- `GET /library` & `GET /library/{jobId}` — List and read saved study packs from S3 / local storage.
- `POST /chat` — Grounded Q&A over indexed `chunks.json` (`{ job_id, question, history }`), returning `{ answer, sources, model, provider }`.

---

## Local Development & Tests

```bash
# Backend tests
cd backend
python3.11 -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/pytest tests -v

# Optional local Flask API
./venv/bin/python app.py

# Frontend
cd ..
npm install
npm run dev
```
