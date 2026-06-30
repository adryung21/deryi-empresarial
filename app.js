import { firebaseConfig, APP_NAME, SUPPORT_EMAILS, LOCK_TIMEOUT_MS } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  updatePassword,
  sendPasswordResetEmail,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore,
  enableIndexedDbPersistence,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  writeBatch,
  runTransaction,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const $ = id => document.getElementById(id);
const getValue = (id, fallback = '') => {
  const node = $(id);
  return node ? node.value : fallback;
};
const nf = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 2 });
const dtf = new Intl.DateTimeFormat('es-EC', { dateStyle: 'short', timeStyle: 'short' });
const appVersion = 'Multiempresa v1.9.1 PDF marca de agua - 2026-06-30';

let app, auth, db;
let unsubscribers = [];
let heartbeatTimer = null;
let userHeartbeatTimer = null;
let deferredInstallPrompt = null;
let pendingAuthSetup = false;
let factorModalRowId = null;
const countSaveTimers = new Map();

const state = {
  user: null,
  profile: null,
  companyId: null,
  company: null,
  isSupport: false,
  supportCompanies: {},
  inventory: [],
  counts: {},
  locks: {},
  allowedUsers: {},
  registeredUsers: {},
  meta: {},
  activeLab: '',
  showOnlyDiff: false
};

function setupFirebase() {
  const placeholder = Object.values(firebaseConfig).some(v => String(v || '').startsWith('REEMPLAZAR'));
  if (placeholder) {
    $('setupWarning').classList.remove('hidden');
    $('setupWarning').textContent = 'Falta configurar Firebase. Abre firebase-config.js y reemplaza los valores del proyecto antes de publicar.';
    return false;
  }
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  setPersistence(auth, browserLocalPersistence).catch(() => {});
  enableIndexedDbPersistence(db).catch(() => {});
  return true;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function labKey(lab) {
  return normalizeKey(lab).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'sin_laboratorio';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const s = String(value ?? '').trim();
  if (!s) return 0;
  const cleaned = s.replace(/\s/g, '').replace(/,/g, '.').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function productId(row) {
  return 'p_' + hashString(`${normalizeKey(row.codigo)}|${normalizeKey(row.descripcion)}|${normalizeKey(row.laboratorio)}`);
}

function cleanCompanyCode(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function cleanUsername(value) {
  return normalizeText(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 32);
}

function cleanNamePart(value) {
  return normalizeText(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function fullAdminName(data = {}) {
  return [data.firstName, data.secondName, data.paternalSurname, data.maternalSurname]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function validateAdminIdentity(data = {}) {
  const firstName = normalizeText(data.firstName);
  const secondName = normalizeText(data.secondName);
  const paternalSurname = normalizeText(data.paternalSurname);
  const maternalSurname = normalizeText(data.maternalSurname);
  if (!cleanNamePart(firstName) || !cleanNamePart(secondName) || !cleanNamePart(paternalSurname) || !cleanNamePart(maternalSurname)) {
    throw new Error('Debes llenar primer nombre, segundo nombre, apellido paterno y apellido materno para generar el usuario.');
  }
  const documentType = normalizeText(data.documentType || 'CEDULA').toUpperCase();
  const rawDocument = normalizeText(data.documentNumber || '').toUpperCase();
  let documentNumber = rawDocument.replace(/\s+/g, '');
  if (documentType === 'CEDULA') {
    if (!/^\d{10}$/.test(documentNumber)) throw new Error('La cédula debe tener exactamente 10 dígitos numéricos.');
  } else if (documentType === 'RUC') {
    if (!/^\d{13}$/.test(documentNumber)) throw new Error('El RUC debe tener exactamente 13 dígitos numéricos.');
    if (!documentNumber.endsWith('001')) throw new Error('El RUC debe terminar en 001.');
  } else if (documentType === 'PASAPORTE') {
    if (!/^[A-Z0-9]{3,13}$/.test(documentNumber)) throw new Error('El pasaporte debe tener de 3 a 13 caracteres, solo letras y números, sin espacios ni símbolos.');
  } else {
    throw new Error('Selecciona un tipo de documento válido: Cédula, RUC o Pasaporte.');
  }
  return { firstName, secondName, paternalSurname, maternalSurname, documentType, documentNumber };
}

function generateNicknameBase(data = {}) {
  const first = cleanNamePart(data.firstName);
  const second = cleanNamePart(data.secondName);
  const paternal = cleanNamePart(data.paternalSurname);
  const maternal = cleanNamePart(data.maternalSurname);
  if (!first || !second || !paternal || !maternal) return '';
  return cleanUsername(`${first[0]}${second[0]}${paternal.slice(0, 5)}${maternal[0]}`);
}

async function nicknameExists(username) {
  const clean = cleanUsername(username);
  if (!clean) return true;
  const snap = await getDoc(loginIndexDoc(clean));
  return snap.exists();
}

async function generateAvailableNickname(identity) {
  const base = generateNicknameBase(identity);
  if (!base) throw new Error('No se pudo generar el usuario. Revisa nombres y apellidos.');
  if (!(await nicknameExists(base))) return base;
  const suffix = normalizeText(identity.documentNumber).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 2);
  if (!suffix || suffix.length < 2) throw new Error('No se pudo resolver el usuario duplicado porque el documento no tiene 2 caracteres válidos.');
  const withDoc = cleanUsername(`${base}${suffix}`);
  if (!(await nicknameExists(withDoc))) return withDoc;
  for (let i = 2; i <= 99; i++) {
    const candidate = cleanUsername(`${withDoc}${i}`);
    if (!(await nicknameExists(candidate))) return candidate;
  }
  throw new Error('No se pudo generar un usuario único. Revisa el documento o contacta a soporte.');
}

function internalAuthEmail(companyId, username) {
  const company = cleanCompanyCode(companyId).replace(/[^a-z0-9._-]/g, '').slice(0, 28) || 'empresa';
  const user = cleanUsername(username).slice(0, 28) || 'usuario';
  const local = `${company}.${user}`.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 63);
  return `${local}@deryi.local`;
}

function publicUserEmail(userLike) {
  return normalizeText(userLike?.contactEmail || userLike?.email || '').toLowerCase();
}

function authEmailOfCurrentUser() {
  return normalizeText(state.user?.email || '').toLowerCase();
}

function contactEmailOfCurrentUser() {
  return normalizeText(state.profile?.contactEmail || state.profile?.email || state.user?.email || '').toLowerCase();
}

function makeCompanyId(companyName, email) {
  const base = cleanCompanyCode(companyName) || 'empresa';
  const suffix = hashString(`${companyName}|${email}|${Date.now()}|${Math.random()}`).slice(0, 6);
  return `${base}-${suffix}`.slice(0, 50);
}

function companyRootRef(companyId = state.companyId) {
  if (!companyId) throw new Error('No hay empresa activa.');
  return doc(db, 'companies', companyId);
}

function companyScopedCollection(companyId, name) {
  if (!companyId) throw new Error('No hay empresa activa.');
  return collection(db, 'companies', companyId, name);
}

function companyScopedDoc(companyId, name, id) {
  if (!companyId) throw new Error('No hay empresa activa.');
  return doc(db, 'companies', companyId, name, id);
}

function companyCollection(name) {
  return companyScopedCollection(state.companyId, name);
}

function companyDoc(name, id) {
  return companyScopedDoc(state.companyId, name, id);
}

function userIndexDoc(uid) {
  return doc(db, 'userCompanyIndex', uid);
}

function loginIndexDoc(username) {
  return doc(db, 'loginIndex', cleanUsername(username));
}

function isSupportEmail(email) {
  const lower = normalizeText(email).toLowerCase();
  const list = Array.isArray(SUPPORT_EMAILS) ? SUPPORT_EMAILS : [];
  return list.map(v => normalizeText(v).toLowerCase()).includes(lower);
}

function detectUnitsPerEntero(description) {
  const d = normalizeKey(description).replace(/\s+/g, ' ');
  if (!d) return { units: 1, source: 'Descripción vacía: unidad individual' };
  const measurementUnits = '(?:MG|MCG|UG|G|GR|KG|ML|L|LT|LTR|LTS|CC|UI|IU|U|V|VOL|VOLT|VOLTS|M|CM|MM|OZ|LB|%)';
  const containerWords = '\\b(?:FCO|FRA|FRASCO|FRASCOS|ENV|ENVASE|ENVASES|BOT|BOTELLA|BOTELLAS|AMP|AMPOLLA|AMPOLLAS|VIAL|VIALES|GOTERO|SPRAY|JBE|JARABE|LATA|LATAS)\\b';
  const packWords = '(?:CAJ|CAJA|CJ|DISPLAY|DISP|BLIS|BLISTER|BLI|SOB|SOBRES|SACH|SACHET|PAQ|PQT|PACK|FUNDA|TIRA|TIRAS|ESTUCHE|EST)';
  const patterns = [
    { re: new RegExp('\\b' + packWords + '\\s*(?:X|\\*)\\s*(\\d{1,4})(?!\\s*' + measurementUnits + '\\b)', 'i'), label: 'Empaque detectado' },
    { re: new RegExp('\\b' + packWords + '\\s+(\\d{1,4})(?!\\s*' + measurementUnits + '\\b)', 'i'), label: 'Empaque detectado' },
    { re: new RegExp('(?:^|[\\s\\-/])(?:X|\\*)\\s*(\\d{1,4})(?!\\s*' + measurementUnits + '\\b)', 'i'), label: 'Multiplicador detectado' }
  ];
  for (const p of patterns) {
    const m = d.match(p.re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 1 && n <= 1000) return { units: n, source: `${p.label}: ${m[0].trim()}` };
    }
  }
  if (new RegExp(containerWords, 'i').test(d) || new RegExp('\\b\\d+(?:[.,]\\d+)?\\s*' + measurementUnits + '\\b', 'i').test(d)) {
    return { units: 1, source: 'Unidad individual: frasco/envase/lata/medida' };
  }
  return { units: 1, source: 'No se encontró empaque múltiple' };
}

function calcStock(stockActual, unitsPerEntero) {
  const factor = Math.max(1, parseInt(unitsPerEntero, 10) || 1);
  const sign = stockActual < 0 ? -1 : 1;
  const absStock = Math.abs(stockActual);
  let enteros = Math.floor(absStock);
  let unidades = factor === 1 ? Math.round((absStock - enteros) * 100) / 100 : Math.round((absStock - enteros) * factor);
  if (factor > 1 && unidades >= factor) {
    enteros += Math.floor(unidades / factor);
    unidades = unidades % factor;
  }
  const totalUnits = factor === 1 ? stockActual : sign * ((enteros * factor) + unidades);
  return { enteros: sign * enteros, unidades: sign * unidades, totalUnits: Math.round(totalUnits * 100) / 100 };
}

function enrichRow(row) {
  const factorInfo = row.factorSource === 'Editado manualmente'
    ? { units: row.unitsPerEntero || 1, source: 'Editado manualmente' }
    : detectUnitsPerEntero(row.descripcion);
  const unitsPerEntero = Math.max(1, parseInt(row.unitsPerEntero || factorInfo.units, 10) || 1);
  const calc = calcStock(Number(row.stockActual) || 0, unitsPerEntero);
  return { ...row, id: row.id || productId(row), labKey: labKey(row.laboratorio), unitsPerEntero, factorSource: row.factorSource || factorInfo.source, ...calc };
}

function sortRowsByDescription(rows) {
  return [...rows].sort((a, b) => {
    const byDesc = normalizeText(a.descripcion).localeCompare(normalizeText(b.descripcion), 'es', { sensitivity: 'base', numeric: true });
    if (byDesc !== 0) return byDesc;
    return normalizeText(a.laboratorio).localeCompare(normalizeText(b.laboratorio), 'es', { sensitivity: 'base', numeric: true });
  });
}

function getLabs() {
  return [...new Set(state.inventory.map(r => r.laboratorio).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'es'));
}

function isSupport() {
  return state.isSupport === true || state.profile?.role === 'support';
}

function isAdmin() {
  return ['owner', 'admin'].includes(state.profile?.role || '');
}

function isOwnerEmail(email) {
  return !!email && normalizeText(email).toLowerCase() === normalizeText(state.company?.ownerEmail).toLowerCase();
}

function roleLabel(role) {
  if (role === 'owner') return 'Administrador principal';
  if (role === 'admin') return 'Administrador';
  if (role === 'support') return 'Soporte de plataforma';
  return 'Inventariador';
}

function isLockActive(lock) {
  return lock && lock.status === 'active' && Number(lock.expiresAtMs || 0) > Date.now();
}

function lockForLab(lab) {
  return state.locks[labKey(lab)];
}

function isLabLockedByCurrent(lab) {
  const lock = lockForLab(lab);
  return isLockActive(lock) && lock.lockedByUid === state.user?.uid;
}

function countFor(row) {
  return state.counts[row.id] || {};
}

function hasPhysical(row) {
  const c = countFor(row);
  return c.physicalEnteros !== undefined || c.physicalUnidades !== undefined || c.total !== undefined;
}

function getPhysicalParts(row) {
  const c = countFor(row);
  const e = c.physicalEnteros === undefined || c.physicalEnteros === '' ? '' : Number(c.physicalEnteros);
  const u = c.physicalUnidades === undefined || c.physicalUnidades === '' ? '' : Number(c.physicalUnidades);
  const counted = e !== '' || u !== '' || c.total !== undefined;
  const factor = Number(row.unitsPerEntero) || 1;
  const total = counted ? ((Number(e) || 0) * factor + (Number(u) || 0)) : '';
  return { enteros: e, unidades: u, total, counted };
}

function getDifference(row) {
  const p = getPhysicalParts(row);
  if (!p.counted) return null;
  return Math.round(((Number(p.total) || 0) - (Number(row.totalUnits) || 0)) * 100) / 100;
}

function noveltyText(diff) {
  if (diff === null) return 'Pendiente';
  if (diff < 0) return 'Faltante';
  if (diff > 0) return 'Sobrante';
  return 'Sin diferencia';
}

function fmtDate(ms) {
  if (!ms) return 'Sin conteo registrado';
  try { return dtf.format(new Date(ms)); } catch { return 'Sin conteo registrado'; }
}

function userColorClass(value) {
  const raw = String(value || 'usuario').toLowerCase();
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return 'user-color-' + (Math.abs(hash) % 8);
}

const USER_COLOR_LABELS = ['Azul', 'Verde', 'Amarillo', 'Rosa', 'Morado', 'Celeste', 'Naranja', 'Cian'];
function normalizeColor(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(7, Math.round(n))) : fallback;
}
function userColorFromData(userLike) {
  if (userLike && userLike.color !== undefined && userLike.color !== null && userLike.color !== '') return 'user-color-' + normalizeColor(userLike.color);
  return userColorClass(userLike?.email || userLike?.uid || userLike?.name || 'usuario');
}
function userColorOptions(selected) {
  const s = normalizeColor(selected);
  return USER_COLOR_LABELS.map((label, idx) => `<option value="${idx}" ${idx === s ? 'selected' : ''}>${label}</option>`).join('');
}
function userOnline(data) {
  const last = Number(data?.lastActiveAtMs || data?.lastLoginAtMs || 0);
  return data?.isOnline === true && last && (Date.now() - last < 2 * 60 * 1000);
}

function safeFileName(value) {
  return normalizeKey(value || 'TODOS').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'inventario';
}

function showMessage(el, message, type = 'info') {
  el.className = `notice ${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : type === 'info' ? 'info' : ''}`.trim();
  el.textContent = message;
  el.classList.remove('hidden');
}

function isSamsungInternet() {
  return /SamsungBrowser/i.test(navigator.userAgent || '');
}

function currentAppUrl() {
  return window.location.href.split('#')[0];
}

function showInstallGuidance() {
  const msg = 'Para evitar el bloqueo de Google Play Protect, instala esta PWA desde Google Chrome: abre la misma URL en Chrome, toca el menú ⋮ y elige “Instalar app”. En Samsung Internet algunos dispositivos generan una instalación compatible con Android antiguo y Play Protect la bloquea.';
  const notice = $('installNotice');
  if (notice) {
    notice.textContent = msg;
    notice.classList.remove('hidden');
  }
  alert(msg + '\n\nURL:\n' + currentAppUrl());
}

function prepareInstallButton() {
  const btn = $('installBtn');
  if (!btn) return;
  if (isSamsungInternet()) {
    btn.textContent = 'Instalar desde Chrome';
    btn.classList.remove('hidden');
    const notice = $('installNotice');
    if (notice) {
      notice.textContent = 'En Samsung Internet la instalación puede ser bloqueada por Play Protect. Usa Google Chrome para instalar.';
      notice.classList.remove('hidden');
    }
  }
}

function clearMessage(el) {
  el.classList.add('hidden');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.authTab === tab));
  $('loginForm').classList.toggle('hidden', tab !== 'login');
  $('registerForm').classList.toggle('hidden', tab !== 'register');
  const createCompanyForm = $('createCompanyForm');
  if (createCompanyForm) createCompanyForm.classList.toggle('hidden', tab !== 'company');
  const resetForm = $('resetForm');
  if (resetForm) resetForm.classList.toggle('hidden', tab !== 'reset');
  clearMessage($('authMessage'));
}


