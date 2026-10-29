"""
PesaPal v3 Integration Service: Authentication, Order Generation, and IPN Webhook Processing.
"""
import uuid
import httpx
from typing import Dict, Any, Optional
from datetime import datetime, timedelta
from supabase import create_client, Client

from config import settings

TIER_PRICING = {
    "10": {"credits": 10, "amount": 2000.0, "desc": "10 Patient Cases (2,000 UGX)"},
    "50": {"credits": 50, "amount": 5000.0, "desc": "50 Patient Cases (5,000 UGX)"},
    "100": {"credits": 100, "amount": 10000.0, "desc": "100 Patient Cases (10,000 UGX)"},
    "300": {"credits": 300, "amount": 25000.0, "desc": "300 Patient Cases (25,000 UGX)"},
    "1000": {"credits": 1000, "amount": 70000.0, "desc": "1,000 Patient Cases (70,000 UGX)"},
    # Backwards compatibility
    "1": {"credits": 100, "amount": 10000.0, "desc": "100 Patient Cases (10,000 UGX)"},
    "2": {"credits": 300, "amount": 25000.0, "desc": "300 Patient Cases (25,000 UGX)"},
    "3": {"credits": 1000, "amount": 70000.0, "desc": "1,000 Patient Cases (70,000 UGX)"}
}

class PesaPalService:
    def __init__(self):
        self.supabase: Client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY
        )
        self._token: Optional[str] = None
        self._token_expiry: Optional[datetime] = None

    async def get_auth_token(self) -> str:
        """
        Retrieves or returns cached PesaPal v3 Bearer token.
        """
        if self._token and self._token_expiry and datetime.utcnow() < self._token_expiry:
            return self._token

        url = f"{settings.pesapal_base_url}/api/Auth/RequestToken"
        payload = {
            "consumer_key": settings.PESAPAL_CONSUMER_KEY,
            "consumer_secret": settings.PESAPAL_CONSUMER_SECRET
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=payload, headers={"Content-Type": "application/json"})
            if resp.status_code != 200:
                raise RuntimeError(f"PesaPal auth token request failed: {resp.text}")
            data = resp.json()
            self._token = data.get("token")
            # Cache token for 4 minutes (standard expiry is 5 minutes)
            self._token_expiry = datetime.utcnow() + timedelta(minutes=4)
            return self._token

    async def create_payment_order(self, user_id: str, phone: str, package_tier: str) -> Dict[str, Any]:
        """
        Registers a payment order in Supabase and requests a checkout redirect URL from PesaPal v3.
        """
        tier = TIER_PRICING.get(package_tier)
        if not tier:
            raise ValueError(f"Invalid package tier: {package_tier}")

        merchant_ref = f"TUNA-{uuid.uuid4().hex[:12].upper()}"
        token = await self.get_auth_token()

        url = f"{settings.pesapal_base_url}/api/Transactions/SubmitOrderRequest"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        # Format phone number for PesaPal
        clean_phone = phone.replace("@s.whatsapp.net", "").replace("+", "").strip()

        order_payload = {
            "id": merchant_ref,
            "currency": "UGX",
            "amount": tier["amount"],
            "description": f"Tuna AI {tier['desc']}",
            "callback_url": f"{settings.pesapal_base_url}/callback", # User browser redirect after completion
            "notification_id": settings.PESAPAL_IPN_ID,
            "billing_address": {
                "phone_number": clean_phone,
                "email_address": f"{clean_phone}@tuna.ai",
                "country_code": "UG",
                "first_name": "Tuna",
                "last_name": "Doctor"
            }
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, headers=headers, json=order_payload)
            if resp.status_code != 200:
                raise RuntimeError(f"PesaPal SubmitOrderRequest failed: {resp.text}")
            data = resp.json()

        order_tracking_id = data.get("order_tracking_id")
        redirect_url = data.get("redirect_url")

        # Save order record in Supabase
        self.supabase.table("payment_orders").insert({
            "user_id": user_id,
            "pesapal_order_tracking_id": order_tracking_id,
            "merchant_reference": merchant_ref,
            "amount_paid": tier["amount"],
            "currency": "UGX",
            "credits_to_grant": tier["credits"],
            "status": "PENDING"
        }).execute()

        return {
            "merchant_reference": merchant_ref,
            "order_tracking_id": order_tracking_id,
            "redirect_url": redirect_url
        }

    async def process_ipn(self, order_tracking_id: str, merchant_ref: str) -> Dict[str, Any]:
        """
        Validates IPN notification callback and completes credit fulfillment atomically.
        """
        token = await self.get_auth_token()
        status_url = f"{settings.pesapal_base_url}/api/Transactions/GetTransactionStatus?orderTrackingId={order_tracking_id}"
        headers = {"Authorization": f"Bearer {token}"}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(status_url, headers=headers)
            if resp.status_code != 200:
                raise RuntimeError(f"PesaPal GetTransactionStatus failed: {resp.text}")
            tx_data = resp.json()

        payment_status_desc = tx_data.get("payment_status_description", "").upper()

        if payment_status_desc == "COMPLETED":
            # Lookup order in Supabase
            order_res = self.supabase.table("payment_orders").select("*").eq("merchant_reference", merchant_ref).single().execute()
            order = order_res.data

            if order and order.get("status") == "PENDING":
                user_id = order["user_id"]
                credits = order["credits_to_grant"]

                # 1. Update order status
                self.supabase.table("payment_orders").update({
                    "status": "COMPLETED",
                    "raw_ipn_response": tx_data
                }).eq("id", order["id"]).execute()

                # 2. Increment credits atomically using Supabase RPC
                self.supabase.rpc("increment_user_credits", {
                    "user_uuid": user_id,
                    "amount_to_add": credits
                }).execute()

                # 3. Log into financial credit transaction ledger
                self.supabase.table("credit_transactions").insert({
                    "user_id": user_id,
                    "amount": credits,
                    "tx_type": "purchase",
                    "notes": f"PesaPal Order {order_tracking_id}"
                }).execute()

                # 4. Notify WhatsApp Gateway to message the user
                user_record = self.supabase.table("users").select("whatsapp_id").eq("id", user_id).single().execute()
                if user_record.data:
                    wa_phone = user_record.data["whatsapp_id"]
                    try:
                        async with httpx.AsyncClient(timeout=10.0) as notify_client:
                            await notify_client.post(
                                f"{settings.WHATSAPP_WORKER_URL}/api/v1/internal/send-notification",
                                headers={"x-secret": settings.INTERNAL_GATEWAY_SECRET},
                                json={
                                    "whatsappId": wa_phone,
                                    "message": f"✅ *Payment Confirmed!* +{credits} clinical credits added to your Tuna AI balance."
                                }
                            )
                    except Exception as notify_err:
                        print(f"[PesaPal] WhatsApp notification delivery warning: {notify_err}")

                return {"status": "success", "action": "credits_granted", "credits": credits}

        return {"status": "unmodified", "payment_status": payment_status_desc}
