-- ============================================================
-- PIPEPED — Banco de Dados Completo
-- Sistema de Gestão Operacional · Grupo PED
-- PostgreSQL 16
-- ============================================================

-- Extensões
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── ENUM TYPES ──────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('admin', 'gestor', 'colaborador');
CREATE TYPE priority_level AS ENUM ('baixa', 'media', 'alta', 'urgente');
CREATE TYPE approval_status AS ENUM ('pendente', 'aprovado', 'rejeitado');
CREATE TYPE notification_type AS ENUM ('card_criado', 'card_movido', 'comentario', 'aprovacao', 'alerta_prazo', 'sistema');
CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete', 'move', 'approve', 'reject', 'login', 'comment');

-- ─── SCHOOLS (ESCOLAS) ──────────────────────────────────────

CREATE TABLE schools (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(120) NOT NULL,
    short_name  VARCHAR(30)  NOT NULL,
    cnpj        VARCHAR(18)  UNIQUE,
    address     TEXT,
    phone       VARCHAR(20),
    email       VARCHAR(120),
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── DEPARTMENTS (SETORES) ──────────────────────────────────

CREATE TABLE departments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(80) NOT NULL UNIQUE,
    description TEXT,
    color       VARCHAR(7),          -- hex color (#3B82F6)
    icon        VARCHAR(40),          -- nome do ícone
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── USERS ──────────────────────────────────────────────────

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(120) NOT NULL,
    email           VARCHAR(160) NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            user_role NOT NULL DEFAULT 'colaborador',
    department_id   UUID REFERENCES departments(id) ON DELETE SET NULL,
    school_id       UUID REFERENCES schools(id) ON DELETE SET NULL,
    avatar_url      TEXT,
    phone           VARCHAR(20),
    active          BOOLEAN NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── MODULES ────────────────────────────────────────────────

CREATE TABLE modules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            VARCHAR(40) NOT NULL UNIQUE,    -- compras, ti, comercial, contratos
    name            VARCHAR(80) NOT NULL,
    description     TEXT,
    color           VARCHAR(7),
    color_light     VARCHAR(7),
    has_financial   BOOLEAN NOT NULL DEFAULT false,
    display_order   INT NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── PHASES / STATUS ────────────────────────────────────────

CREATE TABLE phases (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module_id   UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    slug        VARCHAR(60) NOT NULL,
    name        VARCHAR(80) NOT NULL,
    color       VARCHAR(7),
    bg_color    VARCHAR(7),
    sla_days    INT,                    -- alerta SLA em dias
    is_final    BOOLEAN NOT NULL DEFAULT false,
    position    INT NOT NULL DEFAULT 0, -- ordem na coluna
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(module_id, slug)
);

-- ─── CATEGORIES ─────────────────────────────────────────────

CREATE TABLE categories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module_id   UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    name        VARCHAR(80) NOT NULL,
    position    INT NOT NULL DEFAULT 0,
    UNIQUE(module_id, name)
);

-- ─── TASKS (CARDS) ──────────────────────────────────────────

CREATE TABLE tasks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module_id       UUID NOT NULL REFERENCES modules(id),
    phase_id        UUID NOT NULL REFERENCES phases(id),
    category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
    school_id       UUID REFERENCES schools(id) ON DELETE SET NULL,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    priority        priority_level NOT NULL DEFAULT 'media',
    assignee_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by      UUID NOT NULL REFERENCES users(id),
    due_date        DATE,
    completed_at    TIMESTAMPTZ,
    position        INT NOT NULL DEFAULT 0,     -- ordem dentro da coluna
    -- Campos financeiros (módulo compras)
    amount          DECIMAL(12,2),
    supplier        VARCHAR(160),
    document_number VARCHAR(60),
    payment_due     DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── COMMENTS ───────────────────────────────────────────────

CREATE TABLE comments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── ATTACHMENTS ────────────────────────────────────────────

CREATE TABLE attachments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    file_name       VARCHAR(255) NOT NULL,
    file_url        TEXT NOT NULL,
    file_size       BIGINT,              -- bytes
    mime_type       VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── WORKFLOWS (REGRAS DE APROVAÇÃO) ────────────────────────

CREATE TABLE workflows (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module_id   UUID NOT NULL REFERENCES modules(id),
    name        VARCHAR(120) NOT NULL,
    description TEXT,
    trigger_phase_id   UUID REFERENCES phases(id),   -- fase que dispara
    target_phase_id    UUID REFERENCES phases(id),    -- fase destino após aprovação
    reject_phase_id    UUID REFERENCES phases(id),    -- fase destino se rejeitado
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── WORKFLOW STEPS (NÍVEIS DE APROVAÇÃO) ────────────────────

CREATE TABLE workflow_steps (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    step_order      INT NOT NULL,
    approver_role   user_role,                          -- qual perfil pode aprovar
    approver_id     UUID REFERENCES users(id),          -- ou um usuário específico
    department_id   UUID REFERENCES departments(id),    -- ou qualquer um do setor
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workflow_id, step_order)
);

-- ─── APPROVALS ──────────────────────────────────────────────

CREATE TABLE approvals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    workflow_step_id UUID NOT NULL REFERENCES workflow_steps(id),
    approver_id     UUID REFERENCES users(id),
    status          approval_status NOT NULL DEFAULT 'pendente',
    notes           TEXT,
    decided_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── NOTIFICATIONS ──────────────────────────────────────────

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        notification_type NOT NULL DEFAULT 'sistema',
    title       VARCHAR(200) NOT NULL,
    body        TEXT,
    task_id     UUID REFERENCES tasks(id) ON DELETE CASCADE,
    read        BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── AUDIT LOG ──────────────────────────────────────────────

CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    action      audit_action NOT NULL,
    entity_type VARCHAR(40) NOT NULL,        -- 'task', 'user', 'approval', etc.
    entity_id   UUID,
    details     JSONB,                       -- dados extras (old_value, new_value, etc.)
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── INDEXES ────────────────────────────────────────────────

-- Tasks
CREATE INDEX idx_tasks_module        ON tasks(module_id);
CREATE INDEX idx_tasks_phase         ON tasks(phase_id);
CREATE INDEX idx_tasks_assignee      ON tasks(assignee_id);
CREATE INDEX idx_tasks_school        ON tasks(school_id);
CREATE INDEX idx_tasks_created_by    ON tasks(created_by);
CREATE INDEX idx_tasks_due_date      ON tasks(due_date);
CREATE INDEX idx_tasks_priority      ON tasks(priority);
CREATE INDEX idx_tasks_created_at    ON tasks(created_at DESC);

-- Comments
CREATE INDEX idx_comments_task       ON comments(task_id);
CREATE INDEX idx_comments_created    ON comments(created_at DESC);

-- Attachments
CREATE INDEX idx_attachments_task    ON attachments(task_id);

-- Approvals
CREATE INDEX idx_approvals_task      ON approvals(task_id);
CREATE INDEX idx_approvals_status    ON approvals(status);

-- Notifications
CREATE INDEX idx_notif_user          ON notifications(user_id);
CREATE INDEX idx_notif_unread        ON notifications(user_id, read) WHERE read = false;
CREATE INDEX idx_notif_created       ON notifications(created_at DESC);

-- Audit
CREATE INDEX idx_audit_user          ON audit_log(user_id);
CREATE INDEX idx_audit_entity        ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_action        ON audit_log(action);
CREATE INDEX idx_audit_created       ON audit_log(created_at DESC);

-- Users
CREATE INDEX idx_users_dept          ON users(department_id);
CREATE INDEX idx_users_school        ON users(school_id);
CREATE INDEX idx_users_role          ON users(role);
CREATE INDEX idx_users_email         ON users(email);

-- Phases
CREATE INDEX idx_phases_module       ON phases(module_id);

-- ─── TRIGGER: updated_at AUTOMÁTICO ─────────────────────────

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_tasks_updated    BEFORE UPDATE ON tasks    FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_comments_updated BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_schools_updated  BEFORE UPDATE ON schools  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ─── SEED: ESCOLAS ──────────────────────────────────────────

INSERT INTO schools (id, name, short_name, cnpj, address, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'PED 1 — Centro',  'PED 1', '12.345.678/0001-01', 'Rua Centro, 100 — Salvador/BA',  'ped1@grupoped.com.br'),
  ('a0000000-0000-0000-0000-000000000002', 'PED 2 — Norte',   'PED 2', '12.345.678/0002-02', 'Av. Norte, 200 — Salvador/BA',    'ped2@grupoped.com.br'),
  ('a0000000-0000-0000-0000-000000000003', 'PED 3 — Sul',     'PED 3', '12.345.678/0003-03', 'Rua Sul, 300 — Salvador/BA',      'ped3@grupoped.com.br');

-- ─── SEED: DEPARTAMENTOS ────────────────────────────────────

INSERT INTO departments (id, name, description, color) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'Diretoria',     'Direção geral do Grupo PED',       '#6366F1'),
  ('d0000000-0000-0000-0000-000000000002', 'Coordenação',   'Coordenação pedagógica e admin.',   '#10B981'),
  ('d0000000-0000-0000-0000-000000000003', 'TI',            'Tecnologia da Informação',          '#3B82F6'),
  ('d0000000-0000-0000-0000-000000000004', 'Comercial',     'Matrículas, leads e vendas',        '#F59E0B'),
  ('d0000000-0000-0000-0000-000000000005', 'Financeiro',    'Contas, pagamentos e contratos',    '#8B5CF6');

