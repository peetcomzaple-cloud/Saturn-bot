import RFB from '/novnc/core/rfb.js';

const byId = id => document.getElementById(id);
let rfb = null;
let viewMode = null;
let wantedScreen = true;
const rendered = new Set();
let lastApprovals = '';

async function request(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Computer-Request': '1' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const text = await response.text();
    let error = text;
    try { error = JSON.parse(text).error || text; } catch {}
    throw new Error(error);
  }
  return response.json();
}

function showError(error) { byId('error').textContent = error.message; }
async function action(path, data) {
  byId('error').textContent = '';
  try { await request(path, data); await refresh(); } catch (error) { showError(error); }
}

function connect(mode) {
  if (rfb && viewMode === mode) return;
  if (rfb) rfb.disconnect();
  byId('screen').replaceChildren();
  viewMode = mode;
  const connection = new RFB(byId('screen'), `ws://${location.host}/ws/${mode}`);
  rfb = connection;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.viewOnly = mode === 'view';
  rfb.addEventListener('securityfailure', event => showError(new Error(event.detail.reason || 'Screen connection rejected')));
  rfb.addEventListener('disconnect', () => { if (rfb === connection) { rfb = null; viewMode = null; } });
}

async function refresh() {
  const state = await request('/api/state');
  byId('dot').className = state.busy ? 'busy' : state.stopped ? 'stopped' : '';
  byId('status-text').textContent = state.stopped ? 'หยุดแล้ว' : state.busy ? 'บอตกำลังทำงาน' : state.mode === 'human' ? 'คุณควบคุม' : 'พร้อม';
  for (const message of state.messages) {
    if (rendered.has(message.id)) continue;
    rendered.add(message.id);
    const item = document.createElement('article');
    item.className = `message ${message.role}`;
    item.textContent = message.text;
    if (message.image) {
      const image = document.createElement('img');
      image.src = `/screen/${message.image}`;
      image.alt = 'ภาพจอล่าสุด';
      item.append(image);
    }
    byId('messages').append(item);
    byId('messages').scrollTop = byId('messages').scrollHeight;
  }
  const approvalKey = JSON.stringify(state.approvals);
  if (approvalKey !== lastApprovals) {
    lastApprovals = approvalKey;
    byId('approvals').replaceChildren();
    for (const approval of state.approvals) {
      const card = document.createElement('article'); card.className = 'approval';
      const title = document.createElement('strong'); title.textContent = 'ขออนุมัติ';
      const details = document.createElement('pre'); details.textContent = JSON.stringify(approval.action, null, 2);
      card.append(title, details);
      for (const [label, allow] of [['Approve', true], ['Deny', false]]) {
        const button = document.createElement('button'); button.textContent = label;
        button.onclick = () => action('/api/approve', { id: approval.id, allow });
        card.append(button);
      }
      byId('approvals').append(card);
    }
  }
  if (state.stopped) {
    if (rfb) rfb.disconnect();
  } else if (wantedScreen) connect(state.mode === 'human' ? 'control' : 'view');
}

byId('chat-form').onsubmit = event => {
  event.preventDefault();
  const text = byId('command').value;
  if (!text.trim()) return;
  byId('command').value = '';
  action('/api/chat', { text });
};
byId('view').onclick = () => { wantedScreen = true; refresh().catch(showError); };
byId('take-control').onclick = () => action('/api/control', { mode: 'human' });
byId('return-control').onclick = () => { wantedScreen = true; action('/api/control', { mode: 'bot' }); };
byId('stop').onclick = () => {
  wantedScreen = false;
  if (rfb) rfb.disconnect();
  action('/api/control', { mode: 'stop' });
};
async function poll() {
  try { await refresh(); } catch (error) { showError(error); }
  setTimeout(poll, 1000);
}
poll();
