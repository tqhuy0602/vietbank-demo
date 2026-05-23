const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STORE ───
const users = {
    'huy@gmail.com':   { name: 'TRAN QUOC HUY',   balance: 50000000, stk: '1234 5678 901', txs: [] },
    'alice@gmail.com': { name: 'NGUYEN THI ALICE', balance: 30000000, stk: '9876 5432 100', txs: [] },
    'bob@gmail.com':   { name: 'LE VAN BOB',       balance: 20000000, stk: '5555 6666 777', txs: [] },
};

// { adminEmail: [{ email, name, threshold }] }
const monitorRules = {};

// { txId: { id, from, to, amount, note, adminEmail, threshold, status, timer, expiresAt } }
const pendingTxs = {};

// email → socket.id
const online = {};

let txSeq = 0;

// ─── HELPERS ───
function dateStr() {
    const n = new Date();
    return `${String(n.getDate()).padStart(2,'0')}/${String(n.getMonth()+1).padStart(2,'0')}/${n.getFullYear()}`;
}
function txId() { return 'TX' + String(++txSeq).padStart(5,'0') + '_' + Date.now(); }

function execTransfer(from, to, amount, note) {
    const d = dateStr();
    users[from].balance -= amount;
    users[to].balance   += amount;
    users[from].txs.unshift({ type:'db', who: users[to].name,   amt: amount, date: d, note });
    users[to].txs.unshift  ({ type:'cr', who: users[from].name, amt: amount, date: d, note });
}

function notifySocket(email, event, data) {
    const sid = online[email];
    if (sid) io.to(sid).emit(event, data);
}

// ─── SOCKET ───
io.on('connection', socket => {
    socket.on('register', email => {
        online[email] = socket.id;
        socket.email  = email;

        // Send any pending txs that need this admin's approval
        const pending = Object.values(pendingTxs).filter(t => t.adminEmail === email && t.status === 'pending');
        pending.forEach(t => {
            socket.emit('pending_transaction', {
                txId:      t.id,
                from:      t.from,
                fromName:  users[t.from]?.name || t.from,
                to:        t.to,
                toName:    users[t.to]?.name || t.to,
                amount:    t.amount,
                note:      t.note,
                threshold: t.threshold,
                timeLeft:  Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)),
            });
        });
    });

    socket.on('disconnect', () => {
        if (socket.email) delete online[socket.email];
    });
});

// ─── API ───

// Login — no password, create account if new
app.post('/api/login', (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email không hợp lệ' });

    if (!users[email]) {
        users[email] = {
            name:    email.split('@')[0].toUpperCase().replace(/[._]/g,' '),
            balance: 10000000,
            stk:     String(Math.floor(Math.random()*9e9 + 1e9)),
            txs:     []
        };
    }
    const u = users[email];
    res.json({ email, name: u.name, balance: u.balance, stk: u.stk });
});

// Get user info
app.get('/api/user/:email', (req, res) => {
    const u = users[req.params.email];
    if (!u) return res.status(404).json({ error: 'Không tìm thấy' });
    const { email } = req.params;
    res.json({ email, ...u });
});