-- ─── SEED: USUÁRIOS ─────────────────────────────────────────
-- Senha padrão: "Ped@2026" (hash bcrypt)

INSERT INTO users (id, name, email, password_hash, role, department_id, school_id) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'Emerson Santos',  'emerson@grupoped.com.br', crypt('Ped@2026', gen_salt('bf')), 'admin',       'd0000000-0000-0000-0000-000000000001', NULL),
  ('b0000000-0000-0000-0000-000000000002', 'Ana Lima',        'ana@grupoped.com.br',     crypt('Ped@2026', gen_salt('bf')), 'gestor',      'd0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000003', 'Carlos Melo',     'carlos@grupoped.com.br',  crypt('Ped@2026', gen_salt('bf')), 'colaborador', 'd0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000004', 'Beatriz Souza',   'bea@grupoped.com.br',     crypt('Ped@2026', gen_salt('bf')), 'colaborador', 'd0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000005', 'Ricardo Nunes',   'ric@grupoped.com.br',     crypt('Ped@2026', gen_salt('bf')), 'gestor',      'd0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000002');

-- ─── SEED: MÓDULOS ──────────────────────────────────────────

INSERT INTO modules (id, slug, name, description, color, color_light, has_financial, display_order) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'compras',    'Compras',         'Solicitações e aprovações de compras',    '#F59E0B', '#FFFBEB', true,  1),
  ('c0000000-0000-0000-0000-000000000002', 'ti',         'TI — Chamados',   'Chamados técnicos e suporte',             '#3B82F6', '#EFF6FF', false, 2),
  ('c0000000-0000-0000-0000-000000000003', 'comercial',  'Comercial',       'Leads, matrículas e pipeline comercial',  '#10B981', '#ECFDF5', false, 3),
  ('c0000000-0000-0000-0000-000000000004', 'contratos',  'Contratos',       'Gestão e controle de contratos',          '#8B5CF6', '#F5F3FF', false, 4);

