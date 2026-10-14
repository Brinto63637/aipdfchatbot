from __future__ import annotations

import io
import os
import re
import urllib.error
import urllib.request
from collections import Counter
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pypdf import PdfReader

app = FastAPI(title="AIPDF Chatbot")
app.mount("/static", StaticFiles(directory="static"), name="static")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "smollm2:1.7b")
MAX_UPLOAD_BYTES = 30 * 1024 * 1024

# In-memory document index: uploaded files are not written to disk.
documents: dict[str, list[dict[str, Any]]] = {}


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]{2,}", text.lower())


def make_chunks(filename: str, pdf_bytes: bytes) -> list[dict[str, Any]]:
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:
                raise ValueError("This PDF is password-protected.") from exc
    except Exception as exc:
        raise ValueError("This file could not be opened as a PDF.") from exc

    chunks: list[dict[str, Any]] = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if not text:
            continue
        # Keep page citations intact and split long pages into overlapping passages.
        size, overlap = 1100, 140
        start = 0
        while start < len(text):
            passage = text[start : start + size].strip()
            if passage:
                chunks.append({"filename": filename, "page": page_number, "text": passage})
            start += size - overlap
    if not chunks:
        raise ValueError("No selectable text was found. This PDF may be a scanned image.")
    return chunks


def retrieve(question: str, limit: int = 6) -> list[dict[str, Any]]:
    query = Counter(words(question))
    scored: list[tuple[float, dict[str, Any]]] = []
    for passages in documents.values():
        for passage in passages:
            terms = Counter(words(passage["text"]))
            score = sum(min(count, terms.get(term, 0)) for term, count in query.items())
            if score:
                scored.append((score, passage))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [passage for _, passage in scored[:limit]]


@app.get("/")
def home() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        request = urllib.request.Request(f"{OLLAMA_URL.rstrip('/')}/api/tags")
        with urllib.request.urlopen(request, timeout=3) as response:
            tags = __import__("json").load(response)
        models = [item.get("name", "") for item in tags.get("models", [])]
        return {"ollama": True, "model": OLLAMA_MODEL, "model_available": any(name == OLLAMA_MODEL or name.startswith(OLLAMA_MODEL + ":") for name in models), "documents": len(documents)}
    except Exception:
        return {"ollama": False, "model": OLLAMA_MODEL, "model_available": False, "documents": len(documents)}


@app.get("/api/documents")
def list_documents() -> list[dict[str, Any]]:
    return [{"name": name, "pages_indexed": len({p["page"] for p in passages})} for name, passages in documents.items()]


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Choose a PDF file.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "PDFs must be smaller than 30 MB.")
    try:
        passages = make_chunks(file.filename, content)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    documents[file.filename] = passages
    return {"name": file.filename, "pages_indexed": len({p["page"] for p in passages}), "passages": len(passages)}


@app.delete("/api/documents/{name}")
def delete_document(name: str) -> dict[str, str]:
    if name not in documents:
        raise HTTPException(404, "Document not found.")
    del documents[name]
    return {"deleted": name}


class ChatRequest(BaseModel):
    question: str
    history: list[dict[str, str]] = []


@app.post("/api/chat")
def chat(body: ChatRequest) -> dict[str, Any]:
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "Type a question first.")
    if not documents:
        raise HTTPException(400, "Upload a PDF before asking a question.")
    passages = retrieve(question)
    if not passages:
        raise HTTPException(404, "I couldn't find a relevant passage in the uploaded PDFs. Try asking with different terms.")

    context = "\n\n".join(f"[Source: {p['filename']}, page {p['page']}]\n{p['text']}" for p in passages)
    prompt = (
        "Answer the user's question using only the PDF excerpts below. If they do not contain the answer, say so clearly. "
        "Cite supporting claims inline like [filename, p. 3]. Be concise and do not invent citations.\n\n"
        f"PDF excerpts:\n{context}\n\nQuestion: {question}"
    )
    messages = [{"role": "system", "content": "You are a careful assistant that answers questions about uploaded PDFs."}]
    for item in body.history[-8:]:
        if item.get("role") in {"user", "assistant"} and isinstance(item.get("content"), str):
            messages.append({"role": item["role"], "content": item["content"][:3000]})
    messages.append({"role": "user", "content": prompt})

    import json
    payload = json.dumps({"model": OLLAMA_MODEL, "messages": messages, "stream": False}).encode()
    request = urllib.request.Request(f"{OLLAMA_URL.rstrip('/')}/api/chat", data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            result = json.load(response)
        answer = result.get("message", {}).get("content", "").strip()
        if not answer:
            raise HTTPException(502, "Ollama returned an empty answer.")
        sources = list(dict.fromkeys((p["filename"], p["page"]) for p in passages))
        return {"answer": answer, "sources": [{"name": name, "page": page} for name, page in sources]}
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(503, f"Model '{OLLAMA_MODEL}' is missing. Pull it with: ollama pull {OLLAMA_MODEL}") from exc
        raise HTTPException(502, f"Ollama returned an error ({exc.code}).") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(503, "Can't reach Ollama. Start Ollama and try again.") from exc