function loginIndexEntry(companyId, username, source = {}) {
  return {
    companyId,
    companyName: normalizeText(source.companyName || state.company?.name || companyId),
    username: cleanUsername(username),
    role: source.role || 'inventariador',
    active: source.active !== false,
    updatedAtMs: Date.now()
  };
}

async function upsertLoginIndex(usernameInput, companyIdInput, source = {}) {
  const username = cleanUsername(usernameInput);
  const companyId = cleanCompanyCode(companyIdInput);
  if (!username || !companyId) return;
  const entry = loginIndexEntry(companyId, username, source);
  await setDoc(loginIndexDoc(username), {
    username,
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now(),
    entries: { [companyId]: entry }
  }, { merge: true });
}

async function removeLoginIndexEntry(usernameInput, companyIdInput) {
  const username = cleanUsername(usernameInput);
  const companyId = cleanCompanyCode(companyIdInput);
  if (!username || !companyId) return;
  try {
    await updateDoc(loginIndexDoc(username), {
      [`entries.${companyId}`]: deleteField(),
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now()
    });
  } catch (err) {
    console.warn('No se pudo limpiar índice de ingreso', err);
  }
}

async function findCompaniesForUsername(usernameInput) {
  const username = cleanUsername(usernameInput);
  if (!username) throw new Error('Ingresa tu usuario/nickname para buscar empresas.');
  const snap = await getDoc(loginIndexDoc(username));
  if (!snap.exists()) return [];
  const entries = snap.data().entries || {};
  return Object.values(entries)
    .filter(e => e && e.active !== false && cleanUsername(e.username || username) === username)
    .sort((a, b) => normalizeText(a.companyName || a.companyId).localeCompare(normalizeText(b.companyName || b.companyId), 'es'));
}

function selectedLoginCompanyId() {
  const selected = cleanCompanyCode(getValue('loginSelectedCompanyId'));
  const manual = cleanCompanyCode(getValue('loginCompanyCode'));
  return manual || selected;
}

function clearLoginCompanySelection(keepManual = false) {
  const selected = $('loginSelectedCompanyId');
  const results = $('loginCompanyResults');
  if (selected) selected.value = '';
  if (results) results.innerHTML = '';
  if (!keepManual && $('loginCompanyCode')) $('loginCompanyCode').value = '';
}

