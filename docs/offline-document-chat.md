# Offline document chat

Document chat accepts PDF, TXT, Markdown, and CSV using the attachment picker or
by dropping files onto the message composer. Images retain their existing upload
flow. Documents are indexed before being added to the draft. Progress displays
file name and completed/total chunks, with Cancel available.

## Local embedding server

Use a local embedding GGUF alongside the application's chat engine. For example:

```sh
llama-server -m /path/to/embedding-model.gguf --embedding --pooling mean --host 127.0.0.1 --port 8081
```

Choose the pooling mode supported by that embedding model (mean, cls, or last;
OpenAI embeddings require pooling other than none). This process is separate
from the chat engine because llama-server embedding mode is dedicated to
embedding inference. No model is downloaded by the app.

In Settings → Server Config → Offline document chat, configure the embedding
port (default 8081), optional model ID, and optional API key. A blank model ID
uses the first model returned by the local `/v1/models` endpoint. Requests go
only to `127.0.0.1`, with redirects disabled. Once dependencies and the GGUF are
installed, document chat requires no internet connection.

## Storage and retrieval

- `pdf-parse` extracts PDF text locally. Image-only/scanned PDFs need OCR first.
- Text is split into 500-character chunks with 50-character overlap.
- `/v1/embeddings` generates vectors; complete indexes are committed atomically
  to SQLite `document_chunks` in the existing app database.
- File hashes and embedding server/model identity prevent stale index reuse.
  If model weights change under the same ID, clear the corresponding index or
  use a distinct model ID.
- Each chat question retrieves the three most similar chunks by cosine similarity
  from that session's document attachments, including earlier turns. Other chats
  are excluded. Branches inherit only attachments through their branch point;
  deleting an attachment-bearing message removes it from that chat's retrieval.
- The first system prompt gets named excerpts and the question, with instructions
  to treat excerpts as reference data and cite their file/chunk labels. Whole
  documents are not inserted into chat prompts.
- Managed document files and indexes remain on disk for reuse. Documents are
  limited to 20 MB each, 50 MB per upload, and 10,000 chunks per document.

The UI shows embedding connection/parser errors rather than silently sending a
question without its requested document context. A running chat model plus a
running embedding model are required for end-to-end answers.

References:
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- https://github.com/mehmet-kozan/pdf-parse
