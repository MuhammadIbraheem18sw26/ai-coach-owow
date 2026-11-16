-- Enable pgvector extension for LangChain PGVector (1536-dimensional embeddings).
-- Relational tables (users, trusted_sessions, exercises, commitments, private_chats, scenarios)
-- are automatically created and seeded by NestJS TypeORM (synchronize: true),
-- and vector tables (langchain_pg_collection, langchain_pg_embedding) are managed by LangChain PGVector.
CREATE EXTENSION IF NOT EXISTS vector;