function renderLoginCompanyResults(companies, username) {
  const box = $('loginCompanyResults');
  const selected = $('loginSelectedCompanyId');
  if (!box || !selected) return;
  selected.value = '';
  if (!companies.length) {
    box.innerHTML = '<div class="notice warn">No encontré empresas para ese usuario. Revisa el usuario o usa el enlace de invitación. Si es una empresa creada antes de esta versión, usa “Ingresar con código”.</div>';
    return;
  }
  const lastKey = `multi_login_company_${cleanUsername(username)}`;
  let last = '';
  try { last = localStorage.getItem(lastKey) || ''; } catch {}
  const auto = companies.find(c => c.companyId === last) || (companies.length === 1 ? companies[0] : null);
  if (auto) selected.value = auto.companyId;
  box.innerHTML = `
    <div class="login-company-list">
      ${companies.map(c => {
        const active = auto && auto.companyId === c.companyId;
        return `<button class="login-company-option ${active ? 'selected' : ''}" type="button" data-login-company="${escapeHtml(c.companyId)}">
          <strong>${escapeHtml(c.companyName || c.companyId)}</strong>
          <span>${escapeHtml(roleLabel(c.role || 'inventariador'))}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="small">Selecciona la empresa donde quieres ingresar. El rol se aplicará según esa empresa.</div>`;
}

async function searchLoginCompanies() {
  const username = cleanUsername(getValue('loginUsername'));
  const box = $('loginCompanyResults');
  if (!username) return showMessage($('authMessage'), 'Ingresa tu usuario/nickname para buscar empresas.', 'warn');
  if (box) box.innerHTML = '<div class="notice info">Buscando empresas autorizadas...</div>';
  const companies = await findCompaniesForUsername(username);
  renderLoginCompanyResults(companies, username);
  if (companies.length) clearMessage($('authMessage'));
}

async function login(companyCode, username, password) {
  const code = cleanCompanyCode(companyCode);
  const user = cleanUsername(username);
  if (!code || !user || !password) throw new Error('Ingresa usuario, selecciona empresa y escribe contraseña.');
  // Acceso técnico oculto: código "soporte" y correo real como usuario.
  const authEmail = ['soporte', 'support'].includes(code) && String(username).includes('@')
    ? normalizeText(username).toLowerCase()
    : internalAuthEmail(code, user);
  await signInWithEmailAndPassword(auth, authEmail, password);
}

async function sendLoginPasswordReset() {
  throw new Error('Con usuario/nickname, la recuperación simple la gestiona el administrador de la empresa. Pídele que te reenvíe el acceso o que cree un nuevo usuario si olvidaste tu contraseña.');
}

function getAppBaseUrl() {
  const base = `${location.origin}${location.pathname}`;
  return base.replace(/[#?].*$/, '');
}

function createAccessUrl(username = '') {
  const url = new URL(getAppBaseUrl());
  url.searchParams.set('auth', 'register');
  if (state.companyId) url.searchParams.set('company', state.companyId);
  if (username) url.searchParams.set('user', cleanUsername(username));
  return url.toString();
}

function invitationEmailText(user) {
  const name = normalizeText(user?.name) || 'usuario';
  const username = cleanUsername(user?.username || user?.id || '');
  const contactEmail = normalizeText(user?.contactEmail || user?.email).toLowerCase();
  const role = roleLabel(user?.role || 'inventariador');
  const companyName = state.company?.name || 'tu empresa';
  const code = state.companyId || '';
  const link = createAccessUrl(username);
  return `Hola ${name},

Te autorizaron para usar ${APP_NAME} en la empresa ${companyName}.

Empresa: ${companyName}
Código interno de empresa: ${code}
Usuario: ${username}
Rol asignado: ${role}
Correo de contacto: ${contactEmail || '-'}

Para crear tu acceso, abre este enlace:
${link}

El enlace completará la empresa y tu usuario/nickname. Luego crea tu contraseña. Para ingresar después, escribe tu usuario, elige la empresa y coloca tu contraseña.

Este mensaje fue generado desde ${APP_NAME}.`;
}

function invitationMailto(user) {
  const email = normalizeText(user?.contactEmail || user?.email).toLowerCase();
  const subject = `Acceso a ${APP_NAME} - ${state.company?.name || 'Empresa'}`;
  const body = invitationEmailText(user);
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

function applyAuthQueryParams() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('auth') === 'register') {
      switchAuthTab('register');
      const company = params.get('company') || '';
      const user = params.get('user') || params.get('username') || '';
      if ($('registerCompanyCode') && company) $('registerCompanyCode').value = company;
      if ($('registerUsername') && user) $('registerUsername').value = user;
    }
  } catch (err) {
    console.warn('No se pudieron aplicar parámetros de acceso', err);
  }
}

async function createCompany(companyName, adminData, contactEmail, password) {
  const name = normalizeText(companyName);
  const identity = validateAdminIdentity(adminData || {});
  const ownerName = fullAdminName(identity);
  const username = await generateAvailableNickname(identity);
  const contact = normalizeText(contactEmail).toLowerCase();
  if (!name || !ownerName || !username || !contact || !password) throw new Error('Completa empresa, datos del administrador, documento, correo de contacto y contraseña.');
  if (password.length < 6) throw new Error('La contraseña debe tener mínimo 6 caracteres.');
  const companyId = makeCompanyId(name, contact);
  const authEmail = internalAuthEmail(companyId, username);
  pendingAuthSetup = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, authEmail, password);
    const now = Date.now();
    const profile = {
      uid: cred.user.uid,
      name: ownerName,
      firstName: identity.firstName,
      secondName: identity.secondName,
      paternalSurname: identity.paternalSurname,
      maternalSurname: identity.maternalSurname,
      documentType: identity.documentType,
      documentNumber: identity.documentNumber,
      username,
      email: contact,
      contactEmail: contact,
      authEmail,
      role: 'owner',
      color: 0,
      active: true,
      isOnline: true,
      isOwner: true,
      companyId,
      companyName: name,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      lastLoginAt: serverTimestamp(),
      lastLoginAtMs: now,
      lastActiveAt: serverTimestamp(),
      lastActiveAtMs: now
    };
    const batch = writeBatch(db);
    batch.set(doc(db, 'companies', companyId), {
      companyId,
      name,
      ownerUid: cred.user.uid,
      ownerUsername: username,
      ownerAuthEmail: authEmail,
      ownerEmail: contact,
      ownerContactEmail: contact,
      ownerName,
      ownerFirstName: identity.firstName,
      ownerSecondName: identity.secondName,
      ownerPaternalSurname: identity.paternalSurname,
      ownerMaternalSurname: identity.maternalSurname,
      ownerDocumentType: identity.documentType,
      ownerDocumentNumber: identity.documentNumber,
      active: true,
      plan: 'base',
      createdAt: serverTimestamp(),
      createdAtMs: now,
      updatedAt: serverTimestamp(),
      updatedAtMs: now,
      appVersion
    });
    batch.set(companyScopedDoc(companyId, 'users', cred.user.uid), profile);
    batch.set(companyScopedDoc(companyId, 'allowedUsers', username), {
      username,
      name: ownerName,
      firstName: identity.firstName,
      secondName: identity.secondName,
      paternalSurname: identity.paternalSurname,
      maternalSurname: identity.maternalSurname,
      documentType: identity.documentType,
      documentNumber: identity.documentNumber,
      email: contact,
      contactEmail: contact,
      authEmail,
      role: 'owner',
      color: 0,
      active: true,
      uid: cred.user.uid,
      createdByUid: cred.user.uid,
      createdByEmail: contact,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      updatedAt: serverTimestamp(),
      updatedAtMs: now
    });
    batch.set(userIndexDoc(cred.user.uid), {
      uid: cred.user.uid,
      username,
      email: contact,
      contactEmail: contact,
      authEmail,
      name: ownerName,
      role: 'owner',
      active: true,
      companyId,
      companyName: name,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      updatedAt: serverTimestamp(),
      updatedAtMs: now
    });
    batch.set(loginIndexDoc(username), {
      username,
      updatedAt: serverTimestamp(),
      updatedAtMs: now,
      entries: { [companyId]: loginIndexEntry(companyId, username, { companyName: name, name: ownerName, role: 'owner', active: true }) }
    }, { merge: true });
    batch.set(companyScopedDoc(companyId, 'appMeta', 'current'), {
      companyId,
      companyName: name,
      totalSaved: 0,
      skippedZero: 0,
      createdByUid: cred.user.uid,
      createdByEmail: contact,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      appVersion
    }, { merge: true });
    await batch.commit();
    pendingAuthSetup = false;
    await startAppSession(cred.user);
    return { companyId, username };
  } catch (err) {
    pendingAuthSetup = false;
    throw err;
  }
}

async function registerUser(usernameInput, password, companyCode) {
  const companyId = cleanCompanyCode(companyCode);
  const username = cleanUsername(usernameInput);
  if (!companyId) throw new Error('Ingresa el código de empresa que te entregó el administrador.');
  if (!username) throw new Error('Ingresa el usuario/nickname autorizado.');
  if (!password || password.length < 6) throw new Error('La contraseña debe tener mínimo 6 caracteres.');
  const authEmail = internalAuthEmail(companyId, username);
  pendingAuthSetup = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, authEmail, password);
    const allowed = await getAllowedUserForCompany(companyId, username);
    if (!allowed) {
      await signOut(auth);
      throw new Error('Este usuario no está autorizado o está inactivo para esa empresa. Solicita acceso al administrador.');
    }
    const companySnap = await getDoc(doc(db, 'companies', companyId));
    if (!companySnap.exists()) {
      await signOut(auth);
      throw new Error('No se encontró la empresa indicada. Revisa el código de empresa.');
    }
    const company = companySnap.data();
    if (company.active === false) {
      await signOut(auth);
      throw new Error('Esta empresa está inactiva. Contacta a soporte.');
    }
    const contact = normalizeText(allowed.contactEmail || allowed.email).toLowerCase();
    const now = Date.now();
    const profile = {
      uid: cred.user.uid,
      username,
      name: allowed.name || username,
      email: contact,
      contactEmail: contact,
      authEmail,
      role: allowed.role === 'owner' ? 'admin' : (allowed.role || 'inventariador'),
      color: normalizeColor(allowed.color, 0),
      active: allowed.active !== false,
      companyId,
      companyName: company.name || companyId,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      lastLoginAt: serverTimestamp(),
      lastLoginAtMs: now,
      lastActiveAt: serverTimestamp(),
      lastActiveAtMs: now,
      isOnline: true
    };
    const batch = writeBatch(db);
    batch.set(companyScopedDoc(companyId, 'users', cred.user.uid), profile, { merge: true });
    batch.set(companyScopedDoc(companyId, 'allowedUsers', username), { uid: cred.user.uid, authEmail, registeredAt: serverTimestamp(), registeredAtMs: now }, { merge: true });
    batch.set(loginIndexDoc(username), {
      username,
      updatedAt: serverTimestamp(),
      updatedAtMs: now,
      entries: { [companyId]: loginIndexEntry(companyId, username, { companyName: company.name || companyId, name: profile.name, role: profile.role, active: profile.active }) }
    }, { merge: true });
    batch.set(userIndexDoc(cred.user.uid), {
      uid: cred.user.uid,
      username,
      email: contact,
      contactEmail: contact,
      authEmail,
      name: profile.name,
      role: profile.role,
      active: profile.active,
      companyId,
      companyName: company.name || companyId,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      updatedAt: serverTimestamp(),
      updatedAtMs: now
    }, { merge: true });
    await batch.commit();
    pendingAuthSetup = false;
    await startAppSession(cred.user);
  } catch (err) {
    pendingAuthSetup = false;
    throw err;
  }
}

async function getAllowedUserForCompany(companyId, usernameInput) {
  const username = cleanUsername(usernameInput);
  const snap = await getDoc(companyScopedDoc(companyId, 'allowedUsers', username));
  if (!snap.exists()) return null;
  const data = snap.data();
  if (data.active === false) return null;
  return { ...data, username };
}

async function ensureProfile(user) {
  const authEmail = normalizeText(user.email).toLowerCase();
  state.companyId = null;
  state.company = null;
  state.isSupport = false;

  if (isSupportEmail(authEmail)) {
    state.isSupport = true;
    return {
      uid: user.uid,
      name: user.displayName || authEmail.split('@')[0],
      username: authEmail.split('@')[0],
      email: authEmail,
      contactEmail: authEmail,
      authEmail,
      role: 'support',
      active: true,
      color: 0,
      isOnline: true,
      lastLoginAtMs: Date.now(),
      lastActiveAtMs: Date.now()
    };
  }

  const indexSnap = await getDoc(userIndexDoc(user.uid));
  if (!indexSnap.exists()) throw new Error('Usuario autenticado, pero sin empresa asociada. Si eres usuario invitado, crea acceso con el código de empresa y tu usuario.');
  const index = indexSnap.data();
  if (index.active === false) throw new Error('Tu acceso está inactivo. Solicita activación al administrador de tu empresa.');

  const companyId = cleanCompanyCode(index.companyId);
  if (!companyId) throw new Error('Tu usuario no tiene código de empresa válido.');
  const companySnap = await getDoc(doc(db, 'companies', companyId));
  if (!companySnap.exists()) throw new Error('No se encontró la empresa asociada a tu usuario.');
  const company = { id: companyId, ...companySnap.data() };
  if (company.active === false) throw new Error('La empresa está inactiva. Contacta a soporte.');

  state.companyId = companyId;
  state.company = company;

  const ref = companyScopedDoc(companyId, 'users', user.uid);
  const userSnap = await getDoc(ref);
  const existing = userSnap.exists() ? userSnap.data() : {};
  if (existing.active === false) throw new Error('Tu usuario está inactivo. Solicita activación al administrador.');

  const username = cleanUsername(existing.username || index.username || authEmail.split('@')[0]);
  const contact = normalizeText(existing.contactEmail || existing.email || index.contactEmail || index.email || '').toLowerCase();
  const role = existing.role || index.role || 'inventariador';
  const profile = {
    uid: user.uid,
    username,
    name: existing.name || index.name || user.displayName || username,
    email: contact || authEmail,
    contactEmail: contact || authEmail,
    authEmail,
    role,
    color: normalizeColor(existing.color, normalizeColor(index.color, 0)),
    active: true,
    companyId,
    companyName: company.name || companyId,
    lastLoginAt: serverTimestamp(),
    lastLoginAtMs: Date.now(),
    lastActiveAt: serverTimestamp(),
    lastActiveAtMs: Date.now(),
    isOnline: true
  };
  if (!userSnap.exists()) {
    profile.createdAt = serverTimestamp();
    profile.createdAtMs = Date.now();
  }
  await setDoc(ref, profile, { merge: true });
  await setDoc(userIndexDoc(user.uid), {
    uid: user.uid,
    username,
    email: profile.email,
    contactEmail: profile.contactEmail,
    authEmail,
    name: profile.name,
    role: profile.role,
    active: true,
    companyId,
    companyName: profile.companyName,
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now()
  }, { merge: true });
  return { ...existing, ...profile };
}

function canAccessTab(tab) {
  const support = isSupport();
  if (support) return tab === 'soporte';
  if (tab === 'soporte') return false;
  if (['carga', 'usuarios'].includes(tab)) return isAdmin();
  return ['vista', 'generacion'].includes(tab);
}

function setElementVisible(el, visible) {
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (!visible) el.classList.remove('active');
}

function setVersionLabels() {
  ['sideAppVersion', 'authAppVersion'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = appVersion;
  });
}

function applyRoleUI() {
  const support = isSupport();
  const admin = isAdmin() && !support;

  document.body.classList.toggle('support-user', support);
  document.body.classList.toggle('admin-user', admin);
  document.body.classList.toggle('inventory-user', !admin && !support);

  // Botones del menú: se remueven visualmente para inventariadores.
  // No dependemos solo de CSS, porque en móviles/caché puede quedar una vista vieja visible.
  document.querySelectorAll('.tab-btn[data-tab="carga"], .tab-btn[data-tab="usuarios"]').forEach(el => setElementVisible(el, admin));
  document.querySelectorAll('.tab-btn[data-tab="vista"], .tab-btn[data-tab="generacion"]').forEach(el => setElementVisible(el, !support));
  document.querySelectorAll('.tab-btn[data-tab="soporte"]').forEach(el => setElementVisible(el, support));

  document.querySelectorAll('.admin-panel').forEach(el => setElementVisible(el, admin));
  document.querySelectorAll('.support-only:not(.tab-btn)').forEach(el => setElementVisible(el, support));
  document.querySelectorAll('.company-only:not(.tab-btn)').forEach(el => setElementVisible(el, !support));

  $('sideUserName').textContent = state.profile?.name || '-';
  $('sideUserEmail').textContent = state.profile?.username ? `${state.profile.username} · ${state.profile.contactEmail || state.profile.email || '-'}` : (state.profile?.email || '-');
  $('sideUserRole').textContent = support ? 'Soporte de plataforma' : roleLabel(state.profile?.role);
  const companyEl = $('sideCompanyName');
  if (companyEl) companyEl.textContent = support ? 'Panel de soporte' : (state.company?.name || 'Sin empresa');
  setVersionLabels();
  if (support) {
    switchTab('soporte');
    return;
  }
  const activePanel = document.querySelector('.panel.active');
  const activeTab = activePanel ? activePanel.id.replace('tab-', '') : '';
  if (!canAccessTab(activeTab)) switchTab(admin ? 'carga' : 'vista');
}

function switchTab(tab) {
  if (!canAccessTab(tab)) tab = isSupport() ? 'soporte' : (isAdmin() ? 'carga' : 'vista');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panel = $('tab-' + tab);
  if (panel) panel.classList.add('active');
  renderAll();
  setSideMenu(false);
}

function setSideMenu(open) {
  $('sideNav').classList.toggle('open', open);
  $('sideNavEdge').classList.toggle('open', open);
  $('sideNav').setAttribute('aria-hidden', open ? 'false' : 'true');
  $('sideNavEdge').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setSectionCollapsed(targetId, collapsed) {
  const section = $(targetId);
  const button = document.querySelector(`[data-toggle-section="${targetId}"]`);
  if (!section || !button) return;
  section.classList.toggle('collapsed', collapsed);
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const icon = button.querySelector('.toggle-icon');
  const label = button.querySelector('.toggle-text');
  if (icon) icon.textContent = collapsed ? '▸' : '▾';
  if (label) label.textContent = collapsed ? (button.dataset.labelShow || 'Mostrar') : (button.dataset.labelHide || 'Ocultar');
  try { localStorage.setItem('multiinventario_ui_' + targetId, collapsed ? '1' : '0'); } catch {}
}

function applyCollapsePrefs() {
  ['adminViewControls', 'viewControls', 'genControls', 'usersCreateBox'].forEach(id => {
    let collapsed = false;
    try { collapsed = localStorage.getItem('multiinventario_ui_' + id) === '1'; } catch {}
    setSectionCollapsed(id, collapsed);
  });
}

function attachRealtimeListeners() {
  unsubscribers.forEach(fn => fn());
  unsubscribers = [];
  if (isSupport()) {
    unsubscribers.push(onSnapshot(collection(db, 'companies'), snap => {
      state.supportCompanies = Object.fromEntries(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
      renderSupport();
    }));
    return;
  }
  if (!state.companyId) return;
  unsubscribers.push(onSnapshot(companyCollection('inventory'), snap => {
    state.inventory = sortRowsByDescription(snap.docs.map(d => enrichRow({ id: d.id, ...d.data() })));
    renderAll();
  }));
  unsubscribers.push(onSnapshot(companyCollection('counts'), snap => {
    state.counts = Object.fromEntries(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    renderAll();
  }));
  unsubscribers.push(onSnapshot(companyCollection('labLocks'), snap => {
    state.locks = Object.fromEntries(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    renderAll();
  }));
  unsubscribers.push(onSnapshot(companyDoc('appMeta', 'current'), snap => {
    state.meta = snap.exists() ? snap.data() : {};
    renderAll();
  }));
  if (isAdmin()) {
    unsubscribers.push(onSnapshot(query(companyCollection('allowedUsers'), orderBy('username')), snap => {
      state.allowedUsers = Object.fromEntries(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
      scheduleLoginIndexSync();
      renderUsers();
    }));
    unsubscribers.push(onSnapshot(companyCollection('users'), snap => {
      state.registeredUsers = Object.fromEntries(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
      const self = state.user ? state.registeredUsers[state.user.uid] : null;
      if (self && self.active === false) { alert('Tu usuario fue desactivado.'); signOut(auth); return; }
      renderUsers();
    }));
  }
}

function renderSupport() {
  const body = $('supportCompaniesBody');
  if (!body) return;
  const companies = Object.values(state.supportCompanies || {}).sort((a,b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  const totalEl = $('sCompanies');
  if (totalEl) totalEl.textContent = nf.format(companies.length);
  if (!companies.length) {
    body.innerHTML = '<div class="inventory-card-empty">Todavía no hay empresas registradas.</div>';
    return;
  }
  body.innerHTML = companies.map(c => `<article class="user-card">
    <div class="user-card-main">
      <div class="user-avatar user-color-0">${escapeHtml((c.name || '?').slice(0,1).toUpperCase())}</div>
      <div class="user-info">
        <div class="user-title-row"><strong>${escapeHtml(c.name || c.id)}</strong><span class="state-pill ${c.active === false ? 'inactive' : 'active'}">${c.active === false ? 'Inactiva' : 'Activa'}</span></div>
        <div class="user-email">Código empresa: <strong>${escapeHtml(c.id || c.companyId || '')}</strong></div>
        <div class="user-meta"><span>Administrador principal: ${escapeHtml(c.ownerName || '-')} · ${escapeHtml(c.ownerEmail || '-')}</span></div>
      </div>
    </div>
    <div class="user-stats-row">
      <div><span>Creada</span><strong>${escapeHtml(fmtDate(c.createdAtMs))}</strong></div>
      <div><span>Plan</span><strong>${escapeHtml(c.plan || 'base')}</strong></div>
      <div><span>Versión</span><strong>${escapeHtml(c.appVersion || '-')}</strong></div>
    </div>
  </article>`).join('');
}

function populateLabOptions() {
  $('labOptions').innerHTML = getLabs().map(l => `<option value="${escapeHtml(l)}"></option>`).join('');
}

function getLabSummary() {
  const map = new Map();
  for (const row of state.inventory) {
    const key = row.labKey;
    if (!map.has(key)) {
      map.set(key, {
        key,
        lab: row.laboratorio,
        total: 0,
        counted: 0,
        missing: 0,
        surplus: 0,
        lastMs: 0,
        lastUserName: '',
        lastUserEmail: '',
        lastUserUid: '',
        lastUserColor: ''
      });
    }
    const item = map.get(key);
    item.total++;
    const c = state.counts[row.id];
    if (c) {
      item.counted++;
      const updatedAtMs = Number(c.updatedAtMs || 0);
      if (updatedAtMs >= (item.lastMs || 0)) {
        item.lastMs = updatedAtMs;
        item.lastUserName = c.updatedByName || '';
        item.lastUserEmail = c.updatedByEmail || '';
        item.lastUserUid = c.updatedByUid || '';
        item.lastUserColor = c.updatedByColor ?? '';
      }
      const diff = getDifference(row);
      if (diff < 0) item.missing++;
      if (diff > 0) item.surplus++;
    }
  }
  return [...map.values()].sort((a,b) => a.lab.localeCompare(b.lab, 'es'));
}

function renderMetrics() {
  $('mItems').textContent = nf.format(state.inventory.length);
  $('mLabs').textContent = nf.format(getLabs().length);
  $('mCounts').textContent = nf.format(Object.keys(state.counts).length);
  $('mSkipped').textContent = nf.format(state.meta.skippedZero || 0);
  if (state.meta.fileName) {
    $('loadMessage').className = 'notice';
    $('loadMessage').textContent = `Archivo cargado: ${state.meta.fileName}. Guardados: ${nf.format(state.inventory.length)}. Eliminados por stock cero: ${nf.format(state.meta.skippedZero || 0)}.`;
  }
}

function buildLabListHtml() {
  const labs = getLabSummary();
  if (!labs.length) {
    return '<div class="inventory-card-empty">Cuando se cargue inventario aparecerá aquí la lista de laboratorios.</div>';
  }
  return labs.map(l => {
    const lock = state.locks[l.key];
    const locked = isLockActive(lock) && lock.lockedByUid !== state.user?.uid;
    const mine = isLockActive(lock) && lock.lockedByUid === state.user?.uid;
    const complete = l.total > 0 && l.counted >= l.total;
    const cls = complete ? 'complete' : locked ? 'locked' : '';
    const status = complete ? 'Completo' : locked ? `En proceso por ${escapeHtml(lock.userName || lock.userEmail || 'usuario')}` : mine ? 'En proceso por ti' : `${l.counted} / ${l.total}`;
    const sub = complete ? 'Inventario finalizado' : locked ? 'Laboratorio bloqueado temporalmente' : 'Tocar para generar inventario';
    const userLabel = l.lastUserName || l.lastUserEmail || '';
    const colorClass = l.lastUserColor !== '' ? 'user-color-' + normalizeColor(l.lastUserColor) : userColorClass(l.lastUserEmail || l.lastUserUid || l.lastUserName || l.lab);
    const userHtml = userLabel
      ? `<div class="lab-user-line">Último usuario: <span class="user-chip ${colorClass}">${escapeHtml(userLabel)}</span></div>`
      : '<div class="lab-user-line no-user">Usuario: sin registro</div>';
    return `<button class="lab-card ${cls}" type="button" data-lab-open="${escapeHtml(l.lab)}">
      <div>
        <div class="lab-name">${escapeHtml(l.lab)}</div>
        <div class="lab-sub">${sub}</div>
        <div class="lab-date">Último conteo: ${escapeHtml(fmtDate(l.lastMs))}</div>
        ${userHtml}
      </div>
      <div class="lab-stats">
        <div><div class="lab-badge-label">Productos</div><div class="lab-badge">${nf.format(l.total)}</div></div>
        <div><div class="lab-badge-label">Estado</div><div class="lab-badge state">${status}</div></div>
      </div>
    </button>`;
  }).join('');
}

function renderLabList() {
  const html = buildLabListHtml();
  ['labList', 'viewLabList'].forEach(id => {
    const box = $(id);
    if (box) box.innerHTML = html;
  });
}

function rowMatches(row, query) {
  const q = normalizeKey(query);
  if (!q) return true;
  return [row.codigo, row.descripcion, row.laboratorio, row.stockActual, row.unitsPerEntero, row.enteros, row.unidades, row.totalUnits]
    .some(v => normalizeKey(v).includes(q));
}

function filteredAdminRows() {
  const lab = normalizeKey(getValue('adminViewLab'));
  const desc = normalizeKey(getValue('adminViewDesc'));
  const any = getValue('adminViewAny');
  return sortRowsByDescription(state.inventory.filter(r => {
    if (lab && !normalizeKey(r.laboratorio).includes(lab)) return false;
    if (desc && !normalizeKey(r.descripcion).includes(desc)) return false;
    if (!rowMatches(r, any)) return false;
    return true;
  }));
}

function renderAdminInventory() {
  const body = $('adminViewCards');
  if (!body) return;
  const rows = filteredAdminRows();
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  setText('aItems', nf.format(rows.length));
  setText('aTotalUnits', nf.format(rows.reduce((s,r) => s + (Number(r.totalUnits) || 0), 0)));
  setText('aEnteros', nf.format(rows.reduce((s,r) => s + (Number(r.enteros) || 0), 0)));
  setText('aUnidades', nf.format(rows.reduce((s,r) => s + (Number(r.unidades) || 0), 0)));
  if (!state.inventory.length) {
    body.innerHTML = '<div class="inventory-card-empty">Carga primero un archivo de inventario.</div>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="inventory-card-empty">No hay resultados con los filtros actuales.</div>';
    return;
  }
  body.innerHTML = rows.map(r => `
    <article class="inventory-item-card">
      <div class="inventory-item-title">${escapeHtml(r.descripcion)}</div>
      <div class="inventory-item-meta">Lab: ${escapeHtml(r.laboratorio)} · Stock actual: ${nf.format(r.stockActual)}</div>
      <div class="inventory-system-panel system-panel">
        <div class="system-label">Sistema</div>
        <div class="system-values">
          <span class="system-chip"><strong>${nf.format(r.enteros)}</strong> ent</span>
          <span class="system-chip"><strong>${nf.format(r.unidades)}</strong> unid</span>
          <span class="system-chip total"><strong>${nf.format(r.totalUnits)}</strong> total</span>
        </div>
        <div class="factor-row"><span>Unid/Entero: <strong>${nf.format(r.unitsPerEntero)}</strong></span>${isAdmin() ? factorEditButton(r) : ''}</div>
        <div class="factor-source">Detección: ${escapeHtml(r.factorSource || 'Sin detalle')}</div>
      </div>
    </article>`).join('');
}

function renderView() {
  // La pestaña Vista ahora muestra laboratorios para todos los usuarios.
  // El detalle de productos se movió a Carga de inventario, solo para administrador.
  renderLabList();
}

function filteredGenerationRows() {
  const lab = normalizeKey(getValue('genLab', state.activeLab) || state.activeLab);
  const query = getValue('genSearch');
  let rows = sortRowsByDescription(state.inventory.filter(r => {
    if (lab && !normalizeKey(r.laboratorio).includes(lab)) return false;
    if (query && !rowMatches(r, query)) return false;
    return true;
  }));
  if (state.showOnlyDiff) rows = rows.filter(r => getDifference(r) !== 0 && hasPhysical(r));
  return rows;
}

function selectedExactLab() {
  const input = normalizeKey(getValue('genLab', state.activeLab) || state.activeLab);
  if (!input) return '';
  const exact = getLabs().find(l => normalizeKey(l) === input);
  if (exact) return exact;
  const starts = getLabs().find(l => normalizeKey(l).startsWith(input));
  return starts || '';
}

function diffClass(diff) {
  if (diff === null) return '';
  if (diff < 0) return 'diff-negative';
  if (diff > 0) return 'diff-positive';
  return 'diff-zero';
}

function diffInline(diff) {
  if (diff === null) return '<span class="pending">Diferencia: -</span>';
  if (diff < 0) return `<span class="neg">Diferencia: ${nf.format(diff)} · Faltante</span>`;
  if (diff > 0) return `<span class="pos">Diferencia: ${nf.format(diff)} · Sobrante</span>`;
  return '<span class="zero">Diferencia: 0 · Sin diferencia</span>';
}

function renderGeneration() {
  const rows = filteredGenerationRows();
  const lab = selectedExactLab();
  const body = $('genBody');
  const counted = rows.filter(r => hasPhysical(r));
  $('gItems').textContent = nf.format(rows.length);
  $('gCounted').textContent = nf.format(counted.length);
  $('gMissing').textContent = nf.format(counted.filter(r => getDifference(r) < 0).length);
  $('gSurplus').textContent = nf.format(counted.filter(r => getDifference(r) > 0).length);

  renderLockBanner(lab);

  if (!state.inventory.length) {
    body.innerHTML = '<div class="inventory-card-empty">El administrador debe cargar un inventario.</div>';
    return;
  }
  if (!lab) {
    body.innerHTML = '<div class="inventory-card-empty">Selecciona o escribe un laboratorio exacto para generar inventario.</div>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="inventory-card-empty">No hay productos para el filtro actual.</div>';
    return;
  }
  const canEdit = isLabLockedByCurrent(lab);
  const otherLock = isLockActive(lockForLab(lab)) && !canEdit;
  body.innerHTML = rows.map(r => generationCard(r, canEdit, otherLock)).join('');
}

function generationCard(r, canEdit, otherLock) {
  const parts = getPhysicalParts(r);
  const diff = getDifference(r);
  const cls = diffClass(diff);
  const c = countFor(r);
  const disabled = canEdit ? '' : 'disabled';
  const lockNote = otherLock ? 'Bloqueado por otro usuario' : canEdit ? 'Editable' : 'Toma el laboratorio para editar';
  return `<article class="gen-product-card" data-row-id="${escapeHtml(r.id)}">
    <div class="gen-product-title">${escapeHtml(r.descripcion)}</div>
    <div class="gen-card-body">
      <div class="system-panel">
        <div class="system-label">Sistema</div>
        <div class="system-values">
          <span class="system-chip"><strong>${nf.format(r.enteros)}</strong> ent</span>
          <span class="system-chip"><strong>${nf.format(r.unidades)}</strong> unid</span>
          <span class="system-chip total"><strong>${nf.format(r.totalUnits)}</strong> total</span>
        </div>
        <div class="factor-row"><span>Unid/Entero: <strong>${nf.format(r.unitsPerEntero)}</strong></span>${isAdmin() ? factorEditButton(r) : ''}</div>
        <div class="factor-source">Detección: ${escapeHtml(r.factorSource || 'Sin detalle')}</div>
        <div class="diff-inline">${diffInline(diff)}</div>
      </div>
      <div class="physical-panel">
        <div class="physical-label">Conteo físico</div>
        <div class="physical-inputs">
          <div class="physical-input-group"><label>Enteros</label><input class="count-input ${cls}" type="tel" inputmode="numeric" pattern="[0-9]*" data-row-id="${escapeHtml(r.id)}" data-count-kind="enteros" value="${parts.enteros === '' ? '' : Number(parts.enteros)}" oninput="window.deryiHandleCountInput && window.deryiHandleCountInput(this)" onchange="window.deryiHandleCountCommit && window.deryiHandleCountCommit(this)" onblur="window.deryiHandleCountCommit && window.deryiHandleCountCommit(this)" ${disabled}></div>
          <div class="physical-input-group"><label>Unidades</label><input class="count-input ${cls}" type="tel" inputmode="numeric" pattern="[0-9]*" data-row-id="${escapeHtml(r.id)}" data-count-kind="unidades" value="${parts.unidades === '' ? '' : Number(parts.unidades)}" oninput="window.deryiHandleCountInput && window.deryiHandleCountInput(this)" onchange="window.deryiHandleCountCommit && window.deryiHandleCountCommit(this)" onblur="window.deryiHandleCountCommit && window.deryiHandleCountCommit(this)" ${disabled}></div>
        </div>
        <div class="physical-total-row"><span>Total físico</span><span class="count-total-value ${cls}">${parts.counted ? nf.format(parts.total) : '-'}</span></div>
        <div class="count-meta">${escapeHtml(lockNote)}${c.updatedByName ? `<br>Último: ${escapeHtml(c.updatedByName)} · ${escapeHtml(fmtDate(c.updatedAtMs))}` : ''}</div>
      </div>
    </div>
  </article>`;
}

function factorEditButton(row) {
  return `<button type="button" class="factor-edit-btn" data-factor-edit="${escapeHtml(row.id)}">Editar</button>`;
}

function renderLockBanner(lab) {
  const banner = $('lockBanner');
  if (!lab) {
    banner.className = 'notice info lock-banner';
    banner.textContent = 'Selecciona un laboratorio para iniciar.';
    return;
  }
  const lock = lockForLab(lab);
  if (isLabLockedByCurrent(lab)) {
    banner.className = 'notice lock-banner';
    banner.textContent = `Laboratorio en proceso por ti. Se libera al finalizar, al salir o por 10 minutos sin actividad.`;
  } else if (isLockActive(lock)) {
    banner.className = 'notice warn lock-banner';
    banner.textContent = `Laboratorio bloqueado por ${lock.userName || lock.userEmail || 'otro usuario'}. Última actividad: ${fmtDate(lock.updatedAtMs)}.`;
  } else {
    banner.className = 'notice info lock-banner';
    banner.textContent = 'Laboratorio disponible. Pulsa “Tomar laboratorio” para bloquearlo y registrar conteos.';
  }
}


let loginIndexSyncTimer = null;
function scheduleLoginIndexSync() {
  if (!isAdmin() || !state.companyId) return;
  if (loginIndexSyncTimer) clearTimeout(loginIndexSyncTimer);
  loginIndexSyncTimer = setTimeout(() => {
    syncCompanyLoginIndex().catch(err => console.warn('No se pudo sincronizar índice de ingreso', err));
  }, 1200);
}

async function syncCompanyLoginIndex() {
  if (!isAdmin() || !state.companyId) return;
  const users = Object.values(state.allowedUsers || {});
  for (const u of users) {
    const username = cleanUsername(u.username || u.id || '');
    if (!username || u.active === false) continue;
    await upsertLoginIndex(username, state.companyId, {
      companyName: state.company?.name || state.companyId,
      name: u.name || username,
      role: u.role || 'inventariador',
      active: u.active !== false
    });
  }
}

function registeredByUsername() {
  const byUser = new Map();
  for (const u of Object.values(state.registeredUsers || {})) {
    const username = cleanUsername(u.username || '');
    if (username) byUser.set(username, u);
  }
  return byUser;
}

function countStatsForUser(username, email, uid) {
  const user = cleanUsername(username || '');
  const e = String(email || '').toLowerCase();
  const list = Object.values(state.counts || {}).filter(c => {
    const ce = String(c.updatedByEmail || c.updatedByContactEmail || '').toLowerCase();
    const cu = cleanUsername(c.updatedByUsername || '');
    return (uid && c.updatedByUid === uid) || (user && cu === user) || (e && ce === e);
  }).sort((a,b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0));
  return { total: list.length, last: list[0] || null, list };
}

function mergedUsers() {
  const byUser = registeredByUsername();
  const map = new Map();
  for (const a of Object.values(state.allowedUsers || {})) {
    const username = cleanUsername(a.username || a.id || '');
    if (!username) continue;
    const contactEmail = normalizeText(a.contactEmail || a.email || '').toLowerCase();
    map.set(username, { ...a, username, email: contactEmail, contactEmail, registered: byUser.get(username) || null });
  }
  for (const r of byUser.values()) {
    const username = cleanUsername(r.username || '');
    if (!username || map.has(username)) continue;
    const contactEmail = normalizeText(r.contactEmail || r.email || '').toLowerCase();
    map.set(username, { name: r.name, username, email: contactEmail, contactEmail, role: r.role, active: r.active, color: r.color, registered: r, onlyRegistered: true });
  }
  return [...map.values()].sort((a,b) => (a.name || a.username || '').localeCompare(b.name || b.username || '', 'es'));
}

function renderUsers() {
  const body = $('usersBody');
  if (!body) return;
  const queryText = normalizeKey(getValue('userSearch'));
  let users = mergedUsers();
  if (queryText) {
    users = users.filter(u => normalizeKey([u.name, u.username, u.contactEmail, u.email, u.role, u.active === false ? 'inactivo' : 'activo', u.registered ? 'registrado' : 'pendiente'].join(' ')).includes(queryText));
  }
  const total = mergedUsers();
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = nf.format(value); };
  setText('uTotal', total.length);
  setText('uActive', total.filter(u => u.active !== false).length);
  setText('uOnline', total.filter(u => userOnline(u.registered)).length);
  setText('uAdmins', total.filter(u => ['admin','owner'].includes(u.role || '')).length);

  if (!users.length) {
    body.innerHTML = '<div class="inventory-card-empty">No hay usuarios autorizados con ese filtro.</div>';
    return;
  }

  body.innerHTML = users.map(u => {
    const username = cleanUsername(u.username || u.id || '');
    const email = normalizeText(u.contactEmail || u.email || '').toLowerCase();
    const registered = u.registered || null;
    const active = u.active !== false && registered?.active !== false;
    const online = userOnline(registered);
    const stats = countStatsForUser(username, email, registered?.uid || registered?.id);
    const color = normalizeColor(u.color ?? registered?.color, 0);
    const colorClass = 'user-color-' + color;
    const role = u.role || registered?.role || 'inventariador';
    const isMainAdmin = role === 'owner';
    const lastAccess = registered?.lastLoginAtMs ? fmtDate(registered.lastLoginAtMs) : 'Sin ingreso registrado';
    const lastActive = registered?.lastActiveAtMs ? fmtDate(registered.lastActiveAtMs) : 'Sin actividad registrada';
    const lastCount = stats.last?.updatedAtMs ? fmtDate(stats.last.updatedAtMs) : 'Sin conteos';
    return `<article class="user-card ${active ? '' : 'inactive'}" data-user-username="${escapeHtml(username)}" data-user-email="${escapeHtml(email)}" data-user-auth-email="${escapeHtml(u.authEmail || registered?.authEmail || '')}" data-user-uid="${escapeHtml(registered?.uid || registered?.id || '')}">
      <div class="user-card-main">
        <div class="user-avatar ${colorClass}">${escapeHtml((u.name || username || '?').slice(0,1).toUpperCase())}</div>
        <div class="user-info">
          <div class="user-title-row">
            <input class="user-name-input" data-user-field="name" value="${escapeHtml(u.name || registered?.name || '')}" ${isMainAdmin ? 'readonly' : ''} />
            <span class="online-pill ${online ? 'online' : ''}">${online ? 'En línea' : 'Fuera de línea'}</span>
          </div>
          <div class="user-email">Usuario: <strong>${escapeHtml(username)}</strong>${email ? ` · Contacto: ${escapeHtml(email)}` : ''}</div>
          ${(u.documentType || registered?.documentType || u.documentNumber || registered?.documentNumber) ? `<div class="user-email">Documento: <strong>${escapeHtml(u.documentType || registered?.documentType || '')}</strong> ${escapeHtml(u.documentNumber || registered?.documentNumber || '')}</div>` : ''}
          <div class="user-meta">
            <span class="role-pill ${['admin','owner'].includes(role) ? 'admin' : ''}">${escapeHtml(roleLabel(role))}</span>
            <span class="state-pill ${active ? 'active' : 'inactive'}">${active ? 'Activo' : 'Inactivo'}</span>
            <span class="state-pill ${registered ? 'registered' : 'pending'}">${registered ? 'Registrado' : 'Pendiente'}</span>
            <span class="user-chip ${colorClass}">${USER_COLOR_LABELS[color]}</span>
          </div>
        </div>
      </div>
      <div class="user-edit-grid">
        <div><label>Rol</label><select data-user-field="role" ${isMainAdmin ? 'disabled' : ''}><option value="inventariador" ${!['admin','owner'].includes(role) ? 'selected' : ''}>Inventariador</option><option value="admin" ${['admin','owner'].includes(role) ? 'selected' : ''}>Administrador</option></select></div>
        <div><label>Estado</label><select data-user-field="active" ${isMainAdmin ? 'disabled' : ''}><option value="true" ${active ? 'selected' : ''}>Activo</option><option value="false" ${!active ? 'selected' : ''}>Inactivo</option></select></div>
        <div><label>Color</label><select data-user-field="color">${userColorOptions(color)}</select></div>
      </div>
      <div class="user-stats-row">
        <div><span>Conteos</span><strong>${nf.format(stats.total)}</strong></div>
        <div><span>Último conteo</span><strong>${escapeHtml(lastCount)}</strong></div>
        <div><span>Último acceso</span><strong>${escapeHtml(lastAccess)}</strong></div>
        <div><span>Última actividad</span><strong>${escapeHtml(lastActive)}</strong></div>
      </div>
      <div class="user-actions">
        <button class="btn" type="button" data-user-action="save">Guardar</button>
        <button class="btn secondary" type="button" data-user-action="history">Historial</button>
        <button class="btn secondary" type="button" data-user-action="invite">Enviar acceso</button>
        <button class="btn secondary" type="button" data-user-action="reset">Reenviar acceso</button>
        <button class="btn danger" type="button" data-user-action="delete" ${isMainAdmin ? 'disabled' : ''}>Borrar usuario</button>
      </div>
    </article>`;
  }).join('');
}

function isEditingCountInput() {
  const active = document.activeElement;
  return !!(active && active.classList && active.classList.contains('count-input') && active.closest('#tab-generacion'));
}


function updateGenerationSummary() {
  // Actualiza solo métricas y aviso del laboratorio sin redibujar las tarjetas.
  // Esto evita borrar lo que el usuario está digitando y corrige el error:
  // updateGenerationSummary is not defined.
  const rows = filteredGenerationRows();
  const counted = rows.filter(r => hasPhysical(r));
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  setText('gItems', nf.format(rows.length));
  setText('gCounted', nf.format(counted.length));
  setText('gMissing', nf.format(counted.filter(r => getDifference(r) < 0).length));
  setText('gSurplus', nf.format(counted.filter(r => getDifference(r) > 0).length));
  const lab = selectedExactLab();
  if ($('lockBanner')) renderLockBanner(lab);
}

function renderAll() {
  if (isSupport()) { renderSupport(); return; }
  const keepEditing = isEditingCountInput();
  populateLabOptions();
  renderMetrics();
  renderLabList();
  renderAdminInventory();
  renderView();
  if (keepEditing) {
    updateGenerationSummary();
  } else {
    renderGeneration();
  }
  renderUsers();
}

async function createAllowedUser() {
  const identity = validateAdminIdentity({
    firstName: getValue('newUserFirstName'),
    secondName: getValue('newUserSecondName'),
    paternalSurname: getValue('newUserPaternalSurname'),
    maternalSurname: getValue('newUserMaternalSurname'),
    documentType: getValue('newUserDocumentType'),
    documentNumber: getValue('newUserDocumentNumber')
  });
  const name = fullAdminName(identity);
  const username = await generateAvailableNickname(identity);
  const contactEmail = normalizeText(getValue('newUserEmail')).toLowerCase();
  const role = getValue('newUserRole', 'inventariador');
  const color = normalizeColor(getValue('newUserColor', '0'));
  if (!contactEmail) return showMessage($('userMessage'), 'Ingresa el correo de contacto.', 'warn');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return showMessage($('userMessage'), 'Ingresa un correo de contacto válido.', 'warn');
  const authEmail = internalAuthEmail(state.companyId, username);
  const invite = { name, username, email: contactEmail, contactEmail, authEmail, role, color };
  const invitationUrl = createAccessUrl(username);
  await setDoc(companyDoc('allowedUsers', username), {
    username,
    name,
    firstName: identity.firstName,
    secondName: identity.secondName,
    paternalSurname: identity.paternalSurname,
    maternalSurname: identity.maternalSurname,
    documentType: identity.documentType,
    documentNumber: identity.documentNumber,
    email: contactEmail,
    contactEmail,
    authEmail,
    role,
    color,
    active: true,
    companyId: state.companyId,
    companyName: state.company?.name || '',
    invitationUrl,
    invitedAt: serverTimestamp(),
    invitedAtMs: Date.now(),
    createdByUid: state.user.uid,
    createdByEmail: contactEmailOfCurrentUser(),
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now(),
    appVersion
  }, { merge: true });
  await upsertLoginIndex(username, state.companyId, { companyName: state.company?.name || '', name, role, active: true });
  ['newUserFirstName','newUserSecondName','newUserPaternalSurname','newUserMaternalSurname','newUserDocumentNumber','newUserEmail'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  const typeEl = $('newUserDocumentType');
  if (typeEl) typeEl.value = 'CEDULA';
  const preview = $('newUserGeneratedUsernamePreview');
  if (preview) preview.textContent = 'Usuario generado: complete los 4 campos del nombre.';
  $('newUserColor').value = String((color + 1) % 8);
  const msg = $('userMessage');
  showMessage(msg, `Usuario autorizado: ${username}. Código empresa: ${state.companyId}.`, 'info');
  msg.innerHTML = `
    <strong>Usuario autorizado:</strong> ${escapeHtml(username)}<br>
    Nombre: <strong>${escapeHtml(name)}</strong><br>
    Documento: <strong>${escapeHtml(identity.documentType)} ${escapeHtml(identity.documentNumber)}</strong><br>
    Correo de contacto: <strong>${escapeHtml(contactEmail)}</strong><br>
    Código empresa: <strong>${escapeHtml(state.companyId)}</strong><br>
    Enlace Crear acceso: <a href="${escapeHtml(invitationUrl)}" target="_blank" rel="noopener">abrir enlace</a>
    <div class="invite-actions">
      <a class="btn secondary" href="${escapeHtml(invitationMailto(invite))}">Enviar invitación por correo</a>
      <button class="btn ghost" type="button" data-copy-invite="${escapeHtml(username)}">Copiar mensaje</button>
    </div>
    <div class="small">El usuario iniciará sesión escribiendo su usuario, seleccionando esta empresa y colocando su contraseña. El correo solo queda como contacto/invitación.</div>`;
}

async function copyInviteForEmail(username) {
  const item = mergedUsers().find(u => cleanUsername(u.username || u.id || '') === cleanUsername(username)) || { username };
  const text = invitationEmailText(item);
  await copyTextToClipboard(text);
  showMessage($('userMessage'), `Mensaje de invitación copiado para ${cleanUsername(username)}.`, 'info');
}

function sendUserInvite(card) {
  const data = getUserCardData(card);
  if (!data?.username) return;
  location.href = invitationMailto(data);
  showMessage($('userMessage'), `Se abrió el correo de invitación para ${data.username}. Revisa el mensaje y presiona Enviar.`, 'info');
}

function getUserCardData(card) {
  const username = cleanUsername(card?.dataset?.userUsername || '');
  const email = normalizeText(card?.dataset?.userEmail || '').toLowerCase();
  const authEmail = normalizeText(card?.dataset?.userAuthEmail || '').toLowerCase();
  const uid = card?.dataset?.userUid || '';
  const field = name => card.querySelector(`[data-user-field="${name}"]`);
  return {
    username,
    email,
    contactEmail: email,
    authEmail,
    uid,
    name: normalizeText(field('name')?.value || ''),
    role: field('role')?.value || 'inventariador',
    active: (field('active')?.value || 'true') === 'true',
    color: normalizeColor(field('color')?.value || 0)
  };
}

async function saveUserCard(card) {
  const data = getUserCardData(card);
  if (!data.username) return;
  const original = state.allowedUsers?.[data.username] || {};
  if ((original.role || data.role) === 'owner') {
    data.role = 'owner';
    data.active = true;
  }
  if (!data.name) return showMessage($('userMessage'), 'El nombre no puede quedar vacío.', 'warn');
  const authEmail = data.authEmail || original.authEmail || internalAuthEmail(state.companyId, data.username);
  await setDoc(companyDoc('allowedUsers', data.username), {
    username: data.username,
    name: data.name,
    email: data.email,
    contactEmail: data.email,
    authEmail,
    role: data.role,
    active: data.active,
    color: data.color,
    updatedByUid: state.user.uid,
    updatedByEmail: contactEmailOfCurrentUser(),
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now()
  }, { merge: true });
  await upsertLoginIndex(data.username, state.companyId, { companyName: state.company?.name || '', name: data.name, role: data.role, active: data.active });
  if (data.uid) {
    await setDoc(companyDoc('users', data.uid), {
      username: data.username,
      name: data.name,
      email: data.email,
      contactEmail: data.email,
      authEmail,
      role: data.role,
      active: data.active,
      color: data.color,
      updatedByUid: state.user.uid,
      updatedByEmail: contactEmailOfCurrentUser(),
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now()
    }, { merge: true });
    await setDoc(userIndexDoc(data.uid), {
      username: data.username,
      email: data.email,
      contactEmail: data.email,
      authEmail,
      name: data.name,
      role: data.role,
      active: data.active,
      companyId: state.companyId,
      companyName: state.company?.name || '',
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now()
    }, { merge: true });
  }
  showMessage($('userMessage'), `Usuario actualizado: ${data.username}`, 'info');
}

async function deleteUserCard(card) {
  const data = getUserCardData(card);
  const original = state.allowedUsers?.[data.username] || {};
  if (!data.username || original.role === 'owner') return;
  if (!confirm(`Se borrará el usuario ${data.username} del aplicativo. Se eliminará su autorización y perfil de la app. La cuenta interna de Firebase Authentication no se borra desde GitHub Pages. ¿Continuar?`)) return;
  await deleteDoc(companyDoc('allowedUsers', data.username));
  await removeLoginIndexEntry(data.username, state.companyId);
  if (data.uid) {
    try { await deleteDoc(companyDoc('users', data.uid)); await deleteDoc(userIndexDoc(data.uid)); } catch (err) {
      await setDoc(companyDoc('users', data.uid), {
        active: false,
        deleted: true,
        isOnline: false,
        disabledAt: serverTimestamp(),
        disabledAtMs: Date.now(),
        disabledByUid: state.user.uid,
        disabledByEmail: contactEmailOfCurrentUser()
      }, { merge: true });
    }
  }
  showMessage($('userMessage'), `Usuario borrado del aplicativo: ${data.username}`, 'warn');
}

async function resetUserPassword(card) {
  const data = getUserCardData(card);
  if (!data.username) return;
  location.href = invitationMailto(data);
  showMessage($('userMessage'), `Se abrió nuevamente la invitación para ${data.username}. Si el usuario olvidó su contraseña y ya había creado acceso, la opción simple es crearle otro usuario/nickname o solicitar soporte para borrar la cuenta interna en Firebase Authentication.`, 'info');
}

function showUserHistory(card) {
  const data = getUserCardData(card);
  const panel = $('userHistoryPanel');
  if (!panel || !data.email) return;
  const stats = countStatsForUser(data.username, data.email, data.uid);
  const rows = stats.list.slice(0, 30);
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="panel-head"><h3>Historial de ${escapeHtml(data.name || data.email)}</h3><button class="btn secondary" type="button" data-user-action="close-history">Cerrar historial</button></div>
    <div class="notice info">Mostrando los últimos ${nf.format(rows.length)} movimientos de ${nf.format(stats.total)} conteos registrados para este usuario.</div>
    ${rows.length ? `<div class="history-list">${rows.map(c => `<div class="history-item">
      <div><strong>${escapeHtml(c.laboratorio || '-')}</strong><div class="small">${escapeHtml(c.descripcion || '-')}</div></div>
      <div class="history-numbers"><span>Físico: <strong>${nf.format(c.total ?? 0)}</strong></span><span>Diferencia: <strong>${c.diff === null || c.diff === undefined ? '-' : nf.format(c.diff)}</strong></span><span>${escapeHtml(noveltyText(c.diff))}</span></div>
      <div class="small">${escapeHtml(fmtDate(c.updatedAtMs))}</div>
    </div>`).join('')}</div>` : '<div class="inventory-card-empty">Este usuario todavía no tiene conteos registrados.</div>'}`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function findHeaderRow(rows) {
  const keys = {
    codigo: ['CODIGO', 'COD', 'CODE'],
    descripcion: ['DESCRIPCION', 'DESCRIPCIÓN', 'PRODUCTO', 'ARTICULO', 'ARTÍCULO'],
    laboratorio: ['LABORATORIO', 'LAB', 'PROVEEDOR'],
    stock: ['STOCK ACTUAL', 'STOCK', 'EXISTENCIA', 'CANTIDAD']
  };
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i].map(c => normalizeKey(c));
    const map = {};
    for (const [field, aliases] of Object.entries(keys)) {
      map[field] = row.findIndex(cell => aliases.includes(cell));
      if (map[field] < 0) map[field] = row.findIndex(cell => aliases.some(a => cell.includes(a)));
    }
    if (map.descripcion >= 0 && map.laboratorio >= 0 && map.stock >= 0) {
      if (map.codigo < 0) map.codigo = -1;
      return { index: i, map };
    }
  }
  return null;
}

