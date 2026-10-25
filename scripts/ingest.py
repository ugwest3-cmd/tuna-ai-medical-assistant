"""
Medical Knowledge Ingestion Pipeline for Tuna AI
Extracts, chunks, embeds, and loads medical textbook PDFs into Supabase pgvector.
"""
import os
import sys
import argparse
from typing import List, Dict, Any
from tqdm import tqdm
import fitz # PyMuPDF
from sentence_transformers import SentenceTransformer
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL_NAME", "BAAI/bge-large-en-v1.5")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    print("[Ingest Error] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in environment.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
print(f"[Ingest] Loading embedding model: {EMBEDDING_MODEL_NAME}...")
embed_model = SentenceTransformer(EMBEDDING_MODEL_NAME)

CHUNK_SIZE_WORDS = 450
CHUNK_OVERLAP_WORDS = 80
BATCH_INSERT_SIZE = 40

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE_WORDS, overlap: int = CHUNK_OVERLAP_WORDS) -> List[str]:
    """Splits raw text into sliding window word chunks with overlap."""
    words = text.split()
    if len(words) <= chunk_size:
        return [text] if len(words) >= 30 else []
    
    chunks = []
    step = chunk_size - overlap
    for i in range(0, len(words), step):
        chunk_words = words[i:i + chunk_size]
        if len(chunk_words) < 30: # Ignore tiny trailing sentence fragments
            continue
        chunks.append(" ".join(chunk_words))
    return chunks

def ingest_pdf(pdf_path: str, document_title: str, edition: str = None, doc_type: str = "professional"):
    """Parses a medical textbook PDF and embeds chunks into Supabase pgvector."""
    if not os.path.exists(pdf_path):
        print(f"[Ingest Error] File not found: {pdf_path}")
        return

    print(f"\n[Ingest] Opening PDF: {pdf_path}")
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    print(f"[Ingest] Processing '{document_title}' ({total_pages} pages, doc_type='{doc_type}')...")

    pending_records: List[Dict[str, Any]] = []
    total_chunks_inserted = 0

    for page_index in tqdm(range(total_pages), desc="Extracting & Embedding Pages"):
        page_num = page_index + 1
        page = doc[page_index]
        page_text = page.get_text("text").strip()

        if len(page_text.split()) < 30:
            continue

        chunks = chunk_text(page_text)
        for chunk in chunks:
            # Generate normalized vector embedding
            embedding = embed_model.encode(chunk, normalize_embeddings=True).tolist()

            record = {
                "document_title": document_title,
                "edition": edition,
                "page_number": page_num,
                "content": chunk,
                "token_count": len(chunk.split()),
                "doc_type": doc_type,
                "embedding": embedding
            }
            pending_records.append(record)

            # Flush batch
            if len(pending_records) >= BATCH_INSERT_SIZE:
                try:
                    supabase.table("medical_knowledge").insert(pending_records).execute()
                    total_chunks_inserted += len(pending_records)
                    pending_records = []
                except Exception as e:
                    print(f"\n[Ingest Error] Failed to insert batch: {e}")

    # Flush any remaining records
    if pending_records:
        try:
            supabase.table("medical_knowledge").insert(pending_records).execute()
            total_chunks_inserted += len(pending_records)
        except Exception as e:
            print(f"\n[Ingest Error] Failed to insert final batch: {e}")

    print(f"\n[Ingest Complete] '{document_title}': Inserted {total_chunks_inserted} vector chunks.")

def main():
    parser = argparse.ArgumentParser(description="Ingest Medical PDFs into Tuna AI pgvector Knowledge Base.")
    parser.add_argument("--file", "-f", required=True, help="Path to PDF file")
    parser.add_argument("--title", "-t", required=True, help="Document Title (e.g. 'Uganda Clinical Guidelines 2023')")
    parser.add_argument("--edition", "-e", default="Current", help="Book edition or year")
    parser.add_argument("--doc-type", "-d", default="professional", choices=["professional", "student"], help="Target audience (professional or student)")

    args = parser.parse_args()
    ingest_pdf(args.file, args.title, args.edition, args.doc_type)

if __name__ == "__main__":
    main()
