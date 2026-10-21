# Tuna AI Medical Assistant 🩺 🇺🇬
### Authoritative Clinical Decision Support for Healthcare Providers in Uganda

Tuna AI is built exclusively as the clinical backbone for healthcare professionals across Uganda (Medical Officers, Clinical Officers, Nurses, Midwives, and Interns). Operating natively on WhatsApp, it provides rapid clinical decision support strictly grounded in the **Uganda Clinical Guidelines (UCG)**, Ministry of Health (MoH) protocols, and uploaded national clinical documents.

---

## What Makes Tuna AI Unique

* ⚡ **Powered by Groq Cloud AI:** Sub-second clinical reasoning powered by `llama-3.3-70b-versatile` and multimodal vision diagnostics via `llama-3.2-11b-vision-preview`.
* 📋 **Clean, Step-by-Step UCG Protocols:** Short, punchy, actionable treatment steps with exact adult and pediatric dosages. **Zero clutter, zero page numbers, zero book citations.**
* 🔬 **Lab & Scan Result Reader:** Healthcare workers can snap a photo of any laboratory slip, CBC blood report, urinalysis strip, malaria RDT cassette, or ultrasound report on WhatsApp to receive an instant breakdown of abnormal values and recommended UCG management steps.
* 🌐 **Interactive Admin Knowledge Portal:** A web dashboard at `/admin` to upload Uganda Clinical Guidelines PDFs, automatically chunking and embedding them into Supabase pgvector.
* 💳 **Ugandan Mobile Money Integration:** Instant credit top-ups via **PesaPal v3** supporting MTN MoMo, Airtel Money, and Cards (UGX).
* 🔒 **Stateful WhatsApp Gateway:** Persistent Baileys connection on Railway with **8-digit Pairing Code** support (no need to scan QR codes on remote server logs).

---

## System Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │               WhatsApp Client                │
                    │      (Doctor / Clinical Officer / Nurse)     │
                    └──────────────────────┬───────────────────────┘
                                           │
                     ┌─────────────────────┴───────────────────────┐
                     │ Text Query                   Lab/Scan Photo │
                     ▼                                             ▼
        ┌─────────────────────────┐               ┌─────────────────────────┐
        │ WhatsApp Baileys Worker │               │ WhatsApp Baileys Worker │
        │  (Direct Text Message)  │               │ (Media Buffer Download) │
        └────────────┬────────────┘               └────────────┬────────────┘
                     │                                         │
                     └─────────────────────┬───────────────────┘
                                           │ HTTP (Internal Secret)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Tuna AI Core Engine (FastAPI)                          │
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│ 🩺 Clinical RAG Engine                 │ 🔬 Diagnostic Lab / Scan Vision Engine        │
│ • pgvector Cosine Search (UCG Chunks)  │ • Groq Llama-3.2-Vision Analysis              │
│ • Red-Flag Emergency Screening         │ • Extracted Values vs Reference Ranges        │
│ • Groq Llama-3.3-70B Completion        │ • Abnormal Findings & UCG Action Plan         │
├────────────────────────────────────────┴───────────────────────────────────────────────┤
│ 🌐 Admin Knowledge Portal (/admin)                                                     │
│ • Drag-and-drop PDF guidelines upload, auto-chunking & vector embedding                │
│ • Vector knowledge base stats, chunk counter, and interactive test sandbox             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 💳 PesaPal v3 UGX Billing Engine                                                      │
│ • Mobile Money order generation (MTN/Airtel) & IPN webhook callback                    │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │
                        ┌────────────────┴────────────────┐
                        ▼                                 ▼
        ┌───────────────────────────────┐ ┌───────────────────────────────┐
        │        Supabase Cloud         │ │          Groq Cloud           │
        │ • Users, Credits, Orders      │ │ • Llama-3.3-70B (Text)        │
        │ • pgvector (medical_knowledge)│ │ • Llama-3.2-Vision (Labs)     │
        └───────────────────────────────┘ └───────────────────────────────┘