async function loadFile() {
  if (!isAdmin()) return alert('Solo administrador puede cargar inventario.');
  const file = $('fileInput').files[0];
  if (!file) return alert('Selecciona un archivo.');
  if (!window.XLSX) return alert('No se pudo cargar la librería de Excel. Revisa internet y vuelve a abrir la app.');
  if (!confirm('Esto reemplazará el inventario actual y eliminará conteos anteriores. ¿Continuar?')) return;
  showMessage($('loadMessage'), 'Leyendo archivo...', 'info');
  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    const header = findHeaderRow(rows);
    if (!header) throw new Error('No se encontraron columnas requeridas: Descripción, Laboratorio y Stock Actual.');
    const cleaned = [];
    let skippedZero = 0;
    let skippedEmpty = 0;
    for (let i = header.index + 1; i < rows.length; i++) {
      const row = rows[i];
      const codigo = header.map.codigo >= 0 ? normalizeText(row[header.map.codigo]) : '';
      const descripcion = normalizeText(row[header.map.descripcion]);
      const laboratorio = normalizeText(row[header.map.laboratorio]);
      const stockActual = toNumber(row[header.map.stock]);
      if (!descripcion || !laboratorio) { skippedEmpty++; continue; }
      if (stockActual === 0) { skippedZero++; continue; }
      const base = { codigo, descripcion, laboratorio, stockActual };
      cleaned.push(enrichRow({ ...base, id: productId(base) }));
    }
    await replaceInventory(cleaned, { fileName: file.name, skippedZero, skippedEmpty, totalRows: rows.length - header.index - 1 });
    showMessage($('loadMessage'), `Carga lista. Guardados: ${cleaned.length}. Eliminados por stock cero: ${skippedZero}. Filas vacías: ${skippedEmpty}.`, 'info');
  } catch (err) {
    console.error(err);
    showMessage($('loadMessage'), 'Error al cargar archivo: ' + err.message, 'danger');
  }
}