-- ─── SEED: FASES ────────────────────────────────────────────

-- Compras
INSERT INTO phases (module_id, slug, name, color, bg_color, is_final, position) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'solicitado',  'Solicitado',  '#94A3B8', '#F1F5F9', false, 1),
  ('c0000000-0000-0000-0000-000000000001', 'em_analise',  'Em Análise',  '#F59E0B', '#FFFBEB', false, 2),
  ('c0000000-0000-0000-0000-000000000001', 'aprovado',    'Aprovado',    '#3B82F6', '#EFF6FF', false, 3),
  ('c0000000-0000-0000-0000-000000000001', 'comprado',    'Comprado',    '#8B5CF6', '#F5F3FF', false, 4),
  ('c0000000-0000-0000-0000-000000000001', 'entregue',    'Entregue',    '#10B981', '#ECFDF5', true,  5);

-- TI
INSERT INTO phases (module_id, slug, name, color, bg_color, is_final, position) VALUES
  ('c0000000-0000-0000-0000-000000000002', 'aberto',          'Aberto',          '#94A3B8', '#F1F5F9', false, 1),
  ('c0000000-0000-0000-0000-000000000002', 'em_atendimento',  'Em Atendimento',  '#3B82F6', '#EFF6FF', false, 2),
  ('c0000000-0000-0000-0000-000000000002', 'aguardando',      'Aguardando',      '#F59E0B', '#FFFBEB', false, 3),
  ('c0000000-0000-0000-0000-000000000002', 'resolvido',       'Resolvido',       '#10B981', '#ECFDF5', false, 4),
  ('c0000000-0000-0000-0000-000000000002', 'fechado',         'Fechado',         '#64748B', '#F8FAFC', true,  5);

-- Comercial
INSERT INTO phases (module_id, slug, name, color, bg_color, is_final, position) VALUES
  ('c0000000-0000-0000-0000-000000000003', 'lead',         'Lead',            '#94A3B8', '#F1F5F9', false, 1),
  ('c0000000-0000-0000-0000-000000000003', 'contato',      'Contato Feito',   '#3B82F6', '#EFF6FF', false, 2),
  ('c0000000-0000-0000-0000-000000000003', 'visita',       'Visita Agendada', '#8B5CF6', '#F5F3FF', false, 3),
  ('c0000000-0000-0000-0000-000000000003', 'proposta',     'Proposta Enviada','#F59E0B', '#FFFBEB', false, 4),
  ('c0000000-0000-0000-0000-000000000003', 'matriculado',  'Matriculado',     '#10B981', '#ECFDF5', true,  5),
  ('c0000000-0000-0000-0000-000000000003', 'perdido',      'Perdido',         '#EF4444', '#FEF2F2', false, 6);