```

---

## Directory Layout

```
g:\Tuna Ai Medical Assistant\
├── supabase/
│   └── schema.sql                 # PostgreSQL schema, pgvector index & atomic RPCs
├── core_api/                      # FastAPI Clinical Core & Admin Portal
│   ├── main.py                    # API routes, webhooks, and admin endpoints
│   ├── config.py                  # Pydantic settings with Groq & Supabase defaults
│   ├── templates/
│   │   └── admin.html             # Web Admin Portal UI for PDF uploads
│   ├── services/
│   │   ├── rag_engine.py          # Vector retrieval & Groq Llama-3.3-70B completion
│   │   ├── lab_interpreter.py     # Groq Vision lab & scan diagnostic interpreter
│   │   ├── safety.py              # UCG system prompt & red-flag triage screening
│   │   └── pesapal_service.py     # PesaPal v3 mobile money checkout & IPN handler
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── whatsapp_gateway/              # Stateful WhatsApp Baileys Worker
│   ├── worker.js                  # Baileys client with image download & pairing code
│   ├── package.json
│   ├── Dockerfile
│   └── .env.example
├── scripts/                       # CLI Ingestion Pipeline
│   ├── ingest.py                  # Command-line PDF extraction & embedding script
│   ├── requirements.txt
│   └── README.md
├── docker-compose.yml             # Local Docker orchestration
└── README.md
```

---

## Quick Start & Deployment

### 1. Database Setup (Supabase)
1. In your [Supabase Project Dashboard](https://supabase.com/dashboard), open the **SQL Editor**.
2. Run the SQL script from [`supabase/schema.sql`](file:///g:/Tuna%20Ai%20Medical%20Assistant/supabase/schema.sql).
3. This creates all tables (`users`, `credit_transactions`, `payment_orders`, `medical_knowledge`, `chat_logs`) and the required RPC functions (`deduct_credit`, `increment_user_credits`, `match_medical_knowledge`).

---

### 2. Admin Knowledge Portal — Uploading Guidelines
You can upload the **Uganda Clinical Guidelines 2023** directly from your browser!
1. Start the Core API:
   ```bash
   cd core_api
   uvicorn main:app --port 8000 --reload
   ```
2. Open **`http://localhost:8000/admin`** in your browser.
3. Enter your `ADMIN_SECRET` (default: `tuna-admin-uganda-pass`).
4. Drag-and-drop the Uganda Clinical Guidelines PDF, enter Title (`Uganda Clinical Guidelines 2023`) and Edition (`2023 MoH`), then click **Ingest Document**.
5. The system automatically reads, chunks, embeds, and stores the guidelines into Supabase pgvector in real time!

---

### 3. Deploying to Railway

#### Service A: Core API (`core_api`)
- **Root Directory:** `/core_api`
- **Environment Variables:**
  ```env
  SUPABASE_URL=https://tormcjsptsstcmsaebsl.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
  INTERNAL_GATEWAY_SECRET=your-secret-token
  ADMIN_SECRET=your-admin-password
  GROQ_API_KEY=gsk_your_groq_api_key
  GROQ_TEXT_MODEL=llama-3.3-70b-versatile
  GROQ_VISION_MODEL=llama-3.2-11b-vision-preview
  PESAPAL_CONSUMER_KEY=your-key
  PESAPAL_CONSUMER_SECRET=your-secret
  PESAPAL_ENV=sandbox
  PESAPAL_IPN_ID=your-ipn-id
  WHATSAPP_WORKER_URL=http://whatsapp-gateway.railway.internal:8080
  ```

#### Service B: WhatsApp Gateway (`whatsapp_gateway`)
- **Root Directory:** `/whatsapp_gateway`
- **Railway Volume Mount:** Create a persistent volume mounted at `/data`!
- **Environment Variables:**
  ```env
  SUPABASE_URL=https://tormcjsptsstcmsaebsl.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
  CORE_API_URL=http://core-api.railway.internal:8000
  INTERNAL_GATEWAY_SECRET=your-secret-token
  SESSION_PATH=/data/tuna_session
  PHONE_NUMBER_FOR_PAIRING=256701234567
  ```

---

### 4. WhatsApp Pairing
- When you set `PHONE_NUMBER_FOR_PAIRING`, check Railway logs:
  ```
  ======================================================
    TUNA AI WHATSAPP PAIRING CODE: [ 89AB-CDEF ]
    Enter this code on your WhatsApp mobile device.
  ======================================================
  ```
- On WhatsApp: Go to **Settings > Linked Devices > Link with phone number instead**, and type the code.

---

## Clinical Response Format Example

When a healthcare provider sends:
> *"6-year-old child presenting with acute watery diarrhea, sunken eyes, skin pinch returns after 3 seconds, unable to drink. How to manage at HC III?"*

Tuna AI responds cleanly without page numbers:

> 🚨 *CRITICAL EMERGENCY ALERT (UCG RED-FLAG)* 🚨  
> Signs indicate Severe Dehydration with potential hypovolemic shock.  
> 
> 🩺 *CLINICAL ASSESSMENT*  
> Severe Dehydration (Plan C) in a pediatric patient requiring immediate intravenous volume resuscitation.  
> 
> 📋 *TREATMENT PROTOCOL (UCG)*  
> • *Step 1: Immediate Stabilization / First-Line Resuscitation*  
>   - Fluid: Ringer's Lactate (or Normal Saline 0.9% if RL unavailable).  
>   - Dosage: 100 mL/kg total volume.  
>   - Administration: Give 30 mL/kg over the first 30 minutes, then 70 mL/kg over the subsequent 2.5 hours.  
> 
> • *Step 2: Second-Line / Oral Rehydration Transition*  
>   - Once child can drink: Give low-osmolarity ORS solution (5 mL/kg/hour).  
>   - Zinc Sulfate: 20 mg once daily orally for 14 days.  
> 
> • *Step 3: Key Monitoring & Patient Advice*  
>   - Re-evaluate pulse, skin pinch, and consciousness every 15-30 minutes.  
>   - Continue breastfeeding/feeding as soon as child is alert.  
> 
> 🚨 *RED FLAGS FOR URGENT REFERRAL*  
> • Signs of severe septic shock, uncorrectable metabolic acidosis, or failure to produce urine after 4 hours of rehydration. Transfer immediately to HC IV or General Hospital.

---

## Git Repository Sync

To push this codebase to your repository:

```bash
git add .
git commit -m "feat: complete Tuna AI Uganda edition with Groq RAG, Lab Vision Interpreter, and Admin Portal"
git push -u origin main
```