async function deleteCollection(collName) {
  const snap = await getDocs(companyCollection(collName));
  let batch = writeBatch(db);
  let count = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    count++;
    if (count % 450 === 0) { await batch.commit(); batch = writeBatch(db); }
  }
  if (count % 450 !== 0) await batch.commit();
}

async function replaceInventory(rows, meta) {
  await Promise.all(['inventory', 'counts', 'labLocks', 'labCompletions'].map(deleteCollection));
  let batch = writeBatch(db);
  let count = 0;
  for (const row of rows) {
    const ref = companyDoc('inventory', row.id);
    batch.set(ref, {
      codigo: row.codigo || '',
      descripcion: row.descripcion,
      laboratorio: row.laboratorio,
      labKey: row.labKey,
      stockActual: row.stockActual,
      unitsPerEntero: row.unitsPerEntero,
      factorSource: row.factorSource,
      enteros: row.enteros,
      unidades: row.unidades,
      totalUnits: row.totalUnits,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now()
    });
    count++;
    if (count % 450 === 0) { await batch.commit(); batch = writeBatch(db); }
  }
  if (count % 450 !== 0) await batch.commit();
  await setDoc(companyDoc('appMeta', 'current'), {
    ...meta,
    totalSaved: rows.length,
    loadedByUid: state.user.uid,
    loadedByName: state.profile?.name || contactEmailOfCurrentUser(),
    loadedByEmail: contactEmailOfCurrentUser(),
    loadedAt: serverTimestamp(),
    loadedAtMs: Date.now(),
    appVersion
  }, { merge: true });
}