-- Contratos
INSERT INTO phases (module_id, slug, name, color, bg_color, is_final, position) VALUES
  ('c0000000-0000-0000-0000-000000000004', 'rascunho',    'Rascunho',        '#94A3B8', '#F1F5F9', false, 1),
  ('c0000000-0000-0000-0000-000000000004', 'revisao',     'Em Revisão',      '#F59E0B', '#FFFBEB', false, 2),
  ('c0000000-0000-0000-0000-000000000004', 'aprovado',    'Aprovado',        '#3B82F6', '#EFF6FF', false, 3),
  ('c0000000-0000-0000-0000-000000000004', 'assinatura',  'Ag. Assinatura',  '#8B5CF6', '#F5F3FF', false, 4),
  ('c0000000-0000-0000-0000-000000000004', 'assinado',    'Assinado',        '#10B981', '#ECFDF5', true,  5),
  ('c0000000-0000-0000-0000-000000000004', 'vencendo',    'Vencendo',        '#EF4444', '#FEF2F2', false, 6);

-- ─── SEED: CATEGORIAS ───────────────────────────────────────

-- Compras
INSERT INTO categories (module_id, name, position) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Material de Escritório', 1),
  ('c0000000-0000-0000-0000-000000000001', 'Equipamentos',          2),
  ('c0000000-0000-0000-0000-000000000001', 'Serviços',              3),
  ('c0000000-0000-0000-0000-000000000001', 'Manutenção',            4),
  ('c0000000-0000-0000-0000-000000000001', 'Alimentação',           5),
  ('c0000000-0000-0000-0000-000000000001', 'Uniforme',              6),
  ('c0000000-0000-0000-0000-000000000001', 'Outros',                7);

-- TI
INSERT INTO categories (module_id, name, position) VALUES
  ('c0000000-0000-0000-0000-000000000002', 'Hardware',     1),
  ('c0000000-0000-0000-0000-000000000002', 'Software',     2),
  ('c0000000-0000-0000-0000-000000000002', 'Rede',         3),
  ('c0000000-0000-0000-0000-000000000002', 'Impressora',   4),
  ('c0000000-0000-0000-0000-000000000002', 'Telefonia',    5),
  ('c0000000-0000-0000-0000-000000000002', 'Câmeras',      6),
  ('c0000000-0000-0000-0000-000000000002', 'Outros',       7);

-- Comercial
INSERT INTO categories (module_id, name, position) VALUES
  ('c0000000-0000-0000-0000-000000000003', 'Maternal I',     1),
  ('c0000000-0000-0000-0000-000000000003', 'Maternal II',    2),
  ('c0000000-0000-0000-0000-000000000003', 'Infantil I',     3),
  ('c0000000-0000-0000-0000-000000000003', 'Infantil II',    4),
  ('c0000000-0000-0000-0000-000000000003', 'Fund. I',        5),
  ('c0000000-0000-0000-0000-000000000003', 'Fund. II',       6),
  ('c0000000-0000-0000-0000-000000000003', 'Ensino Médio',   7);

-- Contratos
INSERT INTO categories (module_id, name, position) VALUES
  ('c0000000-0000-0000-0000-000000000004', 'Fornecedor',              1),
  ('c0000000-0000-0000-0000-000000000004', 'Prestador de Serviço',    2),
  ('c0000000-0000-0000-0000-000000000004', 'Locação',                 3),
  ('c0000000-0000-0000-0000-000000000004', 'Parceria',                4),
  ('c0000000-0000-0000-0000-000000000004', 'Franquia',                5),
  ('c0000000-0000-0000-0000-000000000004', 'Outros',                  6);

-- ─── SEED: WORKFLOW DE EXEMPLO (COMPRAS) ─────────────────────

INSERT INTO workflows (id, module_id, name, description) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Aprovação de Compras', 'Fluxo padrão: Coordenação → Financeiro → Diretoria');

INSERT INTO workflow_steps (workflow_id, step_order, approver_role, department_id) VALUES
  ('e0000000-0000-0000-0000-000000000001', 1, 'gestor',  'd0000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000001', 2, 'gestor',  'd0000000-0000-0000-0000-000000000005'),
  ('e0000000-0000-0000-0000-000000000001', 3, 'admin',   'd0000000-0000-0000-0000-000000000001');

-- ─── FIM ────────────────────────────────────────────────────
-- Tabelas criadas: 14
-- Indexes criados: 18
-- Triggers: 4
-- Enums: 6
-- Seeds: escolas, departamentos, usuários, módulos, fases, categorias, workflow
-- ============================================================
