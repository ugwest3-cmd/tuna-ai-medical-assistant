"""
FastAPI Main Application: Uganda Clinical Decision Support Core Engine.
Includes:
- Clinical RAG inference (Groq Llama-3.3-70B)
- Diagnostic Lab & Scan Result Vision Interpreter (Groq Llama-3.2-Vision)
- PesaPal v3 UGX Billing & IPN Webhook
- Interactive Admin Knowledge Base Portal (/admin) for PDF guideline uploads
"""
import os
import shutil
import tempfile
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Header, Depends, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import fitz # PyMuPDF

from config import settings
from services.rag_engine import RAGEngine
from services.pesapal_service import PesaPalService
from services.lab_interpreter import LabInterpreter

app = FastAPI(
    title="Tuna AI Medical Assistant - Uganda Core Engine",
    version="2.0.0",
    description="Uganda Clinical Guidelines decision support, Groq RAG, Lab Vision Interpreter, and Admin Knowledge Manager."
)

rag_engine = RAGEngine()
pesapal_service = PesaPalService()
lab_interpreter = LabInterpreter()

# Templates directory for the Admin Portal
templates_dir = os.path.join(os.path.dirname(__file__), "templates")
templates = Jinja2Templates(directory=templates_dir)

# -------------------------------------------------------------
# Request & Response Models
# -------------------------------------------------------------
class QueryRequest(BaseModel):
    user_id: str
    phone: str
    prompt: str

class LabInterpretRequest(BaseModel):
    user_id: str
    phone: str
    image_base64: Optional[str] = None
    mime_type: Optional[str] = "image/jpeg"
    text_data: Optional[str] = None
    clinical_notes: Optional[str] = None

class CreateOrderRequest(BaseModel):
    userId: str
    phone: str
    packageTier: str

class TestQueryRequest(BaseModel):
    prompt: str

# -------------------------------------------------------------
# Security Dependencies
# -------------------------------------------------------------
async def verify_gateway_secret(x_secret: Optional[str] = Header(None)):
    if x_secret != settings.INTERNAL_GATEWAY_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid internal gateway secret")
    return True

async def verify_admin_secret(x_admin_secret: Optional[str] = Header(None)):
    if x_admin_secret != settings.ADMIN_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid admin secret key")
    return True

# -------------------------------------------------------------
# General Endpoints
# -------------------------------------------------------------
@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "service": "Tuna AI Uganda Core Engine",
        "country": "Uganda",
        "ai_engine": f"Groq ({settings.GROQ_TEXT_MODEL})",
        "vision_engine": f"Groq ({settings.GROQ_VISION_MODEL})",
        "version": "2.0.0"
    }

# -------------------------------------------------------------
# Clinical Query Endpoint (WhatsApp Gateway)
# -------------------------------------------------------------
@app.post("/api/v1/query")
async def handle_clinical_query(
    payload: QueryRequest,
    _authorized: bool = Depends(verify_gateway_secret)
):
    """
    Primary endpoint for processing clinical queries from WhatsApp.
    Deducts 1 credit atomically and executes vector search + Groq Llama-3.3 completion.
    Output is strictly formatted per Uganda Clinical Guidelines with zero page citations.
    """
    # 1. Atomic credit deduction check
    deducted = rag_engine.supabase.rpc("deduct_credit", {
        "p_user_id": payload.user_id,
        "p_amount": 1
    }).execute()

    if not deducted.data:
        return {
            "status": "insufficient_credits",
            "message": "⚠️ *Insufficient Balance:* You have 0 credits remaining.\n\nReply *BUY* to view top-up packages."
        }

    # 2. Execute RAG pipeline
    try:
        result = await rag_engine.generate_response(payload.user_id, payload.prompt)
        return {
            "status": "success",
            "response": result["response"],
            "is_emergency": result["is_emergency"]
        }
    except Exception as e:
        print(f"[Query Error] {e}")
        # Refund credit if processing failed
        rag_engine.supabase.rpc("increment_user_credits", {
            "user_uuid": payload.user_id,
            "amount_to_add": 1
        }).execute()
        raise HTTPException(status_code=500, detail="Clinical inference service failed. Credit refunded.")