async function takeSelectedLab() {
  const lab = selectedExactLab();
  if (!lab) return alert('Selecciona un laboratorio exacto.');
  await takeLab(lab);
}

async function takeLab(lab) {
  const key = labKey(lab);
  const now = Date.now();
  try {
    await runTransaction(db, async tx => {
      const ref = companyDoc('labLocks', key);
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const lock = snap.data();
        if (lock.status === 'active' && Number(lock.expiresAtMs || 0) > now && lock.lockedByUid !== state.user.uid) {
          throw new Error(`Laboratorio bloqueado por ${lock.userName || lock.userEmail || 'otro usuario'}.`);
        }
      }
      tx.set(ref, {
        lab,
        labKey: key,
        status: 'active',
        lockedByUid: state.user.uid,
        userName: state.profile?.name || contactEmailOfCurrentUser(),
        userEmail: contactEmailOfCurrentUser(),
        startedAt: serverTimestamp(),
        startedAtMs: now,
        updatedAt: serverTimestamp(),
        updatedAtMs: now,
        expiresAtMs: now + LOCK_TIMEOUT_MS
      }, { merge: true });
    });
    state.activeLab = lab;
    if ($('genLab')) $('genLab').value = lab;
    if ($('genSearch')) $('genSearch').value = '';
    switchTab('generacion');
    startHeartbeat();
  } catch (err) {
    alert(err.message);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => touchActiveLock(), 60 * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function touchActiveLock() {
  if (!state.activeLab || !state.user) return;
  const key = labKey(state.activeLab);
  const lock = state.locks[key];
  if (lock && lock.lockedByUid !== state.user.uid) return;
  try {
    await setDoc(companyDoc('labLocks', key), {
      lab: state.activeLab,
      labKey: key,
      status: 'active',
      lockedByUid: state.user.uid,
      userName: state.profile?.name || contactEmailOfCurrentUser(),
      userEmail: contactEmailOfCurrentUser(),
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + LOCK_TIMEOUT_MS
    }, { merge: true });
  } catch (err) { console.warn('No se pudo actualizar actividad', err); }
}

async function releaseActiveLab() {
  if (!state.activeLab || !state.user) return;
  const lab = state.activeLab;
  const key = labKey(lab);
  try {
    const lock = state.locks[key];
    if (!lock || lock.lockedByUid === state.user.uid) {
      await setDoc(companyDoc('labLocks', key), {
        lab,
        labKey: key,
        status: 'released',
        releasedByUid: state.user.uid,
        releasedByEmail: contactEmailOfCurrentUser(),
        releasedAt: serverTimestamp(),
        releasedAtMs: Date.now(),
        expiresAtMs: Date.now()
      }, { merge: true });
    }
  } catch (err) { console.warn('No se pudo liberar laboratorio', err); }
  state.activeLab = '';
  stopHeartbeat();
  renderGeneration();
}

async function finishActiveLab() {
  const lab = selectedExactLab();
  if (!lab) return alert('Selecciona un laboratorio.');
  if (!isLabLockedByCurrent(lab)) return alert('Primero debes tomar este laboratorio.');
  const rows = state.inventory.filter(r => r.laboratorio === lab);
  const counted = rows.filter(r => hasPhysical(r)).length;
  if (counted < rows.length) return alert(`Faltan productos por contar: ${rows.length - counted}.`);
  await setDoc(companyDoc('labCompletions', labKey(lab)), {
    lab,
    labKey: labKey(lab),
    completed: true,
    completedByUid: state.user.uid,
    completedByName: state.profile?.name || contactEmailOfCurrentUser(),
    completedByEmail: contactEmailOfCurrentUser(),
    completedAt: serverTimestamp(),
    completedAtMs: Date.now()
  }, { merge: true });
  await releaseActiveLab();
  alert('Laboratorio finalizado y liberado.');
}

function readCountCard(input) {
  const row = state.inventory.find(r => r.id === input.dataset.rowId);
  // El input también tiene data-row-id; por eso NO debemos usar
  // input.closest('[data-row-id]'), porque devuelve el propio input y no la tarjeta.
  // Esto impedía encontrar el otro campo, el total y la diferencia.
  const card = input.closest('.gen-product-card');
  if (!row || !card) return null;
  const enteroInput = card.querySelector('input.count-input[data-count-kind="enteros"]');
  const unidadInput = card.querySelector('input.count-input[data-count-kind="unidades"]');
  if (!enteroInput || !unidadInput) return null;
  const enteros = enteroInput.value === '' ? '' : Math.max(0, Math.round(Number(String(enteroInput.value).replace(',', '.')) || 0));
  const unidades = unidadInput.value === '' ? '' : Math.max(0, Math.round(Number(String(unidadInput.value).replace(',', '.')) || 0));
  const counted = enteroInput.value !== '' || unidadInput.value !== '';
  const total = counted ? ((Number(enteros) || 0) * (Number(row.unitsPerEntero) || 1)) + (Number(unidades) || 0) : '';
  const diff = counted ? Math.round(((Number(total) || 0) - (Number(row.totalUnits) || 0)) * 100) / 100 : null;
  return { row, card, enteroInput, unidadInput, enteros, unidades, total, diff, counted };
}

function updateCountCardVisual(input) {
  const data = readCountCard(input);
  if (!data) return null;
  const cls = diffClass(data.diff);
  [data.enteroInput, data.unidadInput, data.card.querySelector('.count-total-value')].filter(Boolean).forEach(el => {
    el.classList.remove('diff-negative', 'diff-positive', 'diff-zero');
    if (cls) el.classList.add(cls);
  });
  const totalEl = data.card.querySelector('.count-total-value');
  if (totalEl) totalEl.textContent = data.counted ? nf.format(data.total) : '-';
  const diffEl = data.card.querySelector('.diff-inline');
  if (diffEl) diffEl.innerHTML = diffInline(data.diff);
  // Guardado local inmediato para evitar que una actualización en tiempo real borre lo digitado
  // antes de que Firebase confirme el cambio.
  state.counts[data.row.id] = {
    ...(state.counts[data.row.id] || {}),
    productId: data.row.id,
    laboratorio: data.row.laboratorio,
    labKey: data.row.labKey,
    descripcion: data.row.descripcion,
    unitsPerEntero: data.row.unitsPerEntero,
    systemEnteros: data.row.enteros,
    systemUnidades: data.row.unidades,
    systemTotal: data.row.totalUnits,
    physicalEnteros: data.enteros === '' ? '' : data.enteros,
    physicalUnidades: data.unidades === '' ? '' : data.unidades,
    total: data.counted ? data.total : '',
    diff: data.diff,
    novelty: noveltyText(data.diff),
    updatedByUid: state.user?.uid || '',
    updatedByUsername: state.profile?.username || '',
    updatedByName: state.profile?.name || contactEmailOfCurrentUser() || '',
    updatedByEmail: contactEmailOfCurrentUser() || '',
    updatedByColor: normalizeColor(state.profile?.color, 0),
    updatedAtMs: Date.now(),
    localDraft: true
  };
  return data;
}

async function updateCountFromInput(input) {
  const data = updateCountCardVisual(input);
  if (!data) return;
  const { row, enteros, unidades, total, diff } = data;
  if (!isLabLockedByCurrent(row.laboratorio)) {
    input.blur();
    alert('Este laboratorio no está tomado por tu usuario.');
    renderGeneration();
    return;
  }
  const payload = {
    productId: row.id,
    laboratorio: row.laboratorio,
    labKey: row.labKey,
    descripcion: row.descripcion,
    unitsPerEntero: row.unitsPerEntero,
    systemEnteros: row.enteros,
    systemUnidades: row.unidades,
    systemTotal: row.totalUnits,
    physicalEnteros: enteros === '' ? 0 : enteros,
    physicalUnidades: unidades === '' ? 0 : unidades,
    total: total === '' ? 0 : total,
    diff,
    novelty: noveltyText(diff),
    updatedByUid: state.user.uid,
    updatedByUsername: state.profile?.username || '',
    updatedByName: state.profile?.name || contactEmailOfCurrentUser(),
    updatedByEmail: contactEmailOfCurrentUser(),
    updatedByColor: normalizeColor(state.profile?.color, 0),
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now()
  };
  state.counts[row.id] = { ...(state.counts[row.id] || {}), ...payload };
  updateGenerationSummary();
  await setDoc(companyDoc('counts', row.id), payload, { merge: true });
  await touchActiveLock();
}

function scheduleCountSave(input) {
  const data = updateCountCardVisual(input);
  if (!data) return;
  const key = data.row.id;
  clearTimeout(countSaveTimers.get(key));
  countSaveTimers.set(key, setTimeout(() => {
    updateCountFromInput(input).catch(err => {
      console.error(err);
      alert('No se pudo guardar el conteo: ' + (err.message || err));
    });
  }, 450));
}

function handleCountInputInline(input) {
  updateCountCardVisual(input);
  scheduleCountSave(input);
}

function handleCountCommitInline(input) {
  const data = readCountCard(input);
  if (data) clearTimeout(countSaveTimers.get(data.row.id));
  updateCountFromInput(input).catch(err => {
    console.error(err);
    alert('No se pudo guardar el conteo: ' + (err.message || err));
  });
}

window.deryiHandleCountInput = handleCountInputInline;
window.deryiHandleCountCommit = handleCountCommitInline;

function openFactorModal(id) {
  const row = state.inventory.find(r => r.id === id);
  if (!row) return;
  factorModalRowId = id;
  $('modalDesc').textContent = row.descripcion;
  $('modalLab').textContent = row.laboratorio;
  $('modalStock').textContent = nf.format(row.stockActual);
  $('modalFactor').value = row.unitsPerEntero;
  updateModalCalc();
  $('factorModal').classList.remove('hidden');
  $('modalFactor').focus();
}

function closeFactorModal() {
  factorModalRowId = null;
  $('factorModal').classList.add('hidden');
}

function updateModalCalc() {
  const row = state.inventory.find(r => r.id === factorModalRowId);
  if (!row) return;
  const factor = Math.max(1, parseInt(getValue('modalFactor'), 10) || 1);
  const calc = calcStock(row.stockActual, factor);
  $('modalCalc').textContent = `${nf.format(calc.enteros)} enteros + ${nf.format(calc.unidades)} unidades = ${nf.format(calc.totalUnits)} unidades totales`;
}

async function saveFactorFromModal() {
  if (!isAdmin()) return alert('Solo administrador puede editar Unid/Entero.');
  const row = state.inventory.find(r => r.id === factorModalRowId);
  if (!row) return;
  const factor = Math.max(1, parseInt(getValue('modalFactor'), 10) || 1);
  const calc = calcStock(row.stockActual, factor);
  await setDoc(companyDoc('inventory', row.id), {
    unitsPerEntero: factor,
    factorSource: 'Editado manualmente',
    enteros: calc.enteros,
    unidades: calc.unidades,
    totalUnits: calc.totalUnits,
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now(),
    updatedByUid: state.user.uid,
    updatedByEmail: contactEmailOfCurrentUser()
  }, { merge: true });
  closeFactorModal();
}

function reportRows(onlyNovelties = false) {
  const lab = selectedExactLab();
  let rows = state.inventory.filter(r => !lab || r.laboratorio === lab);
  rows = sortRowsByDescription(rows.map(r => {
    const p = getPhysicalParts(r);
    const c = countFor(r);
    const diff = getDifference(r);
    return { ...r, physicalParts: p, physical: p.total, diff, novelty: noveltyText(diff), count: c };
  }));
  if (onlyNovelties) rows = rows.filter(r => r.diff !== null && r.diff !== 0);
  return rows;
}

function reportSummary(rows) {
  const counted = rows.filter(r => r.physicalParts?.counted).length;
  const faltantes = rows.filter(r => Number(r.diff) < 0).length;
  const sobrantes = rows.filter(r => Number(r.diff) > 0).length;
  const correctos = rows.filter(r => r.diff === 0).length;
  const pendientes = rows.length - counted;
  const systemTotal = rows.reduce((sum, r) => sum + (Number(r.totalUnits) || 0), 0);
  const physicalTotal = rows.reduce((sum, r) => sum + (r.physicalParts?.counted ? (Number(r.physical) || 0) : 0), 0);
  const diffTotal = Math.round((physicalTotal - systemTotal) * 100) / 100;
  return { counted, faltantes, sobrantes, correctos, pendientes, systemTotal, physicalTotal, diffTotal };
}

function reportResponsible(rows) {
  const names = [];
  const seen = new Set();
  for (const r of rows) {
    const label = normalizeText(r.count?.updatedByName || r.count?.updatedByEmail || '');
    if (!label) continue;
    const key = normalizeKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(label);
  }
  if (!names.length) return state.profile?.name || contactEmailOfCurrentUser() || 'Sin usuario registrado';
  if (names.length === 1) return names[0];
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `Varios usuarios: ${shown} +${names.length - 3}` : `Varios usuarios: ${shown}`;
}

function latestCountDate(rows) {
  return rows.reduce((max, r) => Math.max(max, Number(r.count?.updatedAtMs || 0)), 0);
}

function pdfText(doc, text, x, y, options = {}) {
  doc.text(String(text ?? ''), x, y, options);
}


async function generatePdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) return alert('No se pudo cargar la librería PDF. Revisa internet.');
  const rows = reportRows(false);
  const lab = selectedExactLab() || 'Todos los laboratorios';
  const { jsPDF } = window.jspdf;
  const docPdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const now = new Date();
  const pageWidth = docPdf.internal.pageSize.getWidth();
  const pageHeight = docPdf.internal.pageSize.getHeight();
  const margin = 28;
  const contentWidth = pageWidth - margin * 2;
  const summary = reportSummary(rows);
  const empresa = state.company?.name || APP_NAME;
  const empresaEncabezado = String(empresa || APP_NAME).toUpperCase();
  const administrador = state.company?.ownerName || state.company?.ownerEmail || 'Sin administrador registrado';
  const inventariador = reportResponsible(rows);
  const fechaInventario = latestCountDate(rows) ? fmtDate(latestCountDate(rows)) : 'Sin conteo registrado';
  const fechaCarga = state.meta?.loadedAtMs ? fmtDate(state.meta.loadedAtMs) : 'Sin carga registrada';
  const fechaDocumento = now.toLocaleString('es-EC');
  const archivoBase = state.meta?.fileName || 'Sin archivo registrado';

  async function loadWatermarkDataUrl() {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 0.5;
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = `assets/logo.png?v=${encodeURIComponent(appVersion)}`;
    });
  }

  const watermarkDataUrl = await loadWatermarkDataUrl();

  function drawWatermark(pageNumber = 1) {
    if (!watermarkDataUrl) return;
    try {
      const boxWidth = contentWidth * 0.72;
      const boxHeight = boxWidth * 0.33;
      const x = (pageWidth - boxWidth) / 2;
      const y = pageNumber === 1 ? (pageHeight - boxHeight) / 2 - 6 : (pageHeight - boxHeight) / 2;
      docPdf.addImage(watermarkDataUrl, 'PNG', x, y, boxWidth, boxHeight, undefined, 'FAST');
    } catch (err) {
      // Ignorar si el logo no puede renderizarse en el PDF.
    }
  }

  function drawFooter(pageNumber, totalPages) {
    docPdf.setDrawColor(226, 232, 240);
    docPdf.line(margin, pageHeight - 28, pageWidth - margin, pageHeight - 28);
    docPdf.setFont('helvetica', 'normal');
    docPdf.setFontSize(7);
    docPdf.setTextColor(100, 116, 139);
    pdfText(docPdf, `${APP_NAME} - ${appVersion}`, margin, pageHeight - 14);
    pdfText(docPdf, `Página ${pageNumber} de ${totalPages}`, pageWidth - margin, pageHeight - 14, { align: 'right' });
    docPdf.setTextColor(31, 41, 55);
  }

  function drawMainHeader() {
    const boxY = 22;
    const boxH = 56;
    docPdf.setFillColor(6, 36, 82);
    docPdf.roundedRect(margin, boxY, contentWidth, boxH, 8, 8, 'F');
    docPdf.setTextColor(255, 255, 255);
    docPdf.setFont('helvetica', 'bold');
    docPdf.setFontSize(14);
    pdfText(docPdf, 'INFORME DE INVENTARIO FISICO', margin + 14, boxY + 22);

    docPdf.setFont('helvetica', 'bold');
    docPdf.setFontSize(16);
    const companyLines = docPdf.splitTextToSize(empresaEncabezado, 250);
    const startY = companyLines.length > 1 ? boxY + 20 : boxY + 30;
    pdfText(docPdf, companyLines, pageWidth - margin - 14, startY, { align: 'right' });

    docPdf.setFont('helvetica', 'normal');
    docPdf.setFontSize(8);
    pdfText(docPdf, 'Documento profesional de conteo e inventario', margin + 14, boxY + 42);
    docPdf.setTextColor(31, 41, 55);
  }

  function drawInfoBox() {
    const y = 92;
    docPdf.setDrawColor(191, 219, 254);
    docPdf.setFillColor(239, 246, 255);
    docPdf.roundedRect(margin, y, contentWidth, 82, 8, 8, 'FD');

    const leftX = margin + 12;
    const midX = margin + contentWidth / 2 + 6;
    const labelGap = 11;
    docPdf.setFontSize(7.6);
    docPdf.setTextColor(71, 85, 105);

    function info(label, value, x, yy) {
      docPdf.setFont('helvetica', 'bold');
      pdfText(docPdf, label, x, yy);
      docPdf.setFont('helvetica', 'normal');
      const lines = docPdf.splitTextToSize(String(value || '-'), contentWidth / 2 - 28);
      pdfText(docPdf, lines, x, yy + labelGap);
    }

    info('Empresa', empresaEncabezado, leftX, y + 16);
    info('Administrador principal', administrador, leftX, y + 49);
    info('Usuario inventariador', inventariador, midX, y + 16);
    info('Laboratorio / filtro', lab, midX, y + 49);
    docPdf.setTextColor(31, 41, 55);
  }

  function drawDatesBox() {
    const y = 184;
    docPdf.setDrawColor(226, 232, 240);
    docPdf.setFillColor(248, 250, 252);
    docPdf.roundedRect(margin, y, contentWidth, 58, 8, 8, 'FD');
    docPdf.setFontSize(7.4);
    docPdf.setTextColor(71, 85, 105);

    const col = contentWidth / 3;
    function item(label, value, x) {
      docPdf.setFont('helvetica', 'bold');
      pdfText(docPdf, label, x, y + 17);
      docPdf.setFont('helvetica', 'normal');
      const lines = docPdf.splitTextToSize(String(value || '-'), col - 14);
      pdfText(docPdf, lines, x, y + 31);
    }
    item('Inventario cargado', fechaCarga, margin + 12);
    item('Inventario/conteo generado', fechaInventario, margin + 12 + col);
    item('Documento generado', fechaDocumento, margin + 12 + col * 2);
    docPdf.setFont('helvetica', 'bold');
    pdfText(docPdf, 'Archivo base', margin + 12, y + 51);
    docPdf.setFont('helvetica', 'normal');
    pdfText(docPdf, docPdf.splitTextToSize(archivoBase, contentWidth - 85), margin + 70, y + 51);
    docPdf.setTextColor(31, 41, 55);
  }

  function drawSummaryCards() {
    const y = 256;
    const gap = 8;
    const cardW = (contentWidth - gap * 4) / 5;
    const cards = [
      ['Productos', rows.length],
      ['Contados', summary.counted],
      ['Correctos', summary.correctos],
      ['Faltantes', summary.faltantes],
      ['Sobrantes', summary.sobrantes]
    ];
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + gap);
      docPdf.setFillColor(i === 3 ? 254 : i === 4 ? 239 : i === 2 ? 240 : 248, i === 3 ? 242 : i === 4 ? 246 : i === 2 ? 253 : 250, i === 3 ? 242 : i === 4 ? 255 : i === 2 ? 244 : 252);
      docPdf.setDrawColor(226, 232, 240);
      docPdf.roundedRect(x, y, cardW, 42, 8, 8, 'FD');
      docPdf.setFont('helvetica', 'bold');
      docPdf.setFontSize(7.2);
      docPdf.setTextColor(100, 116, 139);
      pdfText(docPdf, c[0], x + 8, y + 14);
      docPdf.setFontSize(13);
      docPdf.setTextColor(15, 23, 42);
      pdfText(docPdf, nf.format(c[1]), x + 8, y + 32);
    });
    docPdf.setTextColor(31, 41, 55);
  }

  drawWatermark(1);
  drawMainHeader();
  drawInfoBox();
  drawDatesBox();
  drawSummaryCards();

  if (!rows.length) {
    docPdf.setFont('helvetica', 'normal');
    docPdf.setFontSize(10);
    pdfText(docPdf, 'No hay artículos para el filtro actual.', margin, 336);
  } else {
    docPdf.autoTable({
      startY: 318,
      margin: { left: margin, right: margin, top: 74, bottom: 62 },
      tableWidth: contentWidth,
      head: [[
        'Lab', 'Descripción', 'Unid', 'S. ent', 'S. unid', 'S. total',
        'F. ent', 'F. unid', 'F. total', 'Dif.', 'Usuario', 'Fecha', 'Novedad'
      ]],
      body: rows.map(r => [
        r.laboratorio,
        r.descripcion,
        String(r.unitsPerEntero),
        String(r.enteros),
        String(r.unidades),
        String(r.totalUnits),
        r.physicalParts.counted ? String(r.physicalParts.enteros || 0) : '',
        r.physicalParts.counted ? String(r.physicalParts.unidades || 0) : '',
        r.physicalParts.counted ? String(r.physical) : '',
        r.diff === null ? '' : String(r.diff),
        r.count.updatedByName || '',
        r.count.updatedAtMs ? fmtDate(r.count.updatedAtMs) : '',
        r.novelty
      ]),
      styles: {
        font: 'helvetica',
        fontSize: 5.2,
        cellPadding: { top: 2.1, right: 1.8, bottom: 2.1, left: 1.8 },
        overflow: 'linebreak',
        valign: 'middle',
        lineColor: [226, 232, 240],
        lineWidth: 0.25,
        textColor: [30, 41, 59]
      },
      headStyles: {
        fillColor: [6, 36, 82],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 5.5,
        halign: 'center'
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 52 },
        1: { cellWidth: 120 },
        2: { cellWidth: 23, halign: 'center' },
        3: { cellWidth: 27, halign: 'right' },
        4: { cellWidth: 27, halign: 'right' },
        5: { cellWidth: 31, halign: 'right' },
        6: { cellWidth: 27, halign: 'right' },
        7: { cellWidth: 27, halign: 'right' },
        8: { cellWidth: 31, halign: 'right' },
        9: { cellWidth: 28, halign: 'right' },
        10: { cellWidth: 47 },
        11: { cellWidth: 50 },
        12: { cellWidth: 49 }
      },
      didParseCell: function(data) {
        if (data.section === 'body' && data.column.index === 9) {
          const v = Number(data.cell.raw);
          if (v < 0) data.cell.styles.fillColor = [254, 226, 226];
          if (v > 0) data.cell.styles.fillColor = [219, 234, 254];
          if (v === 0 && data.cell.raw !== '') data.cell.styles.fillColor = [220, 252, 231];
        }
        if (data.section === 'body' && data.column.index === 12) {
          const raw = String(data.cell.raw || '');
          if (raw === 'Faltante') data.cell.styles.textColor = [153, 27, 27];
          if (raw === 'Sobrante') data.cell.styles.textColor = [30, 64, 175];
          if (raw === 'Sin diferencia') data.cell.styles.textColor = [21, 128, 61];
        }
      },
      willDrawPage: function(data) {
        if (data.pageNumber > 1) drawWatermark(data.pageNumber);
      }
    });
  }

  let finalY = docPdf.lastAutoTable?.finalY || 344;
  if (finalY > pageHeight - 145) {
    docPdf.addPage();
    drawWatermark(docPdf.getNumberOfPages());
    finalY = 90;
  }
  const signY = Math.max(finalY + 34, pageHeight - 128);
  docPdf.setDrawColor(148, 163, 184);
  docPdf.setLineWidth(0.6);
  docPdf.line(margin + 78, signY + 38, pageWidth - margin - 78, signY + 38);
  docPdf.setFont('helvetica', 'bold');
  docPdf.setFontSize(8);
  docPdf.setTextColor(51, 65, 85);
  pdfText(docPdf, 'Firma del responsable', pageWidth / 2, signY + 52, { align: 'center' });
  docPdf.setFont('helvetica', 'normal');
  docPdf.setFontSize(7);
  pdfText(docPdf, `Nombre: ${inventariador}`, pageWidth / 2, signY + 65, { align: 'center' });
  pdfText(docPdf, `Fecha: ${fechaDocumento}`, pageWidth / 2, signY + 78, { align: 'center' });

  const totalPages = docPdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    docPdf.setPage(i);
    drawFooter(i, totalPages);
  }

  docPdf.save(`${safeFileName(state.company?.name || APP_NAME)}_informe_inventario_${safeFileName(lab)}_${now.toISOString().slice(0,10)}.pdf`);
}