// Transfer
app.post('/api/transfer', (req, res) => {
    const { from, to, amount, note } = req.body;
    const amt = parseInt(amount);

    if (!users[from])          return res.status(404).json({ error: 'Người gửi không tồn tại' });
    if (!users[to])            return res.status(404).json({ error: 'Người nhận không tồn tại' });
    if (from === to)           return res.status(400).json({ error: 'Không thể tự chuyển cho mình' });
    if (!amt || amt < 1000)    return res.status(400).json({ error: 'Số tiền tối thiểu 1.000 ₫' });
    if (users[from].balance < amt) return res.status(400).json({ error: 'Số dư không đủ' });

    // Check if sender is being monitored by any admin
    for (const [adminEmail, rules] of Object.entries(monitorRules)) {
        const rule = rules.find(r => r.email === from);
        if (rule && amt > rule.threshold) {
            const id  = txId();
            const exp = Date.now() + 600_000; // 10 phút

            const tx = {
                id, from, to, amount: amt,
                note: note || 'Chuyển tiền',
                adminEmail, threshold: rule.threshold,
                status: 'pending', expiresAt: exp,
            };

            tx.timer = setTimeout(() => {
                if (pendingTxs[id]?.status === 'pending') {
                    pendingTxs[id].status = 'expired';
                    delete pendingTxs[id];
                    notifySocket(adminEmail, 'transaction_expired', { txId: id, from, amount: amt });
                    notifySocket(from,       'transaction_expired', { txId: id, amount: amt });
                }
            }, 600_000);

            pendingTxs[id] = tx;

            notifySocket(adminEmail, 'pending_transaction', {
                txId: id,
                from,      fromName:  users[from].name,
                to,        toName:    users[to].name,
                amount:    amt,
                note:      tx.note,
                threshold: rule.threshold,
                timeLeft:  600,
            });

            return res.json({ status: 'pending', txId: id });
        }
    }

    // No monitoring → execute immediately
    execTransfer(from, to, amt, note || 'Chuyển tiền');
    notifySocket(from, 'transfer_done',     { amount: amt, toName: users[to].name,   balance: users[from].balance });
    notifySocket(to,   'transfer_received', { amount: amt, fromName: users[from].name, balance: users[to].balance });

    res.json({ status: 'success' });
});

// Approve
app.post('/api/approve/:id', (req, res) => {
    const tx = pendingTxs[req.params.id];
    if (!tx) return res.status(404).json({ error: 'Giao dịch không tồn tại hoặc đã hết hạn' });
    if (tx.adminEmail !== req.body.adminEmail) return res.status(403).json({ error: 'Không có quyền' });

    clearTimeout(tx.timer);
    delete pendingTxs[req.params.id];

    execTransfer(tx.from, tx.to, tx.amount, tx.note);

    notifySocket(tx.from, 'transfer_done', {
        amount: tx.amount, toName: users[tx.to].name, balance: users[tx.from].balance
    });

    res.json({ status: 'approved' });
});

// Reject
app.post('/api/reject/:id', (req, res) => {
    const tx = pendingTxs[req.params.id];
    if (!tx) return res.status(404).json({ error: 'Giao dịch không tồn tại hoặc đã hết hạn' });
    if (tx.adminEmail !== req.body.adminEmail) return res.status(403).json({ error: 'Không có quyền' });

    clearTimeout(tx.timer);
    delete pendingTxs[req.params.id];

    notifySocket(tx.from, 'transfer_rejected', { amount: tx.amount });

    res.json({ status: 'rejected' });
});

// Get monitor list
app.get('/api/monitor/:adminEmail', (req, res) => {
    res.json(monitorRules[req.params.adminEmail] || []);
});

// Add monitor
app.post('/api/monitor', (req, res) => {
    const { adminEmail, watchEmail, threshold } = req.body;
    if (!monitorRules[adminEmail]) monitorRules[adminEmail] = [];
    if (monitorRules[adminEmail].find(r => r.email === watchEmail))
        return res.status(400).json({ error: 'Email này đã được giám sát' });

    const name = users[watchEmail]?.name || watchEmail;
    monitorRules[adminEmail].push({ email: watchEmail, name, threshold: parseInt(threshold) });
    res.json({ status: 'ok' });
});

// Remove monitor
app.delete('/api/monitor/:adminEmail/:watchEmail', (req, res) => {
    const { adminEmail, watchEmail } = req.params;
    if (monitorRules[adminEmail])
        monitorRules[adminEmail] = monitorRules[adminEmail].filter(r => r.email !== watchEmail);
    res.json({ status: 'ok' });
});

// ─── START ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VietBank chạy tại http://localhost:${PORT}`));
