# Tuna AI - Knowledge Ingestion Pipeline

This folder contains the ingestion pipeline to parse, chunk, embed, and store medical reference textbooks into the Supabase `medical_knowledge` pgvector database.

## Prerequisites

1. Install Python 3.10+
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Set your Supabase credentials in a `.env` file in this directory or in your shell:
   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   EMBEDDING_MODEL_NAME=BAAI/bge-large-en-v1.5
   ```

## Ingesting a Medical Textbook

Run the `ingest.py` script specifying the PDF path and textbook title:

```bash
python ingest.py --file "path/to/Uganda_Clinical_Guidelines_2023.pdf" --title "Uganda Clinical Guidelines 2023" --edition "2023 Edition"
```

The script will:
1. Extract text page-by-page using PyMuPDF.
2. Segment text into sliding-window semantic chunks with 80-word overlap.
3. Compute 1024-dimensional normalized embeddings via `bge-large-en-v1.5`.
4. Batch-insert records directly into Supabase.
