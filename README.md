# Tuna AI Medical Assistant 🩺 🇺🇬
### Authoritative Clinical Decision Support for Healthcare Providers in Uganda

Tuna AI is built exclusively as the clinical backbone for healthcare professionals across Uganda (Medical Officers, Clinical Officers, Nurses, Midwives, and Interns). Operating natively on WhatsApp, it provides rapid clinical decision support strictly grounded in the **Uganda Clinical Guidelines (UCG)**, Ministry of Health (MoH) protocols, and uploaded national clinical documents.

---

## What Makes Tuna AI Unique

* ⚡ **Powered by Groq Cloud AI:** Sub-second clinical reasoning powered by `llama-3.3-70b-versatile` and multimodal vision diagnostics via `llama-3.2-11b-vision-preview`.
* 📋 **Clean, Step-by-Step UCG Protocols:** Short, punchy, actionable treatment steps with exact adult and pediatric dosages. **Zero clutter, zero page numbers, zero book citations.**
* 🔬 **Lab & Scan Result Reader:** Healthcare workers can snap a photo of any laboratory slip, CBC blood report, urinalysis strip, malaria RDT cassette, or ultrasound report on WhatsApp to receive an instant breakdown of abnormal values and recommended UCG management steps.
* 🌐 **Admin Knowledge Portal (Vercel & Web):** A responsive web dashboard at `/admin` to upload Uganda Clinical Guidelines PDFs, view pgvector chunk stats, manage health workers, and monitor mobile money payments.
* 💳 **Ugandan Mobile Money Integration:** Instant credit top-ups via **PesaPal v3** supporting MTN MoMo, Airtel Money, and Visa/Mastercard (UGX).
* 🔒 **Stateful WhatsApp Gateway:** Persistent Baileys connection on Railway with **8-digit Pairing Code** support (no need to scan QR codes on remote server logs).

---

## Deployment Architecture: Vercel + Railway + Supabase

```
                     ┌──────────────────────────────────────────────┐
                     │               WhatsApp Client                │
                     │      (Doctor / Clinical Officer / Nurse)     │
                     └──────────────────────┬───────────────────────┘
                                            │ WhatsApp WebSocket
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │          Railway WhatsApp Gateway            │
                     │  • Persistent Session Mount (/data)          │
                     │  • 8-digit Pairing Code & Media Download     │
                     └──────────────────────┬───────────────────────┘
                                            │ HTTPS API Calls
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Vercel Serverless Cloud Platform                          │
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│ 🩺 Serverless Clinical API (/api/query)│ 🔬 Diagnostic Lab Vision (/api/interpret-lab) │
│ • Groq Llama-3.3-70B Inference         │ • Groq Llama-3.2-Vision Analysis              │
│ • Uganda Clinical Guidelines Protocol  │ • Lab Parameter Extraction & UCG Action       │
├────────────────────────────────────────┴───────────────────────────────────────────────┤
│ 🌐 Admin Knowledge Portal (/admin)                                                     │
│ • Real-time stats (pgvector chunks, registered health workers, recent payments)        │
│ • Live Diagnostic Testing Sandbox                                                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 💳 PesaPal v3 UGX Billing Engine (/api/pesapal-ipn & /api/create-order)               │
│ • Instant MTN MoMo / Airtel Money order generation                                     │
│ • Serverless IPN webhook listener that validates status & fulfills credits             │
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
├── vercel.json                    # Vercel deployment routing & serverless build config
├── package.json                   # Vercel serverless dependencies (@supabase/supabase-js, groq-sdk, axios)
├── public/
│   └── index.html                 # Admin Knowledge Portal & Clinical Dashboard (hosted on Vercel)
├── api/                           # Vercel Serverless Functions
│   ├── pesapal-ipn.js             # PesaPal v3 IPN webhook receiver & credit fulfillment
│   ├── create-order.js            # PesaPal v3 MTN/Airtel checkout link generator
│   ├── query.js                   # Clinical RAG query processor with Groq Llama-3.3-70B
│   ├── interpret-lab.js           # Multimodal Lab & Scan Vision diagnostic reader
│   └── admin-stats.js             # Live statistics endpoint for the Admin Portal
├── core_api/                      # Standalone Python FastAPI Engine (Railway / Docker option)
│   ├── main.py                    # API routes, webhooks, and admin endpoints
│   ├── config.py                  # Pydantic settings with Groq & Supabase defaults
│   ├── templates/admin.html       # Web Admin Portal UI
│   ├── services/
│   │   ├── rag_engine.py          # Vector retrieval & Groq Llama-3.3-70B completion
│   │   ├── lab_interpreter.py     # Groq Vision lab & scan diagnostic interpreter
│   │   ├── safety.py              # UCG system prompt & red-flag triage screening
│   │   └── pesapal_service.py     # PesaPal v3 mobile money checkout & IPN handler
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── whatsapp_gateway/              # Stateful WhatsApp Baileys Worker (Railway)
│   ├── worker.js                  # Baileys client with image download, pairing code & Vercel sync
│   ├── package.json
│   ├── Dockerfile
│   └── .env.example
├── supabase/
│   └── schema.sql                 # Complete PostgreSQL schema, pgvector index & atomic RPCs
├── scripts/                       # CLI Ingestion Pipeline
│   ├── ingest.py                  # Command-line PDF extraction & embedding script
│   └── requirements.txt
├── docker-compose.yml             # Local Docker orchestration
└── README.md
```

