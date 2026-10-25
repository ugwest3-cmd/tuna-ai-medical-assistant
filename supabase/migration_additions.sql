-- =====================================================================
-- Migration Script: Apply New Features to Existing Supabase Database
-- Run this in the Supabase SQL Editor if you already have tables created.
-- =====================================================================

-- 1. Add Onboarding & Role Columns to Users Table
alter table users 
add column if not exists name varchar(120),
add column if not exists profession varchar(100),
add column if not exists role varchar(20) default 'professional' check (role in ('professional', 'student')),
add column if not exists practicing_number varchar(100),
add column if not exists onboarding_step int default 4 not null,
add column if not exists onboarding_complete boolean default true not null;

-- 2. Add doc_type to Medical Knowledge Base (Separates Professional from Student)
alter table medical_knowledge
add column if not exists doc_type varchar(20) default 'professional' not null check (doc_type in ('professional', 'student'));

-- 3. Create Cases Table
create table if not exists cases (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references users(id) on delete cascade not null,
    case_ref varchar(30) unique not null,
    title text,
    status varchar(20) default 'open' not null,
    created_at timestamp with time zone default current_timestamp not null,
    last_updated_at timestamp with time zone default current_timestamp not null
);

-- 4. Create Case Messages Table (with 3-day Auto-Deletion TTL)
create table if not exists case_messages (
    id uuid default gen_random_uuid() primary key,
    case_id uuid references cases(id) on delete cascade not null,
    user_id uuid references users(id) on delete cascade not null,
    direction varchar(10) not null check (direction in ('inbound', 'outbound')),
    content text not null,
    created_at timestamp with time zone default current_timestamp not null,
    expires_at timestamp with time zone default (current_timestamp + interval '3 days') not null
);

-- 5. Add expires_at to chat_logs if not present
alter table chat_logs
add column if not exists expires_at timestamp with time zone default (current_timestamp + interval '3 days') not null;

-- 6. Indexes for Performance
create index if not exists idx_users_onboarding on users(onboarding_complete);
create index if not exists idx_users_role on users(role);
create index if not exists idx_cases_user on cases(user_id);
create index if not exists idx_cases_ref on cases(case_ref);
create index if not exists idx_case_messages_case on case_messages(case_id);
create index if not exists idx_case_messages_expires on case_messages(expires_at);
create index if not exists idx_chat_logs_expires on chat_logs(expires_at);
create index if not exists idx_medical_knowledge_type on medical_knowledge(doc_type);

-- 7. Role-Filtered Cosine Similarity Search Function
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

-- 8. Auto-Delete Function (3-Day Purge)
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