# -------------------------------------------------------------
# Diagnostic Lab & Scan Interpretation Endpoint
# -------------------------------------------------------------
@app.post("/api/v1/interpret-lab")
async def handle_lab_interpretation(
    payload: LabInterpretRequest,
    _authorized: bool = Depends(verify_gateway_secret)
):
    """
    Interprets lab slips, blood tests, or diagnostic scan images/text using Groq Vision.
    Deducts 1 credit atomically upon success.
    """
    # 1. Atomic credit deduction check
    deducted = rag_engine.supabase.rpc("deduct_credit", {
        "p_user_id": payload.user_id,
        "p_amount": 1
    }).execute()

    if not deducted.data:
        return {
            "status": "insufficient_credits",
            "message": "⚠️ *Insufficient Balance:* You have 0 credits remaining.\n\nReply *BUY* to view top-up packages."
        }

    try:
        if payload.image_base64:
            interpretation = await lab_interpreter.interpret_from_image(
                image_base64=payload.image_base64,
                mime_type=payload.mime_type or "image/jpeg",
                user_notes=payload.clinical_notes
            )
        elif payload.text_data:
            interpretation = await lab_interpreter.interpret_from_text(payload.text_data)
        else:
            raise HTTPException(status_code=400, detail="Provide either image_base64 or text_data.")

        # Log into chat_logs
        rag_engine.supabase.table("chat_logs").insert({
            "user_id": payload.user_id,
            "incoming_message": "[Lab / Scan Interpretation Request]",
            "ai_response": interpretation
        }).execute()

        return {
            "status": "success",
            "response": interpretation
        }
    except Exception as e:
        print(f"[Lab Interpretation Error] {e}")
        # Refund credit on failure
        rag_engine.supabase.rpc("increment_user_credits", {
            "user_uuid": payload.user_id,
            "amount_to_add": 1
        }).execute()
        raise HTTPException(status_code=500, detail=f"Diagnostic interpretation failed: {str(e)}")