---

## Step-by-Step Deployment Guide

### 1. Database Setup (Supabase)
1. Go to your [Supabase SQL Editor](https://tormcjsptsstcmsaebsl.supabase.co).
2. Copy and execute [`supabase/schema.sql`](file:///g:/Tuna%20Ai%20Medical%20Assistant/supabase/schema.sql).
3. This creates all tables (`users`, `credit_transactions`, `payment_orders`, `medical_knowledge`, `chat_logs`) and atomic stored procedures (`deduct_credit`, `increment_user_credits`, `match_medical_knowledge`).

---

### 2. Deploying to Vercel (Admin Portal & Billing Webhooks)

Deploying to Vercel takes 1 minute:

1. Install the Vercel CLI (or connect the GitHub repository on [vercel.com](https://vercel.com)):
   ```bash
   npm i -g vercel
   vercel --prod
   ```
2. In your **Vercel Project Settings > Environment Variables**, add:
   * `SUPABASE_URL`: `https://tormcjsptsstcmsaebsl.supabase.co`
   * `SUPABASE_SERVICE_ROLE_KEY`: `sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV`
   * `GROQ_API_KEY`: Your Groq API key from [console.groq.com](https://console.groq.com)
   * `GROQ_TEXT_MODEL`: `llama-3.3-70b-versatile`
   * `GROQ_VISION_MODEL`: `llama-3.2-11b-vision-preview`
   * `PESAPAL_CONSUMER_KEY`: Your PesaPal Consumer Key
   * `PESAPAL_CONSUMER_SECRET`: Your PesaPal Consumer Secret
   * `PESAPAL_ENV`: `sandbox` (or `live`)
   * `PESAPAL_IPN_ID`: Your registered PesaPal IPN notification UUID
   * `WHATSAPP_WORKER_URL`: The public Railway URL of your WhatsApp worker (e.g. `https://your-whatsapp-worker.up.railway.app`)
   * `INTERNAL_GATEWAY_SECRET`: `tuna-ai-uganda-secret-2026`

3. Your Vercel deployment will be live:
   * **Admin Portal & Dashboard:** `https://your-tuna-app.vercel.app/admin`
   * **PesaPal IPN Webhook URL:** `https://your-tuna-app.vercel.app/api/pesapal-ipn`
   * **Clinical Query Endpoint:** `https://your-tuna-app.vercel.app/api/query`
   * **Diagnostic Lab Vision Endpoint:** `https://your-tuna-app.vercel.app/api/interpret-lab`

---

### 3. Deploying the WhatsApp Worker to Railway

Because WhatsApp requires an open, 24/7 WebSocket stream and a persistent volume for session caching, deploy the WhatsApp Gateway on Railway:

1. Create a new service on Railway connected to your GitHub repo.
2. Set the **Root Directory** to `/whatsapp_gateway`.
3. Add a **Volume Mount** at `/data` under service settings to cache your WhatsApp session!
4. Set Environment Variables:
   ```env
   SUPABASE_URL=https://tormcjsptsstcmsaebsl.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV
   CORE_API_URL=https://your-tuna-app.vercel.app
   INTERNAL_GATEWAY_SECRET=tuna-ai-uganda-secret-2026
   SESSION_PATH=/data/tuna_session
   PHONE_NUMBER_FOR_PAIRING=256701234567
   ```
5. Check Railway logs for the **8-digit Pairing Code**:
   ```
   ======================================================
     TUNA AI WHATSAPP PAIRING CODE: [ 89AB-CDEF ]
     Enter this code on your WhatsApp mobile device.
   ======================================================
   ```
6. On WhatsApp on your phone: Go to **Settings > Linked Devices > Link with phone number instead**, and type the code.

---

### 4. PesaPal v3 Webhook Registration
In your PesaPal merchant portal:
- Set IPN Notification URL to your Vercel endpoint:
  `https://your-tuna-app.vercel.app/api/pesapal-ipn`
- Copy the returned IPN ID and set it as `PESAPAL_IPN_ID` on Vercel.

---

## Git Repository Sync

To push the latest Vercel setup to your GitHub repository:

```bash
git add .
git commit -m "feat: add Vercel serverless API routes, PesaPal webhook, and Admin Portal"
git push -u origin main
```
