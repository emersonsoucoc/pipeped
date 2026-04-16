/**
 * PIPEPED — API Routes (Express)
 * Conecta ao PostgreSQL via Prisma, gerencia Tasks, Leads, Users, Schools, Modules
 */
'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'pipeped-jwt-secret-2026';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// ─── Middleware JWT ─────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token nao fornecido' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Acesso negado' });
  next();
}

function managerOrAdmin(req, res, next) {
  if (!['ADMIN', 'MANAGER'].includes(req.user.role)) return res.status(403).json({ error: 'Acesso negado' });
  next();
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, schoolId: user.schoolId },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// ─── Registro de rotas ──────────────────────────────────────────────
module.exports = function registerApiRoutes(app) {

  // ═══════════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatorios' });

      const user = await prisma.user.findUnique({
        where: { email },
        include: { school: { select: { id: true, name: true, shortName: true } } },
      });
      if (!user) return res.status(401).json({ error: 'Credenciais invalidas' });
      if (!user.active) return res.status(401).json({ error: 'Usuario desativado' });

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Credenciais invalidas' });

      const token = signToken(user);
      res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, schoolId: user.schoolId, school: user.school },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { name, email, password, role, schoolId, phone } = req.body;
      if (!name || !email || !password || !schoolId) return res.status(400).json({ error: 'Campos obrigatorios: name, email, password, schoolId' });

      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) return res.status(409).json({ error: 'Email ja cadastrado' });

      const hash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: { name, email, password: hash, role: role || 'USER', schoolId, phone },
        select: { id: true, name: true, email: true, role: true, schoolId: true },
      });

      const token = signToken(user);
      res.status(201).json({ token, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { id: true, name: true, email: true, role: true, phone: true, avatarUrl: true, active: true, schoolId: true,
          school: { select: { id: true, name: true, shortName: true } }, createdAt: true },
      });
      if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
      res.json(user);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/users', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 20, search, schoolId } = req.query;
      const where = {};
      if (schoolId) where.schoolId = schoolId;
      if (search) where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];

      const [data, total] = await Promise.all([
        prisma.user.findMany({
          where, skip: (page - 1) * limit, take: +limit,
          select: { id: true, name: true, email: true, role: true, phone: true, active: true, schoolId: true,
            school: { select: { id: true, name: true, shortName: true } }, createdAt: true },
          orderBy: { name: 'asc' },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({ data, meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/users/:id', authMiddleware, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, email: true, role: true, phone: true, active: true, schoolId: true,
          school: { select: { id: true, name: true, shortName: true } }, createdAt: true, updatedAt: true },
      });
      if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
      res.json(user);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/users', authMiddleware, managerOrAdmin, async (req, res) => {
    try {
      const { name, email, password, role, schoolId, phone } = req.body;
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) return res.status(409).json({ error: 'Email ja cadastrado' });

      const hash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: { name, email, password: hash, role: role || 'USER', schoolId, phone },
        select: { id: true, name: true, email: true, role: true, schoolId: true },
      });
      res.status(201).json(user);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/users/:id', authMiddleware, managerOrAdmin, async (req, res) => {
    try {
      const data = { ...req.body };
      if (data.password) data.password = await bcrypt.hash(data.password, 12);
      const user = await prisma.user.update({
        where: { id: req.params.id }, data,
        select: { id: true, name: true, email: true, role: true, schoolId: true, active: true },
      });
      res.json(user);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
      await prisma.user.update({ where: { id: req.params.id }, data: { active: false } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // SCHOOLS
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/schools', authMiddleware, async (req, res) => {
    try {
      const { search } = req.query;
      const where = { active: true };
      if (search) where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { shortName: { contains: search, mode: 'insensitive' } },
      ];
      const data = await prisma.school.findMany({
        where, orderBy: { name: 'asc' },
        include: { _count: { select: { users: true, tasks: true, leads: true } } },
      });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/schools/:id', authMiddleware, async (req, res) => {
    try {
      const school = await prisma.school.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { users: true, tasks: true, leads: true } } },
      });
      if (!school) return res.status(404).json({ error: 'Escola nao encontrada' });
      res.json(school);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/schools', authMiddleware, adminOnly, async (req, res) => {
    try {
      const school = await prisma.school.create({ data: req.body });
      res.status(201).json(school);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/schools/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
      const school = await prisma.school.update({ where: { id: req.params.id }, data: req.body });
      res.json(school);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // MODULES & PHASES
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/modules', authMiddleware, async (req, res) => {
    try {
      const data = await prisma.module.findMany({
        where: { active: true }, orderBy: { displayOrder: 'asc' },
        include: {
          phases: { orderBy: { position: 'asc' } },
          categories: { orderBy: { position: 'asc' } },
          _count: { select: { tasks: true } },
        },
      });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/modules/:slug', authMiddleware, async (req, res) => {
    try {
      const mod = await prisma.module.findUnique({
        where: { slug: req.params.slug },
        include: {
          phases: { orderBy: { position: 'asc' } },
          categories: { orderBy: { position: 'asc' } },
          _count: { select: { tasks: true } },
        },
      });
      if (!mod) return res.status(404).json({ error: 'Modulo nao encontrado' });
      res.json(mod);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // TASKS (KANBAN)
  // ═══════════════════════════════════════════════════════════════════

  const TASK_INCLUDE = {
    module: { select: { id: true, slug: true, name: true } },
    phase: { select: { id: true, slug: true, name: true, color: true, bgColor: true } },
    category: { select: { id: true, name: true } },
    school: { select: { id: true, name: true, shortName: true } },
    createdBy: { select: { id: true, name: true, email: true } },
    assignedTo: { select: { id: true, name: true, email: true } },
    _count: { select: { comments: true, attachments: true } },
  };

  // Board Kanban completo
  app.get('/api/tasks/board/:moduleSlug', authMiddleware, async (req, res) => {
    try {
      const mod = await prisma.module.findUnique({
        where: { slug: req.params.moduleSlug },
        include: { phases: { orderBy: { position: 'asc' } } },
      });
      if (!mod) return res.status(404).json({ error: 'Modulo nao encontrado' });

      const where = { moduleId: mod.id };
      if (req.query.schoolId) where.schoolId = req.query.schoolId;

      const tasks = await prisma.task.findMany({
        where, include: TASK_INCLUDE,
        orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
      });

      const board = mod.phases.map(phase => ({
        phase: { id: phase.id, slug: phase.slug, name: phase.name, color: phase.color, bgColor: phase.bgColor, isFinal: phase.isFinal },
        tasks: tasks.filter(t => t.phaseId === phase.id),
      }));

      res.json({ module: { id: mod.id, slug: mod.slug, name: mod.name, hasFinancial: mod.hasFinancial }, board });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Stats
  app.get('/api/tasks/stats', authMiddleware, async (req, res) => {
    try {
      const where = {};
      if (req.query.schoolId) where.schoolId = req.query.schoolId;

      const [total, byModule, byPriority, recent] = await Promise.all([
        prisma.task.count({ where }),
        prisma.task.groupBy({ by: ['moduleId'], where, _count: true }),
        prisma.task.groupBy({ by: ['priority'], where, _count: true }),
        prisma.task.findMany({ where, include: TASK_INCLUDE, orderBy: { createdAt: 'desc' }, take: 10 }),
      ]);

      res.json({ total, byModule, byPriority, recent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Detalhe do card
  app.get('/api/tasks/:id', authMiddleware, async (req, res) => {
    try {
      const task = await prisma.task.findUnique({
        where: { id: req.params.id },
        include: {
          ...TASK_INCLUDE,
          comments: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } },
          history: { orderBy: { createdAt: 'desc' }, take: 50 },
          attachments: true,
        },
      });
      if (!task) return res.status(404).json({ error: 'Task nao encontrada' });
      res.json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Criar card
  app.post('/api/tasks', authMiddleware, async (req, res) => {
    try {
      const d = req.body;
      const task = await prisma.task.create({
        data: {
          title: d.title, description: d.description,
          priority: d.priority || 'MEDIA',
          dueDate: d.dueDate ? new Date(d.dueDate) : null,
          moduleId: d.moduleId, phaseId: d.phaseId,
          categoryId: d.categoryId || null,
          schoolId: d.schoolId, createdById: req.user.sub,
          assignedToId: d.assignedToId || null,
          amount: d.amount || null, supplier: d.supplier || null,
          documentNumber: d.documentNumber || null,
          paymentDue: d.paymentDue ? new Date(d.paymentDue) : null,
        },
        include: TASK_INCLUDE,
      });

      await prisma.taskHistory.create({
        data: { taskId: task.id, action: 'created', details: `Card "${task.title}" criado`, userName: req.user.name },
      });

      res.status(201).json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Atualizar card
  app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
    try {
      const d = { ...req.body };
      if (d.dueDate) d.dueDate = new Date(d.dueDate);
      if (d.paymentDue) d.paymentDue = new Date(d.paymentDue);

      const task = await prisma.task.update({
        where: { id: req.params.id }, data: d, include: TASK_INCLUDE,
      });

      await prisma.taskHistory.create({
        data: { taskId: task.id, action: 'updated', details: 'Card atualizado', userName: req.user.name },
      });

      res.json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Mover card de fase (drag & drop)
  app.patch('/api/tasks/:id/move', authMiddleware, async (req, res) => {
    try {
      const { phaseId, position } = req.body;

      const oldTask = await prisma.task.findUnique({
        where: { id: req.params.id },
        include: { phase: { select: { name: true } } },
      });
      if (!oldTask) return res.status(404).json({ error: 'Task nao encontrada' });

      const newPhase = await prisma.phase.findUnique({ where: { id: phaseId } });
      if (!newPhase) return res.status(404).json({ error: 'Fase nao encontrada' });

      const task = await prisma.task.update({
        where: { id: req.params.id },
        data: {
          phaseId,
          position: position ?? 0,
          completedAt: newPhase.isFinal ? new Date() : null,
        },
        include: TASK_INCLUDE,
      });

      await prisma.taskHistory.create({
        data: {
          taskId: task.id, action: 'moved',
          details: `Movido de "${oldTask.phase.name}" para "${newPhase.name}"`,
          userName: req.user.name,
        },
      });

      res.json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Deletar card
  app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
    try {
      await prisma.task.delete({ where: { id: req.params.id } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Comentarios
  app.post('/api/tasks/:id/comments', authMiddleware, async (req, res) => {
    try {
      const comment = await prisma.comment.create({
        data: { content: req.body.content, taskId: req.params.id, userId: req.user.sub },
        include: { user: { select: { id: true, name: true } } },
      });

      await prisma.taskHistory.create({
        data: { taskId: req.params.id, action: 'comment', details: 'Comentario adicionado', userName: req.user.name },
      });

      res.status(201).json(comment);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tasks/:id/comments', authMiddleware, async (req, res) => {
    try {
      const comments = await prisma.comment.findMany({
        where: { taskId: req.params.id },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json(comments);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // LEADS (COMERCIAL)
  // ═══════════════════════════════════════════════════════════════════

  const LEAD_INCLUDE = {
    school: { select: { id: true, name: true, shortName: true } },
    assignedTo: { select: { id: true, name: true, email: true } },
    _count: { select: { conversations: true } },
  };

  app.get('/api/leads', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 20, search, schoolId, status } = req.query;
      const where = {};
      if (schoolId) where.schoolId = schoolId;
      if (status) where.status = status;
      if (search) where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { studentName: { contains: search, mode: 'insensitive' } },
      ];

      const [data, total] = await Promise.all([
        prisma.lead.findMany({
          where, include: LEAD_INCLUDE,
          skip: (page - 1) * limit, take: +limit,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.lead.count({ where }),
      ]);

      res.json({ data, meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pipeline Kanban
  app.get('/api/leads/pipeline', authMiddleware, async (req, res) => {
    try {
      const where = {};
      if (req.query.schoolId) where.schoolId = req.query.schoolId;

      const leads = await prisma.lead.findMany({ where, include: LEAD_INCLUDE, orderBy: { createdAt: 'desc' } });

      const statuses = ['LEAD', 'CONTACTED', 'QUALIFIED', 'VISIT', 'PROPOSAL', 'WON', 'LOST'];
      const pipeline = statuses.map(s => ({
        status: s,
        leads: leads.filter(l => l.status === s),
        count: leads.filter(l => l.status === s).length,
      }));

      res.json({ pipeline, total: leads.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/leads/stats', authMiddleware, async (req, res) => {
    try {
      const where = {};
      if (req.query.schoolId) where.schoolId = req.query.schoolId;
      const [total, byStatus] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.groupBy({ by: ['status'], where, _count: true }),
      ]);
      res.json({ total, byStatus });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/leads/:id', authMiddleware, async (req, res) => {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: req.params.id },
        include: { ...LEAD_INCLUDE, conversations: { include: { messages: { orderBy: { createdAt: 'desc' }, take: 20 } } } },
      });
      if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });
      res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/leads', authMiddleware, async (req, res) => {
    try {
      const lead = await prisma.lead.create({ data: req.body, include: LEAD_INCLUDE });
      res.status(201).json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/leads/:id', authMiddleware, async (req, res) => {
    try {
      const lead = await prisma.lead.update({ where: { id: req.params.id }, data: req.body, include: LEAD_INCLUDE });
      res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/leads/:id/move', authMiddleware, async (req, res) => {
    try {
      const lead = await prisma.lead.update({
        where: { id: req.params.id },
        data: { status: req.body.status },
        include: LEAD_INCLUDE,
      });
      res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/leads/:id', authMiddleware, async (req, res) => {
    try {
      await prisma.lead.delete({ where: { id: req.params.id } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/notifications', authMiddleware, async (req, res) => {
    try {
      const data = await prisma.notification.findMany({
        where: { userId: req.user.sub },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
    try {
      await prisma.notification.update({ where: { id: req.params.id }, data: { read: true } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
    try {
      await prisma.notification.updateMany({ where: { userId: req.user.sub, read: false }, data: { read: true } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('   API PIPEPED: ✅ rotas registradas');
};
