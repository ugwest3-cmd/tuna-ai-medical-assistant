-- =====================================================================
-- Tuna AI Medical Assistant - Supabase Production Schema & Functions
-- =====================================================================

-- 1. Enable Required Extensions
create extension if not exists vector;
create extension if not exists "uuid-ossp";

-- 2. Enumerated Status & Transaction Types
create type account_status as enum ('active', 'suspended', 'trial');
create type transaction_type as enum ('purchase', 'usage_deduction', 'admin_grant', 'trial_grant');
create type payment_status as enum ('PENDING', 'COMPLETED', 'FAILED');

-- 3. Users Table
create table if not exists users (
    id uuid default gen_random_uuid() primary key,
    whatsapp_id varchar(50) unique not null,
    credit_balance int default 20 not null check (credit_balance >= 0),
    status account_status default 'trial' not null,
    created_at timestamp with time zone default current_timestamp not null,
    updated_at timestamp with time zone default current_timestamp not null
);

-- 4. Credit Transactions (Financial & Usage Ledger)
create table if not exists credit_transactions (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references users(id) on delete cascade not null,
    amount int not null,
    tx_type transaction_type not null,
    notes text,
    timestamp timestamp with time zone default current_timestamp not null
);

-- 5. Payment Orders Table (PesaPal v3 Integration)
create table if not exists payment_orders (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references users(id) on delete cascade not null,
    pesapal_order_tracking_id varchar(100) unique,
    merchant_reference varchar(100) unique not null,
    amount_paid numeric(10, 2) not null,
    currency varchar(10) default 'UGX' not null,
    credits_to_grant int not null,
    status payment_status default 'PENDING' not null,
    raw_ipn_response jsonb,
    created_at timestamp with time zone default current_timestamp not null,
    updated_at timestamp with time zone default current_timestamp not null
);

-- 6. Unified Vector Medical Knowledge Base
create table if not exists medical_knowledge (
    id uuid default gen_random_uuid() primary key,
    document_title text not null,
    edition text,
    chapter text,
    page_number int,
    content text not null,
    token_count int,
    embedding vector(1024) -- Standard dimension for BAAI/bge-large-en-v1.5
);

-- 7. Clinical Chat & Audit Logs
create table if not exists chat_logs (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references users(id) on delete cascade not null,
    incoming_message text not null,
    ai_response text not null,
    cited_sources jsonb,
    tokens_used int,
    latency_ms int,
    created_at timestamp with time zone default current_timestamp not null
);

-- 8. Indexes for Query Performance
create index if not exists idx_users_wa on users(whatsapp_id);
create index if not exists idx_orders_ref on payment_orders(merchant_reference);
create index if not exists idx_orders_tracking on payment_orders(pesapal_order_tracking_id);
create index if not exists idx_medical_knowledge_embedding on medical_knowledge 
using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- =====================================================================
-- 9. RPC FUNCTION: Atomic Credit Deduction (Row-Level Lock)
-- =====================================================================
create or replace function deduct_credit(p_user_id uuid, p_amount int default 1)
returns boolean
language plpgsql
security definer
as $$
declare
    current_credits int;
begin
    -- Lock user record to prevent race conditions during concurrent queries
    select credit_balance into current_credits
    from users
    where id = p_user_id
    for update;

    if current_credits is null or current_credits < p_amount then
        return false;
    end if;

    update users
    set credit_balance = credit_balance - p_amount,
        updated_at = current_timestamp
    where id = p_user_id;

    insert into credit_transactions(user_id, amount, tx_type, notes)
    values (p_user_id, -p_amount, 'usage_deduction', 'Clinical inquiry usage');

    return true;
end;
$$;

-- =====================================================================
-- 10. RPC FUNCTION: Atomic Credit Top-Up (Post Payment Confirmation)
-- =====================================================================
create or replace function increment_user_credits(user_uuid uuid, amount_to_add int)
returns void
language plpgsql
security definer
as $$
begin
    update users
    set credit_balance = credit_balance + amount_to_add,
        status = 'active',
        updated_at = current_timestamp
    where id = user_uuid;
end;
$$;

-- =====================================================================
-- 11. RPC FUNCTION: Cosine Similarity Vector Search
-- =====================================================================
create or replace function match_medical_knowledge(
    query_embedding vector(1024),
    match_threshold float default 0.65,
    match_count int default 4
)
returns table (
    id uuid,
    document_title text,
    page_number int,
    content text,
    similarity float
)
language plpgsql
stable
as $$
begin
    return query
    select
        mk.id,
        mk.document_title,
        mk.page_number,
        mk.content,
        1 - (mk.embedding <=> query_embedding) as similarity
    from medical_knowledge mk
    where 1 - (mk.embedding <=> query_embedding) > match_threshold
    order by mk.embedding <=> query_embedding
    limit match_count;
end;
$$;
