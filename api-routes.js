/**
 * PIPEPED — API Routes (Express)
 * Conecta ao PostgreSQL via Prisma, gerencia Tasks, Leads, Users, Schools, Modules
 */
'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// Upload config — store files in /tmp/uploads (Railway ephemeral storage)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')),
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

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
    attachments: { select: { id: true, fileName: true, fileUrl: true, fileSize: true, mimeType: true, createdAt: true } },
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
  // ATTACHMENTS (FILE UPLOAD)
  // ═══════════════════════════════════════════════════════════════════

  // Serve uploaded files
  app.use('/uploads', require('express').static(UPLOAD_DIR));

  app.post('/api/tasks/:id/attachments', authMiddleware, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
      const fileUrl = `/uploads/${req.file.filename}`;
      const att = await prisma.attachment.create({
        data: {
          taskId: req.params.id,
          fileName: req.file.originalname,
          fileUrl,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
        },
      });
      await prisma.taskHistory.create({
        data: { taskId: req.params.id, action: 'attachment', details: `Arquivo "${req.file.originalname}" anexado`, userName: req.user.name },
      });
      res.status(201).json({ id: att.id, fileName: att.fileName, url: att.fileUrl, fileSize: att.fileSize, mimeType: att.mimeType, createdAt: att.createdAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tasks/:id/attachments', authMiddleware, async (req, res) => {
    try {
      const atts = await prisma.attachment.findMany({ where: { taskId: req.params.id }, orderBy: { createdAt: 'desc' } });
      res.json(atts.map(a => ({ id: a.id, fileName: a.fileName, url: a.fileUrl, fileSize: a.fileSize, mimeType: a.mimeType, createdAt: a.createdAt })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/tasks/:id/attachments/:attId', authMiddleware, async (req, res) => {
    try {
      const att = await prisma.attachment.findUnique({ where: { id: req.params.attId } });
      if (!att) return res.status(404).json({ error: 'Anexo nao encontrado' });
      // Delete file from disk
      const filePath = path.join(UPLOAD_DIR, path.basename(att.fileUrl));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await prisma.attachment.delete({ where: { id: req.params.attId } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASES (CRUD para configuração de fases)
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/modules/:moduleSlug/phases', authMiddleware, async (req, res) => {
    try {
      const mod = await prisma.module.findUnique({ where: { slug: req.params.moduleSlug } });
      if (!mod) return res.status(404).json({ error: 'Modulo nao encontrado' });
      const phases = await prisma.phase.findMany({ where: { moduleId: mod.id }, orderBy: { position: 'asc' } });
      res.json(phases);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/modules/:moduleSlug/phases', authMiddleware, adminOnly, async (req, res) => {
    try {
      const mod = await prisma.module.findUnique({ where: { slug: req.params.moduleSlug } });
      if (!mod) return res.status(404).json({ error: 'Modulo nao encontrado' });
      const d = req.body;
      const maxPos = await prisma.phase.aggregate({ where: { moduleId: mod.id }, _max: { position: true } });
      const phase = await prisma.phase.create({
        data: {
          moduleId: mod.id, slug: d.slug, name: d.name,
          color: d.color || '#94A3B8', bgColor: d.bgColor || '#F1F5F9',
          isFinal: d.isFinal || false, slaDays: d.slaDays || null,
          position: (maxPos._max.position || 0) + 1,
        },
      });
      res.status(201).json(phase);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/phases/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
      const d = req.body;
      const phase = await prisma.phase.update({
        where: { id: req.params.id },
        data: {
          name: d.name, color: d.color, bgColor: d.bgColor,
          isFinal: d.isFinal, slaDays: d.slaDays, position: d.position,
        },
      });
      res.json(phase);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/phases/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
      const taskCount = await prisma.task.count({ where: { phaseId: req.params.id } });
      if (taskCount > 0) return res.status(400).json({ error: `Nao e possivel excluir: ${taskCount} card(s) nesta fase. Mova-os primeiro.` });
      await prisma.phase.delete({ where: { id: req.params.id } });
      res.json({ ok: true });
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

  // ═══════════════════════════════════════════════════════════════════
  // FORMS (Formulários & Inscrições)
  // ═══════════════════════════════════════════════════════════════════

  // ─── Helpers ─────────────────────────────────────────────────
  function isValidCPF(cpf) {
    const c = cpf.replace(/\D/g, '');
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    let s = 0; for (let i = 0; i < 9; i++) s += +c[i] * (10 - i);
    let d = 11 - (s % 11); if (d >= 10) d = 0; if (+c[9] !== d) return false;
    s = 0; for (let i = 0; i < 10; i++) s += +c[i] * (11 - i);
    d = 11 - (s % 11); if (d >= 10) d = 0; return +c[10] === d;
  }

  async function generateProtocol(tx, form) {
    const year = new Date().getFullYear();
    const prefix = form.slug.toUpperCase().replace(/-/g, '').substring(0, 12);
    const last = await tx.submission.findFirst({
      where: { formId: form.id }, orderBy: { createdAt: 'desc' }, select: { protocol: true },
    });
    let seq = 1;
    if (last?.protocol) { const p = last.protocol.split('-'); const n = parseInt(p[p.length - 1], 10); if (!isNaN(n)) seq = n + 1; }
    return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
  }

  // ─── GET /api/forms (admin — listar) ────────────────────────
  app.get('/api/forms', authMiddleware, async (req, res) => {
    try {
      const { schoolId, status, page = '1', limit = '20' } = req.query;
      const where = {};
      if (schoolId) where.schoolId = schoolId;
      if (status) where.status = status;
      const p = parseInt(page), l = parseInt(limit);
      const [forms, total] = await prisma.$transaction([
        prisma.form.findMany({
          where, include: { school: { select: { id: true, name: true, shortName: true } }, _count: { select: { submissions: true, versions: true } } },
          orderBy: { createdAt: 'desc' }, skip: (p - 1) * l, take: l,
        }),
        prisma.form.count({ where }),
      ]);
      res.json({ data: forms, total, page: p, limit: l });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── GET /api/forms/public/:slug (público) ──────────────────
  app.get('/api/forms/public/:slug', async (req, res) => {
    try {
      const form = await prisma.form.findUnique({
        where: { slug: req.params.slug },
        include: { school: { select: { id: true, name: true, shortName: true } }, slotOptions: true },
      });
      if (!form) return res.status(404).json({ error: 'Formulário não encontrado' });
      const now = new Date();
      if (form.status !== 'ACTIVE') return res.status(400).json({ error: 'Formulário não está aberto' });
      if (form.opensAt && now < form.opensAt) return res.status(400).json({ error: 'Inscrições ainda não abertas' });
      if (form.closesAt && now > form.closesAt) return res.status(400).json({ error: 'Inscrições encerradas' });

      const version = await prisma.formVersion.findUnique({
        where: { formId_version: { formId: form.id, version: form.currentVersion } },
      });
      if (!version) return res.status(400).json({ error: 'Formulário ainda não publicado' });

      // Vagas
      let slotsInfo;
      if (form.slotMode === 'GLOBAL') {
        const filled = await prisma.submission.count({ where: { formId: form.id, status: { in: ['RESERVED','PENDING','CONFIRMED'] } } });
        slotsInfo = { mode: 'GLOBAL', total: form.maxSlots, filled, available: Math.max(0, (form.maxSlots || 0) - filled) };
      } else {
        slotsInfo = { mode: 'PER_OPTION', options: form.slotOptions.map(o => ({ id: o.id, label: o.label, total: o.maxSlots, filled: o.filled, available: Math.max(0, o.maxSlots - o.filled) })) };
      }

      const snap = version.snapshot;
      res.json({
        id: form.id, title: form.title, slug: form.slug, description: form.description, coverImage: form.coverImage,
        school: form.school, requiresConfirmation: form.requiresConfirmation, reservationTtlMinutes: form.reservationTtlMinutes,
        version: version.version, versionId: version.id, fields: snap.fields || [], slotOptions: snap.slotOptions || [], slotsInfo,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── GET /api/forms/:id (admin) ─────────────────────────────
  app.get('/api/forms/:id', authMiddleware, async (req, res) => {
    try {
      const form = await prisma.form.findUnique({
        where: { id: req.params.id },
        include: {
          fields: { orderBy: { position: 'asc' } }, slotOptions: true,
          school: { select: { id: true, name: true, shortName: true } },
          versions: { orderBy: { version: 'desc' }, take: 5 },
          _count: { select: { submissions: true } },
        },
      });
      if (!form) return res.status(404).json({ error: 'Não encontrado' });
      res.json(form);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── GET /api/forms/:id/slots (público — vagas) ─────────────
  app.get('/api/forms/:id/slots', async (req, res) => {
    try {
      const form = await prisma.form.findUnique({ where: { id: req.params.id }, include: { slotOptions: true } });
      if (!form) return res.status(404).json({ error: 'Não encontrado' });
      if (form.slotMode === 'GLOBAL') {
        const filled = await prisma.submission.count({ where: { formId: form.id, status: { in: ['RESERVED','PENDING','CONFIRMED'] } } });
        return res.json({ mode: 'GLOBAL', total: form.maxSlots, filled, available: Math.max(0, (form.maxSlots || 0) - filled) });
      }
      res.json({ mode: 'PER_OPTION', options: form.slotOptions.map(o => ({ id: o.id, label: o.label, total: o.maxSlots, filled: o.filled, available: Math.max(0, o.maxSlots - o.filled) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── POST /api/forms (admin — criar) ────────────────────────
  app.post('/api/forms', authMiddleware, managerOrAdmin, async (req, res) => {
    try {
      const d = req.body;
      if (d.slotMode === 'PER_OPTION' && (!d.slotOptions || !d.slotOptions.length)) return res.status(400).json({ error: 'slotOptions obrigatório para PER_OPTION' });
      if (d.slotMode === 'GLOBAL' && d.maxSlots != null && d.maxSlots < 0) return res.status(400).json({ error: 'maxSlots deve ser >= 0' });
      const exists = await prisma.form.findUnique({ where: { slug: d.slug } });
      if (exists) return res.status(400).json({ error: `Slug "${d.slug}" já em uso` });

      const form = await prisma.form.create({
        data: {
          title: d.title, slug: d.slug, description: d.description, coverImage: d.coverImage,
          status: 'DRAFT', isPublic: d.isPublic !== false, opensAt: d.opensAt ? new Date(d.opensAt) : null, closesAt: d.closesAt ? new Date(d.closesAt) : null,
          slotMode: d.slotMode || 'GLOBAL', maxSlots: d.maxSlots, reservationTtlMinutes: d.reservationTtlMinutes || 0,
          requiresConfirmation: d.requiresConfirmation || false, confirmationSubject: d.confirmationSubject, confirmationBody: d.confirmationBody,
          currentVersion: 0, schoolId: d.schoolId, createdById: req.user.sub,
          fields: { create: (d.fields || []).map(f => ({ label: f.label, fieldKey: f.fieldKey, type: f.type, placeholder: f.placeholder, helpText: f.helpText, required: !!f.required, position: f.position || 0, config: f.config || undefined, isSlotField: !!f.isSlotField })) },
          slotOptions: d.slotOptions ? { create: d.slotOptions.map(s => ({ label: s.label, maxSlots: s.maxSlots })) } : undefined,
        },
        include: { fields: { orderBy: { position: 'asc' } }, slotOptions: true, school: { select: { id: true, name: true, shortName: true } } },
      });
      res.status(201).json(form);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── POST /api/forms/:id/publish (admin — publica versão) ───
  app.post('/api/forms/:id/publish', authMiddleware, managerOrAdmin, async (req, res) => {
    try {
      const form = await prisma.form.findUnique({ where: { id: req.params.id }, include: { fields: { orderBy: { position: 'asc' } }, slotOptions: true } });
      if (!form) return res.status(404).json({ error: 'Não encontrado' });
      if (!form.fields.length) return res.status(400).json({ error: 'Formulário sem campos' });
      const next = form.currentVersion + 1;
      const snapshot = {
        title: form.title, description: form.description, slotMode: form.slotMode, maxSlots: form.maxSlots,
        reservationTtlMinutes: form.reservationTtlMinutes, requiresConfirmation: form.requiresConfirmation,
        fields: form.fields.map(f => ({ id: f.id, label: f.label, fieldKey: f.fieldKey, type: f.type, placeholder: f.placeholder, helpText: f.helpText, required: f.required, position: f.position, config: f.config, isSlotField: f.isSlotField })),
        slotOptions: form.slotOptions.map(s => ({ id: s.id, label: s.label, maxSlots: s.maxSlots })),
      };
      const result = await prisma.$transaction(async tx => {
        const version = await tx.formVersion.create({ data: { formId: form.id, version: next, snapshot, publishedBy: req.user.sub } });
        const updated = await tx.form.update({ where: { id: form.id }, data: { currentVersion: next, status: 'ACTIVE' } });
        return { form: updated, version };
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── PATCH /api/forms/:id/status (admin) ────────────────────
  app.patch('/api/forms/:id/status', authMiddleware, managerOrAdmin, async (req, res) => {
    try {
      const updated = await prisma.form.update({ where: { id: req.params.id }, data: { status: req.body.status } });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // SUBMISSIONS (Inscrições — pipeline)
  // ═══════════════════════════════════════════════════════════════════

  // ─── POST /api/submissions (público — nova inscrição) ───────
  app.post('/api/submissions', async (req, res) => {
    try {
      const d = req.body;
      if (!d.formSlug || !d.name || !d.email) return res.status(400).json({ error: 'formSlug, name e email são obrigatórios' });

      // 1. Carregar form + versão
      const form = await prisma.form.findUnique({ where: { slug: d.formSlug }, include: { slotOptions: true, school: { select: { id: true, name: true } } } });
      if (!form) return res.status(404).json({ error: 'Formulário não encontrado' });
      const version = await prisma.formVersion.findUnique({ where: { formId_version: { formId: form.id, version: form.currentVersion } } });
      if (!version) return res.status(400).json({ error: 'Formulário não publicado' });

      // 2. Elegibilidade
      const now = new Date();
      if (form.status !== 'ACTIVE') return res.status(400).json({ error: 'Formulário não está aberto' });
      if (form.opensAt && now < form.opensAt) return res.status(400).json({ error: 'Inscrições ainda não abertas' });
      if (form.closesAt && now > form.closesAt) return res.status(400).json({ error: 'Inscrições encerradas' });

      // 3. Validação dos campos obrigatórios (contra snapshot)
      const snapFields = version.snapshot.fields || [];
      const submitted = new Set((d.values || []).map(v => v.fieldKey));
      const missing = snapFields.filter(f => f.required && !submitted.has(f.fieldKey)).map(f => f.label);
      if (missing.length) return res.status(400).json({ error: `Campos obrigatórios: ${missing.join(', ')}` });

      // Validação de CPF e e-mail
      if (d.cpf && !isValidCPF(d.cpf)) return res.status(400).json({ error: 'CPF inválido' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return res.status(400).json({ error: 'E-mail inválido' });

      // 4 + 5. Reserva atômica + Persistência (transação)
      const isReservation = form.requiresConfirmation && form.reservationTtlMinutes > 0;
      const initialStatus = isReservation ? 'RESERVED' : 'CONFIRMED';
      const reservedUntil = isReservation ? new Date(Date.now() + form.reservationTtlMinutes * 60000) : null;

      const submission = await prisma.$transaction(async tx => {
        // Reservar vaga
        if (form.slotMode === 'GLOBAL') {
          const count = await tx.submission.count({ where: { formId: form.id, status: { in: ['RESERVED','PENDING','CONFIRMED'] } } });
          if (form.maxSlots && count >= form.maxSlots) {
            throw Object.assign(new Error('Vagas esgotadas para este formulário'), { statusCode: 409 });
          }
        } else if (form.slotMode === 'PER_OPTION') {
          if (!d.slotOptionId) throw Object.assign(new Error('Selecione uma modalidade/categoria'), { statusCode: 400 });
          const result = await tx.$executeRaw`UPDATE form_slot_options SET filled = filled + 1 WHERE id = ${d.slotOptionId} AND form_id = ${form.id} AND filled < max_slots`;
          if (result === 0) {
            const opt = await tx.formSlotOption.findUnique({ where: { id: d.slotOptionId } });
            const label = opt ? opt.label : 'selecionada';
            throw Object.assign(new Error(`Puxa, a vaga para "${label}" acabou de ser preenchida. Por favor, escolha outra opção.`), { statusCode: 409 });
          }
        }

        const protocol = await generateProtocol(tx, form);
        const fieldMap = new Map(snapFields.map(f => [f.fieldKey, f.id]));

        const created = await tx.submission.create({
          data: {
            formId: form.id, formVersionId: version.id, protocol, status: initialStatus,
            name: d.name, email: d.email, phone: d.phone || null, cpf: d.cpf || null,
            slotOptionId: d.slotOptionId || null, ipAddress: req.ip || req.socket?.remoteAddress,
            userAgent: req.headers['user-agent'], reservedUntil, confirmedAt: isReservation ? null : now,
            values: {
              create: (d.values || []).filter(v => fieldMap.has(v.fieldKey)).map(v => ({ fieldId: fieldMap.get(v.fieldKey), value: String(v.value), fileUrl: v.fileUrl || null })),
            },
          },
          include: { slotOption: true },
        });

        // Log
        await tx.submissionLog.create({ data: { submissionId: created.id, action: 'created', details: { ip: req.ip, slotOptionId: d.slotOptionId } } });

        return created;
      });

      // 6. E-mail (async, não bloqueia)
      try {
        const subj = form.confirmationSubject || `Inscrição confirmada — ${form.title}`;
        let body = form.confirmationBody || `Olá {{nome}},\n\nSua inscrição foi confirmada!\nProtocolo: {{protocolo}}\n\nAtenciosamente,\n{{escola}}`;
        body = body.replace(/\{\{nome\}\}/g, submission.name).replace(/\{\{protocolo\}\}/g, submission.protocol)
          .replace(/\{\{formulario\}\}/g, form.title).replace(/\{\{escola\}\}/g, form.school?.name || 'Grupo PED');
        await prisma.emailLog.create({ data: { to: submission.email, subject: subj, content: body, status: 'queued' } });
        await prisma.submissionLog.create({ data: { submissionId: submission.id, action: 'email_queued', details: { to: submission.email } } });
      } catch (emailErr) {
        console.error('Email falhou:', emailErr.message);
        await prisma.submissionLog.create({ data: { submissionId: submission.id, action: 'email_failed', details: { error: emailErr.message } } }).catch(() => {});
      }

      res.status(201).json({
        id: submission.id, protocol: submission.protocol, status: submission.status,
        name: submission.name, email: submission.email, slotOption: submission.slotOption?.label,
        reservedUntil: submission.reservedUntil, createdAt: submission.createdAt,
      });
    } catch (e) {
      const code = e.statusCode || 500;
      res.status(code).json({ error: e.message });
    }
  });

  // ─── GET /api/submissions/protocol/:protocol (público) ──────
  app.get('/api/submissions/protocol/:protocol', async (req, res) => {
    try {
      const sub = await prisma.submission.findUnique({
        where: { protocol: req.params.protocol },
        include: {
          form: { select: { id: true, title: true, slug: true } },
          formVersion: { select: { version: true, snapshot: true } },
          values: { include: { field: { select: { label: true, type: true, fieldKey: true } } } },
          slotOption: { select: { label: true } },
        },
      });
      if (!sub) return res.status(404).json({ error: 'Inscrição não encontrada' });
      res.json(sub);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── POST /api/submissions/confirm/:protocol (público) ──────
  app.post('/api/submissions/confirm/:protocol', async (req, res) => {
    try {
      const sub = await prisma.submission.findUnique({ where: { protocol: req.params.protocol } });
      if (!sub) return res.status(404).json({ error: 'Inscrição não encontrada' });
      if (sub.status !== 'RESERVED') return res.status(400).json({ error: `Status "${sub.status}" não pode ser confirmado` });
      if (sub.reservedUntil && new Date() > sub.reservedUntil) return res.status(400).json({ error: 'Reserva expirada' });
      const updated = await prisma.submission.update({ where: { id: sub.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), reservedUntil: null } });
      await prisma.submissionLog.create({ data: { submissionId: sub.id, action: 'confirmed' } });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── GET /api/submissions/form/:formId (admin) ──────────────
  app.get('/api/submissions/form/:formId', authMiddleware, async (req, res) => {
    try {
      const { status, page = '1', limit = '50' } = req.query;
      const where = { formId: req.params.formId };
      if (status) where.status = status;
      const p = parseInt(page), l = parseInt(limit);
      const [subs, total] = await prisma.$transaction([
        prisma.submission.findMany({
          where, include: { slotOption: { select: { label: true } }, formVersion: { select: { version: true } }, _count: { select: { values: true } } },
          orderBy: { createdAt: 'desc' }, skip: (p - 1) * l, take: l,
        }),
        prisma.submission.count({ where }),
      ]);
      res.json({ data: subs, total, page: p, limit: l });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── PATCH /api/submissions/:id/cancel (admin) ──────────────
  app.patch('/api/submissions/:id/cancel', authMiddleware, async (req, res) => {
    try {
      const sub = await prisma.submission.findUnique({ where: { id: req.params.id } });
      if (!sub) return res.status(404).json({ error: 'Não encontrada' });
      if (sub.status === 'CANCELED') return res.status(400).json({ error: 'Já cancelada' });
      const updated = await prisma.$transaction(async tx => {
        if (sub.slotOptionId) await tx.$executeRaw`UPDATE form_slot_options SET filled = GREATEST(filled - 1, 0) WHERE id = ${sub.slotOptionId}`;
        return tx.submission.update({ where: { id: sub.id }, data: { status: 'CANCELED', canceledAt: new Date(), reservedUntil: null } });
      });
      await prisma.submissionLog.create({ data: { submissionId: sub.id, action: 'canceled', details: { reason: req.body.reason } } });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('   API PIPEPED: ✅ rotas registradas (+ Forms & Submissions)');
};