function exportCsv() {
  const rows = reportRows(true);
  const header = ['Laboratorio','Descripcion','Unid/Entero','Sistema Enteros','Sistema Unidades','Sistema Total','Fisico Enteros','Fisico Unidades','Fisico Total','Diferencia','Usuario','Fecha','Novedad'];
  const lines = [header, ...rows.map(r => [r.laboratorio, r.descripcion, r.unitsPerEntero, r.enteros, r.unidades, r.totalUnits, r.physicalParts.enteros, r.physicalParts.unidades, r.physical, r.diff, r.count.updatedByName || '', r.count.updatedAtMs ? fmtDate(r.count.updatedAtMs) : '', r.novelty])]
    .map(cols => cols.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFileName(state.company?.name || APP_NAME)}_novedades_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

async function updateCurrentUserPresence(isOnline = true) {
  if (!state.user || isSupport() || !state.companyId) return;
  try {
    await setDoc(companyDoc('users', state.user.uid), {
      isOnline,
      lastActiveAt: serverTimestamp(),
      lastActiveAtMs: Date.now()
    }, { merge: true });
  } catch (err) { console.warn('No se pudo actualizar presencia', err); }
}


function updateGeneratedCompanyUsernamePreview() {
  const el = $('companyGeneratedUsernamePreview');
  if (!el) return;
  const identity = {
    firstName: getValue('companyAdminFirstName'),
    secondName: getValue('companyAdminSecondName'),
    paternalSurname: getValue('companyAdminPaternalSurname'),
    maternalSurname: getValue('companyAdminMaternalSurname')
  };
  const base = generateNicknameBase(identity);
  el.textContent = base ? `Usuario base generado: ${base}` : 'Usuario generado: complete los 4 campos del nombre.';
}

function updateGeneratedNewUserPreview() {
  const el = $('newUserGeneratedUsernamePreview');
  if (!el) return;
  const identity = {
    firstName: getValue('newUserFirstName'),
    secondName: getValue('newUserSecondName'),
    paternalSurname: getValue('newUserPaternalSurname'),
    maternalSurname: getValue('newUserMaternalSurname')
  };
  const base = generateNicknameBase(identity);
  el.textContent = base ? `Usuario base generado: ${base}` : 'Usuario generado: complete los 4 campos del nombre.';
}

function startUserPresence() {
  stopUserPresence();
  updateCurrentUserPresence(true);
  userHeartbeatTimer = setInterval(() => updateCurrentUserPresence(true), 60 * 1000);
}

function stopUserPresence() {
  if (userHeartbeatTimer) clearInterval(userHeartbeatTimer);
  userHeartbeatTimer = null;
}

function attachEvents() {
  setVersionLabels();
  document.querySelectorAll('.auth-tab').forEach(btn => btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));
  ['companyAdminFirstName','companyAdminSecondName','companyAdminPaternalSurname','companyAdminMaternalSurname'].forEach(id => {
    const node = $(id);
    if (node) node.addEventListener('input', updateGeneratedCompanyUsernamePreview);
  });
  updateGeneratedCompanyUsernamePreview();
  ['newUserFirstName','newUserSecondName','newUserPaternalSurname','newUserMaternalSurname'].forEach(id => {
    const node = $(id);
    if (node) node.addEventListener('input', updateGeneratedNewUserPreview);
  });
  updateGeneratedNewUserPreview();
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      let companyId = selectedLoginCompanyId();
      if (!companyId) {
        const companies = await findCompaniesForUsername(getValue('loginUsername'));
        renderLoginCompanyResults(companies, getValue('loginUsername'));
        companyId = selectedLoginCompanyId();
      }
      await login(companyId, getValue('loginUsername'), getValue('loginPassword'));
      try { localStorage.setItem(`multi_login_company_${cleanUsername(getValue('loginUsername'))}`, companyId); } catch {}
    }
    catch (err) { showMessage($('authMessage'), 'Error al ingresar: ' + err.message, 'danger'); }
  });
  const btnFindLoginCompanies = $('btnFindLoginCompanies');
  if (btnFindLoginCompanies) btnFindLoginCompanies.addEventListener('click', () => searchLoginCompanies().catch(err => showMessage($('authMessage'), err.message, 'danger')));
  const toggleManualLogin = $('toggleManualLogin');
  if (toggleManualLogin) toggleManualLogin.addEventListener('click', () => {
    const box = $('loginManualCompanyBox');
    const visible = box && box.classList.toggle('hidden') === false;
    toggleManualLogin.textContent = visible ? 'Ocultar ingreso con código' : 'Ingresar con código / soporte';
  });
  const loginUsername = $('loginUsername');
  if (loginUsername) loginUsername.addEventListener('input', () => clearLoginCompanySelection(true));
  $('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await registerUser(getValue('registerUsername'), getValue('registerPassword'), getValue('registerCompanyCode'));
      showMessage($('authMessage'), 'Cuenta creada correctamente.', 'info');
    } catch (err) { showMessage($('authMessage'), 'Error al crear cuenta: ' + err.message, 'danger'); }
  });

  const createCompanyForm = $('createCompanyForm');
  if (createCompanyForm) createCompanyForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const result = await createCompany(getValue('companyName'), {
        firstName: getValue('companyAdminFirstName'),
        secondName: getValue('companyAdminSecondName'),
        paternalSurname: getValue('companyAdminPaternalSurname'),
        maternalSurname: getValue('companyAdminMaternalSurname'),
        documentType: getValue('companyAdminDocumentType'),
        documentNumber: getValue('companyAdminDocumentNumber')
      }, getValue('companyAdminEmail'), getValue('companyAdminPassword'));
      showMessage($('authMessage'), `Empresa creada correctamente. Código empresa: ${result.companyId}. Usuario administrador: ${result.username}`, 'info');
    } catch (err) {
      showMessage($('authMessage'), 'Error al crear empresa: ' + err.message, 'danger');
    }
  });

  const resetForm = $('resetForm');
  if (resetForm) resetForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await sendLoginPasswordReset();
      showMessage($('authMessage'), 'Solicita al administrador que te reenvíe el acceso o cree un nuevo usuario/nickname.', 'info');
    } catch (err) {
      showMessage($('authMessage'), err.message, 'warn');
    }
  });

  $('sideNavEdge').addEventListener('click', () => setSideMenu(!$('sideNav').classList.contains('open')));
  document.addEventListener('click', e => {
    if (!$('sideNav').classList.contains('open')) return;
    if ($('sideNav').contains(e.target) || $('sideNavEdge').contains(e.target)) return;
    setSideMenu(false);
  });
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  document.querySelectorAll('[data-toggle-section]').forEach(btn => btn.addEventListener('click', () => {
    const target = $(btn.dataset.toggleSection);
    setSectionCollapsed(btn.dataset.toggleSection, !target.classList.contains('collapsed'));
  }));

  $('logoutBtn').addEventListener('click', async () => { await releaseActiveLab(); await updateCurrentUserPresence(false); stopUserPresence(); await signOut(auth); });
  $('btnLoadFile').addEventListener('click', loadFile);
  $('btnRefreshCloud').addEventListener('click', renderAll);
  $('btnCreateUser').addEventListener('click', () => createAllowedUser().catch(err => showMessage($('userMessage'), err.message, 'danger')));
  const userSearch = $('userSearch');
  if (userSearch) userSearch.addEventListener('input', renderUsers);
  ['adminViewLab','adminViewDesc','adminViewAny'].forEach(id => { const el = $(id); if (el) el.addEventListener('input', renderAdminInventory); });
  ['genLab','genSearch'].forEach(id => $(id).addEventListener('input', renderGeneration));
  $('btnOnlyDiff').addEventListener('click', () => { state.showOnlyDiff = !state.showOnlyDiff; renderGeneration(); });
  $('btnTakeLab').addEventListener('click', takeSelectedLab);
  $('btnReleaseLab').addEventListener('click', releaseActiveLab);
  $('btnFinishLab').addEventListener('click', finishActiveLab);
  $('btnPdf').addEventListener('click', generatePdf);
  $('btnCsv').addEventListener('click', exportCsv);

  document.body.addEventListener('click', e => {
    const loginCompanyBtn = e.target.closest('[data-login-company]');
    if (loginCompanyBtn) {
      const companyId = cleanCompanyCode(loginCompanyBtn.dataset.loginCompany || '');
      if ($('loginSelectedCompanyId')) $('loginSelectedCompanyId').value = companyId;
      if ($('loginCompanyCode')) $('loginCompanyCode').value = '';
      document.querySelectorAll('.login-company-option').forEach(btn => btn.classList.toggle('selected', btn === loginCompanyBtn));
      clearMessage($('authMessage'));
    }
    const labBtn = e.target.closest('[data-lab-open]');
    if (labBtn) takeLab(labBtn.dataset.labOpen);
    const factorBtn = e.target.closest('[data-factor-edit]');
    if (factorBtn) openFactorModal(factorBtn.dataset.factorEdit);
    const copyInvite = e.target.closest('[data-copy-invite]');
    if (copyInvite) copyInviteForEmail(copyInvite.dataset.copyInvite).catch(err => showMessage($('userMessage'), 'No se pudo copiar: ' + err.message, 'danger'));
    const userAction = e.target.closest('[data-user-action]');
    if (userAction) {
      const action = userAction.dataset.userAction;
      const card = userAction.closest('.user-card');
      if (action === 'save') saveUserCard(card).catch(err => showMessage($('userMessage'), err.message, 'danger'));
      if (action === 'delete') deleteUserCard(card).catch(err => showMessage($('userMessage'), err.message, 'danger'));
      if (action === 'invite') sendUserInvite(card);
      if (action === 'reset') resetUserPassword(card).catch(err => showMessage($('userMessage'), 'No se pudo enviar correo: ' + err.message, 'danger'));
      if (action === 'history') showUserHistory(card);
      if (action === 'close-history') $('userHistoryPanel')?.classList.add('hidden');
    }
  });
  document.body.addEventListener('input', e => {
    if (e.target.classList.contains('count-input')) scheduleCountSave(e.target);
  });
  document.body.addEventListener('change', e => {
    if (e.target.classList.contains('count-input')) {
      const data = readCountCard(e.target);
      if (data) clearTimeout(countSaveTimers.get(data.row.id));
      updateCountFromInput(e.target).catch(err => { console.error(err); alert('No se pudo guardar el conteo: ' + (err.message || err)); });
    }
  });
  document.body.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeFactorModal(); setSideMenu(false); }
  });
  $('btnCloseFactor').addEventListener('click', closeFactorModal);
  $('btnCancelFactor').addEventListener('click', closeFactorModal);
  $('modalFactor').addEventListener('input', updateModalCalc);
  $('btnSaveFactor').addEventListener('click', () => saveFactorFromModal().catch(err => alert(err.message)));
  $('factorModal').addEventListener('click', e => { if (e.target.id === 'factorModal') closeFactorModal(); });

  window.addEventListener('beforeunload', () => { releaseActiveLab(); updateCurrentUserPresence(false); });
  window.addEventListener('pagehide', () => { releaseActiveLab(); updateCurrentUserPresence(false); });
  window.addEventListener('online', () => $('syncState').textContent = 'En línea');
  window.addEventListener('offline', () => $('syncState').textContent = 'Sin conexión');

  prepareInstallButton();
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    if (isSamsungInternet()) {
      deferredInstallPrompt = null;
      prepareInstallButton();
      return;
    }
    deferredInstallPrompt = e;
    const btn = $('installBtn');
    if (btn) {
      btn.textContent = 'Instalar app';
      btn.classList.remove('hidden');
    }
  });
  $('installBtn').addEventListener('click', async () => {
    if (isSamsungInternet()) {
      showInstallGuidance();
      return;
    }
    if (!deferredInstallPrompt) {
      showInstallGuidance();
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('installBtn').classList.add('hidden');
  });
}

