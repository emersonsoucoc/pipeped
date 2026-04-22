require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');

let pdfParse;
try { pdfParse = require('pdf-parse'); } catch { pdfParse = null; }

let Tesseract;
try { Tesseract = require('tesseract.js'); } catch { Tesseract = null; }

let pdf2img;
try { pdf2img = require('pdf-img-convert'); } catch { pdf2img = null; }

/* ── OCR helper: converte PDF-imagem em texto via Tesseract ──────────────── */
async function ocrPdfBuffer(buffer) {
  if (!Tesseract || !pdf2img) return '';
  try {
    const images = await pdf2img.convert(buffer, { width: 2000, height: 2800, page_numbers: [1] });
    if (!images || !images.length) return '';
    const imgBuf = Buffer.isBuffer(images[0]) ? images[0] : Buffer.from(images[0]);
    const { data: { text } } = await Tesseract.recognize(imgBuf, 'por', {
      logger: () => {},
    });
    return text || '';
  } catch (e) {
    console.warn('OCR falhou:', e.message);
    return '';
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/* ── API PIPEPED (Prisma + PostgreSQL) ───────────────────────────────────── */
try {
  const registerApiRoutes = require('./api-routes');
  registerApiRoutes(app);
} catch (e) {
  console.warn('⚠️  API routes nao carregadas:', e.message);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_r, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

/* ── Clicksign API v3 ─────────────────────────────────────────────────────── */
const clicksign = axios.create({
  baseURL: process.env.API_URL || 'https://sandbox.clicksign.com/api/v3',
  headers: { 'Content-Type':'application/vnd.api+json','Accept':'application/vnd.api+json' },
});
clicksign.interceptors.request.use(c => {
  const t = process.env.CLICKSIGN_TOKEN;
  if (!t) throw new Error('CLICKSIGN_TOKEN não configurado');
  c.headers['Authorization'] = t; return c;
});

const UNITS = [
  { id:'coclauro',   name:'COC Lauro de Freitas',  sender:'contratos@coclauro.com.br',senderName:'Grupo PED · COC Lauro de Freitas',active:true },
  { id:'ped_imbui',  name:'PED Imbuí',             sender:'contratos@coclauro.com.br',senderName:'Grupo PED · PED Imbuí',            active:false},
  { id:'coc_horto',  name:'COC Horto Florestal',   sender:'contratos@coclauro.com.br',senderName:'Grupo PED · COC Horto Florestal',  active:false},
  { id:'anglo_lauro',name:'Anglo Lauro de Freitas', sender:'contratos@coclauro.com.br',senderName:'Grupo PED · Anglo Lauro',          active:false},
];
const DEFAULT_UNIT_ID = 'coclauro';
const AUTO_SIGN_SENDER = process.env.AUTO_SIGN_SENDER !== 'false';
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';
const DRIVE_ENABLED = !!DRIVE_FOLDER_ID && !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const archiveStatus = new Map();

const AUTH_METHODS = {
  email:{auth:'email',requiresPhone:false,channel:'email'},
  sms:{auth:'sms',requiresPhone:true,channel:'email'},
  whatsapp:{auth:'whatsapp',requiresPhone:true,channel:'email'},
  whatsapp_full:{auth:'whatsapp',requiresPhone:true,channel:'whatsapp'},
  selfie:{auth:'selfie',requiresPhone:false,channel:'email'},
};

/* ── Clicksign helpers ────────────────────────────────────────────────────── */
async function csCreate(name){ const {data}=await clicksign.post('/envelopes',{data:{type:'envelopes',attributes:{name}}}); return data.data; }
async function csAddDoc(eid,buf,orig){ const safe=orig.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]/g,'_').toLowerCase(); const {data}=await clicksign.post(`/envelopes/${eid}/documents`,{data:{type:'documents',attributes:{filename:safe,content_base64:`data:application/pdf;base64,${buf.toString('base64')}`}}}); return data.data; }
async function csAddSigner(eid,{name,email,phone,channel}){ const a={name,email,communicate_events:{signature_request:channel,signature_reminder:channel==='whatsapp'?'whatsapp':'email',document_signed:'email'}}; if(phone)a.phone_number=phone; const{data}=await clicksign.post(`/envelopes/${eid}/signers`,{data:{type:'signers',attributes:a}}); return data.data; }
async function csReqs(eid,did,sid,auth){ const d={data:{type:'documents',id:did}},s={data:{type:'signers',id:sid}}; await clicksign.post(`/envelopes/${eid}/requirements`,{data:{type:'requirements',attributes:{action:'agree',role:'sign'},relationships:{document:d,signer:s}}}); await clicksign.post(`/envelopes/${eid}/requirements`,{data:{type:'requirements',attributes:{action:'provide_evidence',auth},relationships:{document:d,signer:s}}}); }
async function csAddSender(eid,unit){ const{data}=await clicksign.post(`/envelopes/${eid}/signers`,{data:{type:'signers',attributes:{name:unit.senderName,email:unit.sender,communicate_events:{signature_request:'none',signature_reminder:'none',document_signed:'email'}}}}); return data.data; }
async function csSenderReqs(eid,did,sid){ const d={data:{type:'documents',id:did}},s={data:{type:'signers',id:sid}}; await clicksign.post(`/envelopes/${eid}/requirements`,{data:{type:'requirements',attributes:{action:'agree',role:'sign'},relationships:{document:d,signer:s}}}); await clicksign.post(`/envelopes/${eid}/requirements`,{data:{type:'requirements',attributes:{action:'provide_evidence',auth:'api'},relationships:{document:d,signer:s}}}); }
async function csAutoSign(eid,sid){ await clicksign.post(`/envelopes/${eid}/signers/${sid}/sign`,{data:{type:'signatures',attributes:{}}}); }
async function csActivate(eid){ await clicksign.patch(`/envelopes/${eid}`,{data:{id:eid,type:'envelopes',attributes:{status:'running'}}}); }
async function csNotify(eid,sid){ await clicksign.post(`/envelopes/${eid}/signers/${sid}/notifications`,{data:{type:'notifications',attributes:{}}}); }
function normPhone(r){ if(!r)return null; let d=String(r).replace(/\D/g,''); if(!d)return null; if(!d.startsWith('55')&&(d.length===10||d.length===11))d='55'+d; return '+'+d; }

/* ── SISED parser (suporta formato Material + Contrato) ──────────────────── */
function parseSised(text){
  const r={alunoNome:null,alunoCpf:null,responsavelNome:null,responsavelCpf:null,
    responsavelTelefone:null,responsavelRg:null,maeNome:null,maeCpf:null,maeTelefone:null,
    paiNome:null,paiCpf:null,paiTelefone:null,enderecoResponsavel:null,
    emailDetectado:null,_fonte:'sised',_confianca:0};
  const c=text.replace(/\r/g,'').replace(/[ \t]+/g,' ');

  /* ─ Formato Material: "Aluno(a): NAME - Data de nascimento: ... - CPF: XXX" ─ */
  const aMat=c.match(/Aluno\(?a?\)?:\s*([^\n]+?)\s*[-–]\s*(?:Data de nascimento|CPF)/i);
  if(aMat) r.alunoNome=aMat[1].trim();
  /* ─ Formato Contrato: "ALUNO: NAME, Residente..." ou "ALUNO: NAME, residente..." ─ */
  if(!r.alunoNome){
    const aCon=c.match(/ALUNO:\s*([A-ZÀ-Ú\s]+?)(?:,\s*[Rr]esidente)/);
    if(aCon) r.alunoNome=aCon[1].trim();
  }

  /* ─ CPF do aluno ─ */
  const acpf=c.match(/(?:ALUNO|Aluno)[^]*?CPF[:\s]*n?[ºo]?\s*([\d]{3}[.\s]?[\d]{3}[.\s]?[\d]{3}[-.\s]?[\d]{2})/i);
  if(acpf) r.alunoCpf=acpf[1].trim();

  /* ─ Mãe (formato Material) ─ */
  const m=c.match(/M[ãa]e:\s*([^\n-]+?)\s*[-–]\s*CPF da M[ãa]e:\s*([\d.-]+)/i);
  if(m){ r.maeNome=m[1].trim(); r.maeCpf=m[2].trim();
    const mt=c.match(/M[ãa]e:[^]*?Telefone[^:]*:\s*\(?(\d[\d\s().-]+\d)/i);
    if(mt) r.maeTelefone=mt[1].trim();
  }

  /* ─ Pai (formato Material) ─ */
  const p=c.match(/Pai:\s*([^\n-]+?)\s*[-–]\s*CPF do Pai:\s*([\d.-]+)/i);
  if(p){ r.paiNome=p[1].trim(); r.paiCpf=p[2].trim();
    const pt=c.match(/Pai:[^]*?Telefone[^:]*:\s*\(?(\d[\d\s().-]+\d)/i);
    if(pt) r.paiTelefone=pt[1].trim();
  }

  /* ─ Responsável Financeiro (formato Material: "Responsável Financeiro: NAME - RG: ...") ─ */
  const rf=c.match(/Respons[áa]vel Financeiro:\s*([^\n-]+?)\s*[-–]\s*RG:\s*([^-\n]+?)\s*[-–]\s*CPF:\s*([\d.-]+)/i);
  if(rf){ r.responsavelNome=rf[1].trim(); r.responsavelRg=rf[2].trim(); r.responsavelCpf=rf[3].trim();
    const rft=c.match(/Respons[áa]vel Financeiro:[^]*?Telefone[^:]*:\s*\(?(\d[\d\s().-]+\d)/i);
    if(rft) r.responsavelTelefone=rft[1].trim();
    const rfe=c.match(/Respons[áa]vel Financeiro:[^]*?E-?mail:\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i);
    if(rfe) r.emailDetectado=rfe[1].trim();
  }

  /* ─ 1º CONTRATANTE (formato Contrato): "1º CONTRATANTE: NAME, residente..." ─ */
  if(!r.responsavelNome){
    const ct=c.match(/1[°ºo]\s*CONTRATANTE:\s*([A-ZÀ-Ú\s]+?)(?:,\s*[Rr]esidente)/);
    if(ct) r.responsavelNome=ct[1].trim();
    /* CPF do 1º contratante */
    const ctcpf=c.match(/1[°ºo]\s*CONTRATANTE:[^]*?CPF[:\s]*n?[ºo]?\s*([\d]{3}[.\s]?[\d]{3}[.\s]?[\d]{3}[-.\s]?[\d]{2})/i);
    if(ctcpf) r.responsavelCpf=ctcpf[1].trim();
    /* Telefone do 1º contratante */
    const ctt=c.match(/1[°ºo]\s*CONTRATANTE:[^]*?Telefone[s]?[:\s]*\(?(\d[\d\s().\/-]+\d)/i);
    if(ctt) r.responsavelTelefone=ctt[1].trim();
    /* Email do 1º contratante */
    const cte=c.match(/1[°ºo]\s*CONTRATANTE:[^]*?e-?mail:\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i);
    if(cte) r.emailDetectado=cte[1].trim();
  }

  /* ─ Fallback responsável: mãe ou pai ─ */
  if(!r.responsavelNome){
    if(r.maeNome){ r.responsavelNome=r.maeNome; r.responsavelCpf=r.maeCpf; r.responsavelTelefone=r.maeTelefone; }
    else if(r.paiNome){ r.responsavelNome=r.paiNome; r.responsavelCpf=r.paiCpf; r.responsavelTelefone=r.paiTelefone; }
  }

  /* ─ Email genérico (fallback se nenhum campo específico achou) ─ */
  if(!r.emailDetectado){
    const em=c.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if(em) r.emailDetectado=em[0];
  }

  /* ─ Limpeza final ─ */
  if(r.emailDetectado) r.emailDetectado=r.emailDetectado.replace(/[.,;:]+$/,'');
  ['responsavelTelefone','maeTelefone','paiTelefone'].forEach(k=>{
    if(r[k]) r[k]=r[k].replace(/^\(?/,'(').replace(/\)\s*/,') ');
  });

  /* ─ Confiança ─ */
  const fields=[r.alunoNome,r.responsavelNome,r.responsavelCpf,r.emailDetectado];
  r._confianca=fields.filter(Boolean).length/fields.length;
  return r;
}

/* ── Routes: Contratos / Clicksign ────────────────────────────────────────── */
app.get('/api/units',(_,res)=>res.json({units:UNITS,default:DEFAULT_UNIT_ID}));

app.post('/api/send-contract', upload.array('contracts',10), async(req,res)=>{
  try{
    const files=req.files||[]; if(!files.length)return res.status(400).json({error:'Envie ao menos um PDF.'});
    const{name,email,auth_method,phone,unit_id}=req.body; const method=auth_method||'email'; const mc=AUTH_METHODS[method];
    if(!mc)return res.status(400).json({error:`Método inválido: ${method}`});
    const unit=UNITS.find(u=>u.id===(unit_id||DEFAULT_UNIT_ID)); if(!unit)return res.status(400).json({error:'Unidade inválida'});
    if(!name?.trim()||!email?.trim())return res.status(400).json({error:'Nome e e-mail obrigatórios.'});
    const np=normPhone(phone); if(mc.requiresPhone&&!np)return res.status(400).json({error:'Telefone obrigatório para SMS/WhatsApp.'});
    const sn=name.trim(),se=email.trim().toLowerCase();
    const eName=`[${unit.name}] ${files.length===1?files[0].originalname:`${files.length} contratos — ${sn}`}`;
    const env=await csCreate(eName); const docs=[]; for(const f of files){docs.push(await csAddDoc(env.id,f.buffer,f.originalname));}
    const signer=await csAddSigner(env.id,{name:sn,email:se,phone:mc.requiresPhone?np:null,channel:mc.channel});
    let ss=null; if(AUTO_SIGN_SENDER)ss=await csAddSender(env.id,unit);
    for(const d of docs){await csReqs(env.id,d.id,signer.id,mc.auth); if(ss)await csSenderReqs(env.id,d.id,ss.id);}
    await csActivate(env.id); let signed=false; if(ss){try{await csAutoSign(env.id,ss.id);signed=true;}catch{}}
    await csNotify(env.id,signer.id);
    res.status(201).json({success:true,envelope_id:env.id,documents:docs.map(d=>({id:d.id,filename:d.attributes?.filename})),sender_auto_signed:signed});
  }catch(e){const m=e.response?.data?.errors?.[0]?.detail||e.message; res.status(e.response?.status||500).json({error:m});}
});

app.post('/api/parse-sised', upload.single('contract'), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'Nenhum PDF.'});
  try {
    let text = '';
    /* Tenta pdf-parse primeiro (PDFs com texto nativo) */
    if (pdfParse) {
      const p = await pdfParse(req.file.buffer);
      text = (p.text || '').trim();
    }
    /* Se texto vazio ou muito curto → tenta OCR (PDFs escaneados/imagem) */
    if (text.length < 50) {
      console.log('pdf-parse retornou texto curto (' + text.length + ' chars), tentando OCR...');
      const ocrText = await ocrPdfBuffer(req.file.buffer);
      if (ocrText.trim().length > text.length) text = ocrText;
    }
    if (text.length < 10) {
      return res.json({ ok: false, motivo: 'sem_texto',
        dados: parseSised(''),
        sugestao: 'PDF sem texto extraível e OCR indisponível. Preencha manualmente.' });
    }
    const d = parseSised(text);
    if (d._confianca < 0.3) {
      return res.json({ ok: false, motivo: 'pdf_nao_reconhecido', dados: d,
        sugestao: 'PDF não parece ser do SISED, ou template mudou. Preenchimento manual.' });
    }
    res.json({ ok: true, dados: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/envelopes', async(_,res)=>{
  try{
    const all=[],inc=[]; for(let pg=1;pg<=5;pg++){const{data}=await clicksign.get('/envelopes',{params:{include:'signers,documents','page[size]':50,'page[number]':pg}}); all.push(...(data.data||[])); inc.push(...(data.included||[])); if((data.data||[]).length<50)break;}
    const sMap={},dMap={}; inc.forEach(r=>{if(r.type==='signers')sMap[r.id]=r; if(r.type==='documents')dMap[r.id]=r;});
    const se=UNITS.map(u=>u.sender.toLowerCase());
    const cls=all.map(env=>{const a=env.attributes||{},rl=env.relationships||{}; const sIds=(rl.signers?.data||[]).map(s=>s.id),dIds=(rl.documents?.data||[]).map(d=>d.id); const sigs=sIds.map(id=>sMap[id]).filter(Boolean),docs=dIds.map(id=>dMap[id]).filter(Boolean); const ss=sigs.filter(s=>se.includes((s.attributes?.email||'').toLowerCase())),os=sigs.filter(s=>!se.includes((s.attributes?.email||'').toLowerCase())); const sf=ss.length>0&&ss.every(s=>!!s.attributes?.signed_at); let ph; const st=a.status; if(st==='closed'||st==='auto_close')ph='signed'; else if(st==='canceled'||st==='refused'||st==='expired')ph='rejected'; else ph='waiting_responsavel'; let unit=UNITS.find(u=>ss.some(s=>(s.attributes?.email||'').toLowerCase()===u.sender.toLowerCase())); if(!unit){const mt=(a.name||'').match(/^\[([^\]]+)\]/); if(mt)unit=UNITS.find(u=>u.name===mt[1]);} const rp=os[0]; return{id:env.id,name:a.name||'?',status:st,phase:ph,unit:unit?{id:unit.id,name:unit.name}:null,documents:docs.map(d=>({id:d.id,filename:d.attributes?.filename})),responsavel:rp?{id:rp.id,name:rp.attributes?.name,email:rp.attributes?.email,signed_at:rp.attributes?.signed_at}:null,sender_signed:sf,archive:archiveStatus.get(env.id)||null,created_at:a.created_at,updated_at:a.updated_at};});
    cls.sort((a,b)=>new Date(b.updated_at||b.created_at||0)-new Date(a.updated_at||a.created_at||0));
    const phases={waiting_responsavel:[],signed:[],rejected:[]}; cls.forEach(e=>phases[e.phase]?.push(e)); res.json({total:cls.length,phases});
  }catch(e){res.status(e.response?.status||500).json({error:e.response?.data?.errors?.[0]?.detail||e.message});}
});

app.post('/api/envelopes/:id/archive',(req,res)=>{if(!DRIVE_ENABLED)return res.status(503).json({error:'Drive não configurado'}); res.json({ok:true,status:'pending'});});

app.post('/api/webhook/clicksign',express.raw({type:'*/*',limit:'2mb'}),async(req,res)=>{
  try{const secret=process.env.CLICKSIGN_WEBHOOK_SECRET; const raw=req.body instanceof Buffer?req.body:Buffer.from(req.body||''); if(secret){const h=(req.headers['content-hmac']||'').toString(),exp='sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex'); if(!h||h.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(exp)))return res.status(401).json({error:'bad sig'});} res.json({ok:true}); let pl={}; try{pl=JSON.parse(raw.toString());}catch{} const ev=pl.event?.name||'unknown',eid=pl.data?.id||pl.envelope?.id; if((ev==='auto_close'||ev==='close')&&eid&&DRIVE_ENABLED){/* archiveEnvelope(eid) */} if(ev==='sign'&&eid&&AUTO_SIGN_SENDER){try{const{data}=await clicksign.get(`/envelopes/${eid}/signers`); (data.data||[]).filter(s=>UNITS.some(u=>u.sender===s.attributes?.email)&&!s.attributes?.signed_at).forEach(async s=>{try{await csAutoSign(eid,s.id);}catch{}});}catch{}} }catch(e){if(!res.headersSent)res.status(500).json({error:e.message});}
});

app.get('/health',(_,res)=>res.json({status:'ok',ts:new Date().toISOString(),clicksign:!!process.env.CLICKSIGN_TOKEN,drive:DRIVE_ENABLED}));

/* ── Focus NFe Proxy (NF-e / NFS-e) ─────────────────────────────────────── */
app.all('/api/focusnfe/*', async (req, res) => {
  try {
    const token = req.headers['x-focus-token'];
    const ambiente = req.headers['x-focus-ambiente'] || 'homologacao';
    if (!token) return res.status(400).json({ error: 'Token Focus NFe não informado' });

    const baseUrl = ambiente === 'producao'
      ? 'https://api.focusnfe.com.br'
      : 'https://homologacao.focusnfe.com.br';

    // Strip /api/focusnfe prefix to get the real Focus path
    const focusPath = req.originalUrl.replace('/api/focusnfe', '');

    const config = {
      method: req.method.toLowerCase(),
      url: baseUrl + focusPath,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(token + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      validateStatus: () => true, // Don't throw on 4xx/5xx
    };
    if (['post', 'put', 'patch', 'delete'].includes(config.method) && req.body) {
      config.data = req.body;
    }

    const response = await axios(config);
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('Focus NFe proxy error:', e.message);
    res.status(502).json({ error: 'Erro ao conectar com Focus NFe: ' + e.message });
  }
});

/* ── Form Queue (Formulário Público → Fila de Aprovação) ─────────────────── */
const QUEUE_FILE = path.join(__dirname, 'form-queue.json');
function loadQueue(){ try{ return JSON.parse(fs.readFileSync(QUEUE_FILE,'utf8')); }catch{ return []; } }
function saveQueue(q){ fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }

// POST — new submission from public form
app.post('/api/form-queue', (req, res) => {
  try {
    const { modulo, titulo, descricao, escola, categoria, prioridade, prazo, solicitante, valor, fornecedor } = req.body;
    if (!titulo || !descricao || !escola || !categoria || !solicitante?.nome || !solicitante?.email) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const d = new Date();
    const protocolo = 'PED-' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') +
      String(d.getDate()).padStart(2,'0') + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
    const entry = {
      id, protocolo, modulo: modulo||'compras', titulo, descricao, escola, categoria,
      prioridade: prioridade||'media', prazo: prazo||'',
      solicitante: { nome: solicitante.nome, email: solicitante.email, setor: solicitante.setor||'' },
      criadoEm: d.toISOString().split('T')[0],
      criadoEmFull: d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
      status: 'pendente',
      historico: [{ texto:'Solicitação enviada via formulário público', data: d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}), usuario: solicitante.nome }],
    };
    if (valor) entry.valor = valor;
    if (fornecedor) entry.fornecedor = fornecedor;
    const queue = loadQueue();
    queue.unshift(entry);
    saveQueue(queue);
    res.json({ ok: true, protocolo, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET — list queue (for admin panel)
app.get('/api/form-queue', (req, res) => {
  try {
    const queue = loadQueue();
    const status = req.query.status; // pendente | aprovado | rejeitado
    const filtered = status ? queue.filter(q => q.status === status) : queue;
    res.json({ total: filtered.length, items: filtered });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH — approve or reject
app.patch('/api/form-queue/:id', (req, res) => {
  try {
    const queue = loadQueue();
    const idx = queue.findIndex(q => q.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
    const { status, aprovadoPor, rejeitadoPor } = req.body;
    if (!['aprovado','rejeitado'].includes(status)) return res.status(400).json({ error: 'Status inválido' });
    queue[idx].status = status;
    const now = new Date();
    const ts = now.toLocaleDateString('pt-BR')+' '+now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    if (status === 'aprovado') { queue[idx].aprovadoPor = aprovadoPor||'Admin'; queue[idx].aprovadoEm = ts; }
    if (status === 'rejeitado') { queue[idx].rejeitadoPor = rejeitadoPor||'Admin'; queue[idx].rejeitadoEm = ts; }
    saveQueue(queue);
    res.json({ ok: true, item: queue[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Static frontend ──────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname)));
// Inscrição pública — /inscricao/:slug serve inscricao.html
app.get('/inscricao/:slug', (_,res) => res.sendFile(path.join(__dirname,'inscricao.html')));
app.get('/consultar-inscricao', (_,res) => res.sendFile(path.join(__dirname,'inscricao.html')));
app.get(/^(?!\/api).*/,(_,res)=>res.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🚀 PIPEPED :${PORT}`);
  console.log(`   Clicksign: ${process.env.CLICKSIGN_TOKEN?'✅':'⚠️ modo demo'}`);
  console.log(`   Drive: ${DRIVE_ENABLED?'✅':'⚠️ não configurado'}\n`);
});
