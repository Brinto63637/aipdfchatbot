const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const questionInput = $('questionInput');
const messages = $('messages');
let history = [];
let busy = false;
let toastTimer;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}
function setConnection(data) {
  const online = data.ollama;
  [$('sideStatus'), $('topStatus')].forEach(dot => { dot.classList.toggle('online', online); dot.classList.toggle('offline', !online); });
  $('modelLabel').textContent = !online ? 'Ollama is offline' : data.model_available ? `Connected · ${data.model}` : `Model missing · ${data.model}`;
  if (online && !data.model_available) $('modelLabel').title = `Run: ollama pull ${data.model}`;
}
async function checkHealth() {
  try { const response = await fetch('/api/health'); setConnection(await response.json()); }
  catch { setConnection({ollama:false}); }
}
async function refreshDocuments() {
  try {
    const response = await fetch('/api/documents'); const docs = await response.json();
    const list = $('documentList'); list.replaceChildren();
    if (!docs.length) { list.innerHTML = '<div class="empty-library">Your PDFs will appear here.</div>'; return; }
    docs.forEach(doc => {
      const row = document.createElement('div'); row.className = 'doc-item';
      const icon = document.createElement('span'); icon.className = 'pdf-icon'; icon.textContent = 'PDF';
      const info = document.createElement('span'); info.className = 'doc-info';
      const name = document.createElement('strong'); name.textContent = doc.name; name.title = doc.name;
      const meta = document.createElement('small'); meta.textContent = `${doc.pages_indexed} pages indexed`;
      const remove = document.createElement('button'); remove.className = 'doc-remove'; remove.textContent = '×'; remove.title = 'Remove PDF'; remove.setAttribute('aria-label', `Remove ${doc.name}`);
      remove.addEventListener('click', async () => { await fetch(`/api/documents/${encodeURIComponent(doc.name)}`, {method:'DELETE'}); refreshDocuments(); });
      info.append(name, meta); row.append(icon, info, remove); list.append(row);
    });
  } catch { /* server may still be starting */ }
}
function addMessage(role, text, sources = []) {
  const item = document.createElement('article'); item.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = role === 'assistant' ? '✳' : '•';
  const body = document.createElement('div'); body.className = 'message-body';
  const label = document.createElement('div'); label.className = 'message-name'; label.textContent = role === 'assistant' ? 'PAPERTRAIL' : 'YOU';
  const content = document.createElement('div'); content.className = 'message-text'; content.textContent = text;
  body.append(label, content);
  if (sources.length) {
    const chips = document.createElement('div'); chips.className = 'source-list';
    sources.forEach(source => { const chip = document.createElement('span'); chip.className = 'source-chip'; chip.textContent = `${source.name} · p. ${source.page}`; chips.append(chip); });
    body.append(chips);
  }
  item.append(avatar, body); messages.append(item); $('conversation').scrollTop = $('conversation').scrollHeight;
  return item;
}
async function upload(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) { toast('Please choose a PDF file.'); return; }
  $('uploadProgress').hidden = false; $('uploadMessage').textContent = `Reading ${file.name}…`;
  const data = new FormData(); data.append('file', file);
  try {
    const response = await fetch('/api/upload', {method:'POST', body:data}); const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'Could not read this PDF.');
    $('welcome').hidden = true; await refreshDocuments();
    if (!messages.children.length) addMessage('assistant', `I've read ${result.name} and indexed ${result.pages_indexed} pages. Ask me anything about it.`);
    else toast(`Added ${result.name} · ${result.pages_indexed} pages indexed`);
  } catch (error) { toast(error.message); }
  finally { $('uploadProgress').hidden = true; fileInput.value = ''; }
}
async function sendQuestion(text = questionInput.value.trim()) {
  if (!text || busy) return;
  const docs = await fetch('/api/documents').then(r => r.json()).catch(() => []);
  if (!docs.length) { toast('Add a PDF first, then ask away.'); return; }
  busy = true; $('sendButton').disabled = true; questionInput.value = ''; questionInput.style.height = 'auto'; $('welcome').hidden = true;
  addMessage('user', text);
  const waiting = document.createElement('div'); waiting.className = 'message'; waiting.innerHTML = '<div class="message-avatar">✳</div><div class="message-body"><div class="message-name">PAPERTRAIL</div><div class="typing"><span class="typing-dots"><i></i><i></i><i></i></span> Reading your sources…</div></div>';
  messages.append(waiting); $('conversation').scrollTop = $('conversation').scrollHeight;
  try {
    const response = await fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:text,history})});
    const result = await response.json(); waiting.remove();
    if (!response.ok) throw new Error(result.detail || 'Something went wrong.');
    addMessage('assistant', result.answer, result.sources);
    history.push({role:'user',content:text},{role:'assistant',content:result.answer}); history = history.slice(-8);
  } catch (error) { waiting.remove(); addMessage('assistant', error.message); }
  finally { busy = false; $('sendButton').disabled = !questionInput.value.trim(); questionInput.focus(); }
}
$('uploadCard').addEventListener('click', () => fileInput.click());
$('attachButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => upload(fileInput.files[0]));
$('refreshDocs').addEventListener('click', refreshDocuments);
$('sendButton').addEventListener('click', () => sendQuestion());
questionInput.addEventListener('input', () => { questionInput.style.height = 'auto'; questionInput.style.height = `${Math.min(questionInput.scrollHeight,130)}px`; $('sendButton').disabled = !questionInput.value.trim() || busy; });
questionInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); } });
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => sendQuestion(button.dataset.question)));
$('newChat').addEventListener('click', () => { history = []; messages.replaceChildren(); $('welcome').hidden = false; questionInput.focus(); document.querySelector('.sidebar').classList.remove('open'); });
$('mobileMenu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
$('aboutButton').addEventListener('click', () => toast('Papertrail keeps uploaded PDFs in memory and uses your local Ollama model to answer.'));
const drop = $('dropTarget'), card = $('uploadCard');
for (const target of [drop, card]) {
  target.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
  target.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  target.addEventListener('drop', e => { e.preventDefault(); card.classList.remove('drag-over'); upload(e.dataTransfer.files[0]); });
}
checkHealth(); refreshDocuments(); setInterval(checkHealth, 15000);