# -------------------------------------------------------------
# PesaPal v3 Payments
# -------------------------------------------------------------
@app.post("/api/v1/payments/create-order")
async def create_payment_order(
    payload: CreateOrderRequest,
    _authorized: bool = Depends(verify_gateway_secret)
):
    try:
        result = await pesapal_service.create_payment_order(
            user_id=payload.userId,
            phone=payload.phone,
            package_tier=payload.packageTier
        )
        return result
    except Exception as e:
        print(f"[Order Creation Error] {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.all("/api/v1/webhook/pesapal")
async def pesapal_ipn_webhook(request: Request):
    """
    Public webhook receiver for PesaPal v3 Instant Payment Notifications (IPN).
    """
    try:
        params = request.query_params
        order_tracking_id = params.get("OrderTrackingId")
        merchant_reference = params.get("OrderMerchantReference") or params.get("MerchantReference")
        notification_type = params.get("OrderNotificationType")

        if not order_tracking_id or not merchant_reference:
            if request.method == "POST":
                body = await request.json()
                order_tracking_id = body.get("OrderTrackingId")
                merchant_reference = body.get("MerchantReference")
                notification_type = body.get("NotificationType")

        if not order_tracking_id or not merchant_reference:
            return {"status": "ignored", "reason": "Missing tracking parameters"}

        res = await pesapal_service.process_ipn(order_tracking_id, merchant_reference)

        return {
            "orderNotificationType": notification_type or "IPNCHANGE",
            "orderTrackingId": order_tracking_id,
            "orderMerchantReference": merchant_reference,
            "status": 200,
            "result": res
        }
    except Exception as e:
        print(f"[IPN Error] {e}")
        return {"status": "error", "message": str(e)}

# -------------------------------------------------------------
# Admin Knowledge Portal & Document Upload
# -------------------------------------------------------------
@app.get("/admin", response_class=HTMLResponse)
async def admin_portal_page(request: Request):
    """Renders the interactive web Admin Portal."""
    return templates.TemplateResponse("admin.html", {"request": request})

@app.post("/api/v1/admin/upload-doc")
async def admin_upload_document(
    file: UploadFile = File(...),
    title: str = Form(...),
    edition: Optional[str] = Form("Standard"),
    _authorized: bool = Depends(verify_admin_secret)
):
    """
    Receives PDF from Admin Portal, chunks text, computes embeddings, and stores in Supabase pgvector.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        doc = fitz.open(tmp_path)
        total_pages = len(doc)
        records_to_insert = []
        total_chunks = 0

        chunk_size = 450
        overlap = 80

        for page_idx in range(total_pages):
            page_text = doc[page_idx].get_text("text").strip()
            words = page_text.split()
            if len(words) < 30:
                continue

            # Sliding window chunking
            step = chunk_size - overlap
            for i in range(0, len(words), step):
                chunk_words = words[i:i + chunk_size]
                if len(chunk_words) < 30:
                    continue
                chunk_str = " ".join(chunk_words)

                embedding = rag_engine.embed_model.encode(chunk_str, normalize_embeddings=True).tolist()

                records_to_insert.append({
                    "document_title": title,
                    "edition": edition,
                    "page_number": page_idx + 1,
                    "content": chunk_str,
                    "token_count": len(chunk_words),
                    "embedding": embedding
                })

                if len(records_to_insert) >= 40:
                    rag_engine.supabase.table("medical_knowledge").insert(records_to_insert).execute()
                    total_chunks += len(records_to_insert)
                    records_to_insert = []

        if records_to_insert:
            rag_engine.supabase.table("medical_knowledge").insert(records_to_insert).execute()
            total_chunks += len(records_to_insert)

        return {
            "status": "success",
            "title": title,
            "edition": edition,
            "pages_processed": total_pages,
            "chunks_count": total_chunks
        }
    except Exception as e:
        print(f"[Upload Error] {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.get("/api/v1/admin/knowledge-stats")
async def admin_knowledge_stats(_authorized: bool = Depends(verify_admin_secret)):
    """Fetches knowledge statistics and indexed document summaries."""
    try:
        # Get count of total chunks
        chunks_res = rag_engine.supabase.table("medical_knowledge").select("id", count="exact").execute()
        total_chunks = chunks_res.count or 0

        # Get count of users
        users_res = rag_engine.supabase.table("users").select("id", count="exact").execute()
        total_users = users_res.count or 0

        # Fetch unique documents
        docs_res = rag_engine.supabase.table("medical_knowledge").select("document_title, edition").execute()
        raw_docs = docs_res.data or []

        doc_map: Dict[str, Dict[str, Any]] = {}
        for r in raw_docs:
            title = r.get("document_title") or "Untitled Document"
            edition = r.get("edition") or "Standard"
            if title not in doc_map:
                doc_map[title] = {"title": title, "edition": edition, "chunks": 0}
            doc_map[title]["chunks"] += 1

        return {
            "total_chunks": total_chunks,
            "total_users": total_users,
            "documents": list(doc_map.values())
        }
    except Exception as e:
        print(f"[Stats Error] {e}")
        return {"total_chunks": 0, "total_users": 0, "documents": []}

@app.delete("/api/v1/admin/delete-doc")
async def admin_delete_document(title: str, _authorized: bool = Depends(verify_admin_secret)):
    """Deletes all chunks associated with a specific guideline document."""
    try:
        rag_engine.supabase.table("medical_knowledge").delete().eq("document_title", title).execute()
        return {"status": "success", "deleted_title": title}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/v1/admin/test-query")
async def admin_test_query(payload: TestQueryRequest, _authorized: bool = Depends(verify_admin_secret)):
    """Allows testing clinical queries directly in the Admin Portal without credit deductions."""
    try:
        result = await rag_engine.generate_response(user_id="admin-sandbox", prompt=payload.prompt)
        return {"response": result["response"]}
    except Exception as e:
        return {"response": f"Query Error: {str(e)}"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=True)