async function startAppSession(user) {
  state.profile = await ensureProfile(user);
  $('authPage').classList.add('hidden');
  $('appPage').classList.remove('hidden');
  applyRoleUI();
  if (!isSupport()) startUserPresence();
  attachRealtimeListeners();
  applyCollapsePrefs();
  if (isSupport()) switchTab('soporte');
  else switchTab(isAdmin() ? 'carga' : 'vista');
  $('syncState').textContent = navigator.onLine ? 'En línea' : 'Sin conexión';
}

function authReady() {
  onAuthStateChanged(auth, async user => {
    state.user = user;
    if (pendingAuthSetup) return;
    if (!user) {
      state.profile = null;
      state.companyId = null;
      state.company = null;
      state.isSupport = false;
      state.inventory = [];
      state.counts = {};
      state.locks = {};
      state.allowedUsers = {};
      state.registeredUsers = {};
      unsubscribers.forEach(fn => fn());
      unsubscribers = [];
      stopHeartbeat();
      stopUserPresence();
      $('authPage').classList.remove('hidden');
      $('appPage').classList.add('hidden');
      setVersionLabels();
      return;
    }
    try {
      await startAppSession(user);
    } catch (err) {
      console.error(err);
      showMessage($('authMessage'), err.message, 'danger');
      await signOut(auth);
    }
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js?v=1.6');
      registration.update?.();
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!sessionStorage.getItem('swReloadedV18')) {
          sessionStorage.setItem('swReloadedV18', '1');
          window.location.reload();
        }
      });
    } catch (err) {
      console.warn('No se pudo registrar service worker', err);
    }
  });
}

attachEvents();
applyAuthQueryParams();
if (setupFirebase()) authReady();
