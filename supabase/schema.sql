-- =====================================================================
-- Tuna AI Medical Assistant - Supabase Production Schema & Functions
-- Uganda Healthcare Edition: Professionals & Medical Students
-- =====================================================================

-- 1. Enable Required Extensions
create extension if not exists vector;
create extension if not exists "uuid-ossp";

-- 2. Enumerated Status & Transaction Types
create type account_status as enum ('active', 'suspended', 'trial');
create type transaction_type as enum ('purchase', 'usage_deduction', 'admin_grant', 'trial_grant');
create type payment_status as enum ('PENDING', 'COMPLETED', 'FAILED');

-- 3. Users Table (Healthcare Professionals & Students)
create table if not exists users (
    id uuid default gen_random_uuid() primary key,
    whatsapp_id varchar(50) unique not null,
    name varchar(120),
    profession varchar(100),
    role varchar(20) default 'professional' check (role in ('professional', 'student')),
    practicing_number varchar(100), -- License / Registration Number or Student ID
    onboarding_step int default 0 not null, -- 0=new, 1=name, 2=profession, 3=practicing_number, 4=complete
    onboarding_complete boolean default false not null,
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

-- 6. Unified Vector Medical Knowledge Base (Separated by Doc Type)
create table if not exists medical_knowledge (
    id uuid default gen_random_uuid() primary key,
    document_title text not null,
    edition text,
    chapter text,
    page_number int,
    content text not null,
    token_count int,
    doc_type varchar(20) default 'professional' not null check (doc_type in ('professional', 'student')),
    embedding vector(1024) -- Standard dimension for BAAI/bge-large-en-v1.5
);

-- 7. Clinical Cases Table (Tracks patient presentations & longitudinal continuity)
create table if not exists cases (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references users(id) on delete cascade not null,
    case_ref varchar(30) unique not null, -- e.g. TUN-2026-00001
    title text,                           -- e.g. "Suspected Typhoid with Dehydration"
    status varchar(20) default 'open' not null, -- open, closed, referred
    created_at timestamp with time zone default current_timestamp not null,
    last_updated_at timestamp with time zone default current_timestamp not null
);

-- 8. Case Messages Table (Chat history with 2-3 Day Auto-Deletion TTL)
create table if not exists case_messages (
    id uuid default gen_random_uuid() primary key,
    case_id uuid references cases(id) on delete cascade not null,
    user_id uuid references users(id) on delete cascade not null,
    direction varchar(10) not null check (direction in ('inbound', 'outbound')),
    content text not null,
    created_at timestamp with time zone default current_timestamp not null,
    expires_at timestamp with time zone default (current_timestamp + interval '3 days') not null
);

-- 9. General Clinical Audit Logs (Auto-expires after 3 days)
create table if not exists chat_logs (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references users(id) on delete cascade not null,
    incoming_message text not null,
    ai_response text not null,
    cited_sources jsonb,
    tokens_used int,
    latency_ms int,
    created_at timestamp with time zone default current_timestamp not null,
    expires_at timestamp with time zone default (current_timestamp + interval '3 days') not null
);

-- 10. Indexes for Query Performance & Lifecycle Management
create index if not exists idx_users_wa on users(whatsapp_id);
create index if not exists idx_users_onboarding on users(onboarding_complete);
create index if not exists idx_users_role on users(role);
create index if not exists idx_cases_user on cases(user_id);
create index if not exists idx_cases_ref on cases(case_ref);
create index if not exists idx_case_messages_case on case_messages(case_id);
create index if not exists idx_case_messages_expires on case_messages(expires_at);
create index if not exists idx_chat_logs_expires on chat_logs(expires_at);
create index if not exists idx_orders_ref on payment_orders(merchant_reference);
create index if not exists idx_orders_tracking on payment_orders(pesapal_order_tracking_id);
create index if not exists idx_medical_knowledge_type on medical_knowledge(doc_type);
create index if not exists idx_medical_knowledge_embedding on medical_knowledge 
using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- =====================================================================
-- 11. RPC FUNCTION: Atomic Credit Deduction (Row-Level Lock)
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
-- 12. RPC FUNCTION: Atomic Credit Top-Up (Post Payment Confirmation)
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
-- 13. RPC FUNCTION: Cosine Similarity Vector Search (All or Default)
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

-- =====================================================================
-- 14. RPC FUNCTION: Role-Filtered Cosine Similarity Search (Professional vs Student)
-- =====================================================================
create or replace function match_medical_knowledge_by_type(
    query_embedding vector(1024),
    p_doc_type text,
    match_threshold float default 0.60,
    match_count int default 4
)
returns table (
    id uuid,
    document_title text,
    page_number int,
    content text,
    doc_type text,
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
        mk.doc_type::text,
        1 - (mk.embedding <=> query_embedding) as similarity
    from medical_knowledge mk
    where mk.doc_type = p_doc_type
      and 1 - (mk.embedding <=> query_embedding) > match_threshold
    order by mk.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- =====================================================================
-- 15. RPC FUNCTION: Auto-Delete Expired Chat History (2-3 Day Purge)
-- =====================================================================
create or replace function purge_expired_chat_history()
returns int
language plpgsql
security definer
as $$
declare
    deleted_messages int := 0;
    deleted_logs int := 0;
begin
    delete from case_messages where expires_at < current_timestamp;
    get diagnostics deleted_messages = row_count;

    delete from chat_logs where expires_at < current_timestamp;
    get diagnostics deleted_logs = row_count;

    return deleted_messages + deleted_logs;
end;
$$;

-- =====================================================================
-- 16. Automatic Daily Cron Schedule (Execute in Supabase SQL editor if pg_cron is enabled)
-- =====================================================================
-- select cron.schedule('tuna-daily-chat-purge', '0 3 * * *', $$SELECT purge_expired_chat_history();$$);
