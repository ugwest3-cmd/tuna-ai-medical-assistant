import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "Tuna AI Medical Assistant - Uganda Clinical Core Engine"
    PORT: int = int(os.getenv("PORT", 8000))
    
    # Target Scope
    TARGET_COUNTRY: str = "Uganda"
    PRIMARY_CLINICAL_GUIDELINE: str = "Uganda Clinical Guidelines (UCG)"
    
    # Supabase Configuration
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "https://tormcjsptsstcmsaebsl.supabase.co")
    SUPABASE_SERVICE_ROLE_KEY: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV")
    
    # Internal Communication Security
    INTERNAL_GATEWAY_SECRET: str = os.getenv("INTERNAL_GATEWAY_SECRET", "tuna-ai-uganda-secret-2026")
    ADMIN_SECRET: str = os.getenv("ADMIN_SECRET", "tuna-admin-uganda-pass")
    
    # Groq AI Configuration
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    GROQ_API_BASE_URL: str = os.getenv("GROQ_API_BASE_URL", "https://api.groq.com/openai/v1")
    GROQ_TEXT_MODEL: str = os.getenv("GROQ_TEXT_MODEL", "llama-3.3-70b-versatile")
    GROQ_VISION_MODEL: str = os.getenv("GROQ_VISION_MODEL", "llama-3.2-11b-vision-preview")
    
    # Embedding Model (1024 pgvector dimensions)
    EMBEDDING_MODEL_NAME: str = os.getenv("EMBEDDING_MODEL_NAME", "BAAI/bge-large-en-v1.5")
    
    # PesaPal v3 Configuration (UGX)
    PESAPAL_CONSUMER_KEY: str = os.getenv("PESAPAL_CONSUMER_KEY", "")
    PESAPAL_CONSUMER_SECRET: str = os.getenv("PESAPAL_CONSUMER_SECRET", "")
    PESAPAL_ENV: str = os.getenv("PESAPAL_ENV", "sandbox") # 'sandbox' or 'live'
    PESAPAL_IPN_ID: str = os.getenv("PESAPAL_IPN_ID", "")
    
    # WhatsApp Worker Webhook Callback
    WHATSAPP_WORKER_URL: str = os.getenv("WHATSAPP_WORKER_URL", "http://whatsapp-gateway:8080")

    @property
    def pesapal_base_url(self) -> str:
        if self.PESAPAL_ENV.lower() == "live":
            return "https://pay.pesapal.com/v3"
        return "https://cybqa.pesapal.com/pesapalv3"

settings = Settings()
