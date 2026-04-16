/**
 * PIPEPED — Seed do banco de dados
 * Roda com: node seed.js
 */
'use strict';

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding PIPEPED database...');

  // ─── ESCOLAS ──────────────────────────────────────────────
  const ped1 = await prisma.school.upsert({
    where: { cnpj: '12.345.678/0001-01' },
    update: {},
    create: { name: 'PED 1 — Centro', shortName: 'PED 1', cnpj: '12.345.678/0001-01', address: 'Rua Centro, 100 — Salvador/BA', email: 'ped1@grupoped.com.br', phone: '(71) 3333-0001' },
  });
  const ped2 = await prisma.school.upsert({
    where: { cnpj: '12.345.678/0002-02' },
    update: {},
    create: { name: 'PED 2 — Norte', shortName: 'PED 2', cnpj: '12.345.678/0002-02', address: 'Av. Norte, 200 — Salvador/BA', email: 'ped2@grupoped.com.br', phone: '(71) 3333-0002' },
  });
  const ped3 = await prisma.school.upsert({
    where: { cnpj: '12.345.678/0003-03' },
    update: {},
    create: { name: 'PED 3 — Sul', shortName: 'PED 3', cnpj: '12.345.678/0003-03', address: 'Rua Sul, 300 — Salvador/BA', email: 'ped3@grupoped.com.br', phone: '(71) 3333-0003' },
  });
  console.log('✅ Escolas criadas');

  // ─── USUARIOS ─────────────────────────────────────────────
  const hash = await bcrypt.hash('Ped@2026', 12);

  await prisma.user.upsert({ where: { email: 'emerson@grupoped.com.br' }, update: {}, create: { name: 'Emerson Santos', email: 'emerson@grupoped.com.br', password: hash, role: 'ADMIN', schoolId: ped1.id } });
  await prisma.user.upsert({ where: { email: 'ana@grupoped.com.br' }, update: {}, create: { name: 'Ana Lima', email: 'ana@grupoped.com.br', password: hash, role: 'MANAGER', schoolId: ped1.id } });
  await prisma.user.upsert({ where: { email: 'carlos@grupoped.com.br' }, update: {}, create: { name: 'Carlos Melo', email: 'carlos@grupoped.com.br', password: hash, role: 'USER', schoolId: ped1.id } });
  await prisma.user.upsert({ where: { email: 'bea@grupoped.com.br' }, update: {}, create: { name: 'Beatriz Souza', email: 'bea@grupoped.com.br', password: hash, role: 'USER', schoolId: ped2.id } });
  await prisma.user.upsert({ where: { email: 'ric@grupoped.com.br' }, update: {}, create: { name: 'Ricardo Nunes', email: 'ric@grupoped.com.br', password: hash, role: 'MANAGER', schoolId: ped2.id } });
  console.log('✅ Usuarios criados');

  // ─── MODULOS ──────────────────────────────────────────────
  const compras = await prisma.module.upsert({ where: { slug: 'compras' }, update: {}, create: { slug: 'compras', name: 'Compras', description: 'Solicitacoes e aprovacoes de compras', color: '#F59E0B', colorLight: '#FFFBEB', hasFinancial: true, displayOrder: 1 } });
  const ti = await prisma.module.upsert({ where: { slug: 'ti' }, update: {}, create: { slug: 'ti', name: 'TI — Chamados', description: 'Chamados tecnicos e suporte', color: '#3B82F6', colorLight: '#EFF6FF', hasFinancial: false, displayOrder: 2 } });
  const comercial = await prisma.module.upsert({ where: { slug: 'comercial' }, update: {}, create: { slug: 'comercial', name: 'Comercial', description: 'Leads, matriculas e pipeline comercial', color: '#10B981', colorLight: '#ECFDF5', hasFinancial: false, displayOrder: 3 } });
  const financeiro = await prisma.module.upsert({ where: { slug: 'financeiro' }, update: {}, create: { slug: 'financeiro', name: 'Financeiro', description: 'Contas a pagar, receber e fluxo de caixa', color: '#EF4444', colorLight: '#FEF2F2', hasFinancial: true, displayOrder: 4 } });
  const contratos = await prisma.module.upsert({ where: { slug: 'contratos' }, update: {}, create: { slug: 'contratos', name: 'Contratos', description: 'Gestao e controle de contratos', color: '#8B5CF6', colorLight: '#F5F3FF', hasFinancial: false, displayOrder: 5 } });
  console.log('✅ Modulos criados');

  // ─── FASES ────────────────────────────────────────────────
  const faseSets = [
    { moduleId: compras.id, fases: [
      { slug: 'solicitado', name: 'Solicitado', color: '#94A3B8', bgColor: '#F1F5F9', isFinal: false, position: 1 },
      { slug: 'em_analise', name: 'Em Analise', color: '#F59E0B', bgColor: '#FFFBEB', isFinal: false, position: 2 },
      { slug: 'aprovado', name: 'Aprovado', color: '#3B82F6', bgColor: '#EFF6FF', isFinal: false, position: 3 },
      { slug: 'comprado', name: 'Comprado', color: '#8B5CF6', bgColor: '#F5F3FF', isFinal: false, position: 4 },
      { slug: 'entregue', name: 'Entregue', color: '#10B981', bgColor: '#ECFDF5', isFinal: true, position: 5 },
    ]},
    { moduleId: ti.id, fases: [
      { slug: 'aberto', name: 'Aberto', color: '#94A3B8', bgColor: '#F1F5F9', isFinal: false, position: 1 },
      { slug: 'em_atendimento', name: 'Em Atendimento', color: '#3B82F6', bgColor: '#EFF6FF', isFinal: false, position: 2 },
      { slug: 'aguardando', name: 'Aguardando', color: '#F59E0B', bgColor: '#FFFBEB', isFinal: false, position: 3 },
      { slug: 'resolvido', name: 'Resolvido', color: '#10B981', bgColor: '#ECFDF5', isFinal: false, position: 4 },
      { slug: 'fechado', name: 'Fechado', color: '#64748B', bgColor: '#F8FAFC', isFinal: true, position: 5 },
    ]},
    { moduleId: comercial.id, fases: [
      { slug: 'lead', name: 'Lead', color: '#94A3B8', bgColor: '#F1F5F9', isFinal: false, position: 1 },
      { slug: 'contato', name: 'Contato Feito', color: '#3B82F6', bgColor: '#EFF6FF', isFinal: false, position: 2 },
      { slug: 'visita', name: 'Visita Agendada', color: '#8B5CF6', bgColor: '#F5F3FF', isFinal: false, position: 3 },
      { slug: 'proposta', name: 'Proposta Enviada', color: '#F59E0B', bgColor: '#FFFBEB', isFinal: false, position: 4 },
      { slug: 'matriculado', name: 'Matriculado', color: '#10B981', bgColor: '#ECFDF5', isFinal: true, position: 5 },
      { slug: 'perdido', name: 'Perdido', color: '#EF4444', bgColor: '#FEF2F2', isFinal: false, position: 6 },
    ]},
    { moduleId: financeiro.id, fases: [
      { slug: 'pendente', name: 'Pendente', color: '#94A3B8', bgColor: '#F1F5F9', isFinal: false, position: 1 },
      { slug: 'a_vencer', name: 'A Vencer', color: '#F59E0B', bgColor: '#FFFBEB', isFinal: false, position: 2 },
      { slug: 'em_analise', name: 'Em Analise', color: '#3B82F6', bgColor: '#EFF6FF', isFinal: false, position: 3 },
      { slug: 'aprovado', name: 'Aprovado', color: '#8B5CF6', bgColor: '#F5F3FF', isFinal: false, position: 4 },
      { slug: 'pago', name: 'Pago', color: '#10B981', bgColor: '#ECFDF5', isFinal: true, position: 5 },
      { slug: 'vencido', name: 'Vencido', color: '#EF4444', bgColor: '#FEF2F2', isFinal: false, position: 6 },
    ]},
    { moduleId: contratos.id, fases: [
      { slug: 'rascunho', name: 'Rascunho', color: '#94A3B8', bgColor: '#F1F5F9', isFinal: false, position: 1 },
      { slug: 'revisao', name: 'Em Revisao', color: '#F59E0B', bgColor: '#FFFBEB', isFinal: false, position: 2 },
      { slug: 'aprovado', name: 'Aprovado', color: '#3B82F6', bgColor: '#EFF6FF', isFinal: false, position: 3 },
      { slug: 'assinatura', name: 'Ag. Assinatura', color: '#8B5CF6', bgColor: '#F5F3FF', isFinal: false, position: 4 },
      { slug: 'assinado', name: 'Assinado', color: '#10B981', bgColor: '#ECFDF5', isFinal: true, position: 5 },
      { slug: 'vencendo', name: 'Vencendo', color: '#EF4444', bgColor: '#FEF2F2', isFinal: false, position: 6 },
    ]},
  ];

  for (const set of faseSets) {
    for (const f of set.fases) {
      await prisma.phase.upsert({
        where: { moduleId_slug: { moduleId: set.moduleId, slug: f.slug } },
        update: {}, create: { ...f, moduleId: set.moduleId },
      });
    }
  }
  console.log('✅ Fases criadas');

  // ─── CATEGORIAS ───────────────────────────────────────────
  const catSets = [
    { moduleId: compras.id, cats: ['Material de Escritorio', 'Equipamentos', 'Servicos', 'Manutencao', 'Alimentacao', 'Uniforme', 'Outros'] },
    { moduleId: ti.id, cats: ['Hardware', 'Software', 'Rede', 'Impressora', 'Telefonia', 'Cameras', 'Outros'] },
    { moduleId: comercial.id, cats: ['Maternal I', 'Maternal II', 'Infantil I', 'Infantil II', 'Fund. I', 'Fund. II', 'Ensino Medio'] },
    { moduleId: financeiro.id, cats: ['Mensalidade', 'Fornecedor', 'Folha de Pagamento', 'Imposto', 'Manutencao', 'Material', 'Servico', 'Outros'] },
    { moduleId: contratos.id, cats: ['Fornecedor', 'Prestador de Servico', 'Locacao', 'Parceria', 'Franquia', 'Outros'] },
  ];

  for (const set of catSets) {
    for (let i = 0; i < set.cats.length; i++) {
      await prisma.category.upsert({
        where: { moduleId_name: { moduleId: set.moduleId, name: set.cats[i] } },
        update: {}, create: { moduleId: set.moduleId, name: set.cats[i], position: i + 1 },
      });
    }
  }
  console.log('✅ Categorias criadas');

  console.log('\n🎉 Seed completo!');
  console.log('📋 Login: emerson@grupoped.com.br / Ped@2026\n');
}

main()
  .catch(e => { console.error('❌ Erro:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
